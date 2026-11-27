#!/bin/bash
# Refresh mcp.vin's local copies of NHTSA data (lib/nhtsa-local.mjs) on the web server. NOT installed by default:
# see deploy/systemd/README.md for the timers and docs/nhtsa-local-data.md for the data.
#
#   scripts/nhtsa-refresh.sh flat      daily: recall + complaint flat files -> data/nhtsa-recalls.db,
#                                      data/recall-labels.db, data/nhtsa-complaints.db (only when NHTSA changed a file);
#                                      plus the recall campaign crawl (API-only values of new, amended and recent
#                                      campaigns and a few hundred others, at most NHTSA_CAMPAIGN_MAX per run)
#   scripts/nhtsa-refresh.sh ratings   weekly: crawl the 5-Star Safety Ratings API for recent model years (every
#                                      model year when the last full crawl is over 90 days old) -> data/nhtsa-ratings.db
#   add --force to rebuild from the files on hand even when NHTSA's files did not change
#
# Environment: NHTSA_WORK (downloads, crawl state, status; default /var/lib/vin-mcp-nhtsa), NHTSA_DATA (where the
# .db files go; default <repo>/data), NHTSA_MIN_FREE_GB (default 8: the complaint build stages about 4 GB), NHTSA_RATINGS_PAUSE (seconds between API
# requests, default 1.0; also used by the campaign crawl), NHTSA_FULL_CRAWL_DAYS (default 90), NHTSA_CAMPAIGN_MAX
# (campaigns fetched per daily run, default 2500: about an hour), NHTSA_CAMPAIGN_ROLLING (older campaigns re-checked per
# run, default 200). A first run with no crawl state fills it over about two weeks; copying a crawl state file from
# another machine into $NHTSA_WORK/recall-campaigns.db skips that.
#
# Every build writes a new file and renames it over the old one (the server reopens a changed file within a minute)
# and refuses a result with over 1% fewer campaigns, complaints or rated vehicles than the file it replaces, so a
# broken download never replaces good data. When a refresh keeps failing, the server's answers go stale; after 7 days
# (recalls, complaints) or 45 days (ratings) it asks NHTSA's live API first again (lib/nhtsa-local.mjs STALE_DAYS).
# Exit codes: 0 done (or nothing changed), 1 failed (see the log), 2 another run of the same mode holds the lock.
set -u
MODE=${1:?usage: nhtsa-refresh.sh flat|ratings [--force]}
FORCE=${2:-}
REPO=$(cd "$(dirname "$0")/.." && pwd)
WORK=${NHTSA_WORK:-/var/lib/vin-mcp-nhtsa}
DATA=${NHTSA_DATA:-$REPO/data}
MIN_FREE_GB=${NHTSA_MIN_FREE_GB:-8}
UA='nhtsa-data-sync/1.0'
mkdir -p "$WORK/dl" "$DATA" || exit 1
exec 9> "$WORK/$MODE.lock"
flock -n 9 || { echo "another $MODE refresh is running"; exit 2; }

log() { echo "$(date -u +%FT%TZ) [$MODE] $*" >&2; }
fail() { log "FAILED: $*"; status "$MODE" failed "$*"; exit 1; }
status() { # dataset outcome detail -> $WORK/status.json (one entry per dataset; read by people, not by the server)
  python3 - "$WORK/status.json" "$@" <<'EOF'
import json, sys, datetime, os
path, name, outcome, detail = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else ''
try:
    s = json.load(open(path))
except Exception:
    s = {}
s[name] = {'at': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'outcome': outcome, 'detail': detail}
tmp = path + '.tmp'
json.dump(s, open(tmp, 'w'), indent=1)
os.replace(tmp, path)
EOF
}
free_gb() { df -P -BG "$1" | awk 'NR==2 {gsub("G","",$4); print $4}'; }
check_space() {
  for d in "$WORK" "$DATA"; do
    [ "$(free_gb "$d")" -ge "$MIN_FREE_GB" ] || fail "less than ${MIN_FREE_GB} GB free on $d"
  done
}

# fetch NAME URL MAXBYTES -> prints "changed" or "same"; the file lands in $WORK/dl/NAME only when it is complete,
# matches its ETag (an MD5 for these files) and, for a zip, tests clean.
fetch() {
  local name=$1 url=$2 max=$3 dir=$WORK/dl part code etag md5
  part=$dir/$name.part
  rm -f "$part"
  local cond=()
  [ -s "$dir/$name" ] && [ -s "$dir/$name.etag" ] && cond=(--etag-compare "$dir/$name.etag")
  code=$(curl -sS -A "$UA" --retry 4 --retry-delay 30 --max-time 3600 --max-filesize "$max" "${cond[@]}" \
    --etag-save "$dir/$name.etag.new" -D "$dir/$name.headers" -o "$part" -w '%{http_code}' "$url") || { rm -f "$part"; fail "download $name"; }
  if [ "$code" = 304 ]; then rm -f "$part" "$dir/$name.etag.new"; echo same; return; fi
  [ "$code" = 200 ] || { rm -f "$part"; fail "download $name: HTTP $code"; }
  etag=$(tr -d '"\r\n' < "$dir/$name.etag.new")
  md5=$(md5sum "$part" | cut -d' ' -f1)
  case "$etag" in *-*|'') ;; *) [ "$etag" = "$md5" ] || { rm -f "$part"; fail "$name: MD5 $md5 is not the ETag $etag"; } ;; esac
  case "$name" in *.zip) unzip -tq "$part" > /dev/null || { rm -f "$part"; fail "$name: zip test failed"; } ;; esac
  mv "$part" "$dir/$name"
  mv "$dir/$name.etag.new" "$dir/$name.etag"
  grep -i '^last-modified:' "$dir/$name.headers" | cut -d' ' -f2- | tr -d '\r' > "$dir/$name.last-modified"
  echo changed
}

refresh_flat() {
  check_space
  local pre post cmpl lm rc
  pre=$(fetch FLAT_RCL_PRE_2010.zip https://static.nhtsa.gov/odi/ffdd/rcl/FLAT_RCL_PRE_2010.zip 200000000) || exit 1
  post=$(fetch FLAT_RCL_POST_2010.zip https://static.nhtsa.gov/odi/ffdd/rcl/FLAT_RCL_POST_2010.zip 400000000) || exit 1
  log "recall files: pre $pre, post $post"
  # Values only the API has (over-the-air flag, the API's component and date per campaign): a capped, gentle crawl.
  # A failed or partial crawl is not fatal: the build uses the answers on hand and the next run continues.
  local sheets=0
  python3 "$REPO/scripts/harvest-nhtsa-recall-campaigns.py" --state "$WORK/recall-campaigns.db" \
    --pre "$WORK/dl/FLAT_RCL_PRE_2010.zip" --post "$WORK/dl/FLAT_RCL_POST_2010.zip" --pause "${NHTSA_RATINGS_PAUSE:-1.0}" \
    --max-requests "${NHTSA_CAMPAIGN_MAX:-2500}" --rolling "${NHTSA_CAMPAIGN_ROLLING:-200}" \
    --summary "$WORK/recall-campaigns-summary.json" --stop-file "$WORK/STOP-campaigns" > "$WORK/recall-campaigns.log" 2>&1
  rc=$?
  if [ $rc -eq 0 ] || [ $rc -eq 3 ]; then
    sheets=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["values_changed"])' "$WORK/recall-campaigns-summary.json" 2>/dev/null || echo 0)
    log "campaign crawl exit $rc: $sheets campaigns with new values"
  else
    log "campaign crawl failed (exit $rc, see $WORK/recall-campaigns.log); building with the answers on hand"
  fi
  if [ "$pre" = changed ] || [ "$post" = changed ] || [ "$sheets" != 0 ] || [ "$FORCE" = --force ] || [ ! -s "$DATA/nhtsa-recalls.db" ]; then
    lm=$(cat "$WORK/dl/FLAT_RCL_POST_2010.zip.last-modified" 2>/dev/null)
    local sheet_args=()
    [ -s "$WORK/recall-campaigns.db" ] && sheet_args=(--campaign-sheets "$WORK/recall-campaigns.db")
    python3 "$REPO/scripts/import-nhtsa-recalls.py" --pre "$WORK/dl/FLAT_RCL_PRE_2010.zip" --post "$WORK/dl/FLAT_RCL_POST_2010.zip" \
      --out "$DATA/nhtsa-recalls.db" "${sheet_args[@]}" ${lm:+--last-modified "$lm"} > "$WORK/recalls-build.json" || fail "recalls build (see journal)"
    python3 "$REPO/scripts/import-recall-labels.py" --pre "$WORK/dl/FLAT_RCL_PRE_2010.zip" --post "$WORK/dl/FLAT_RCL_POST_2010.zip" \
      --out "$DATA/recall-labels.db" > "$WORK/recall-labels-build.json" || fail "recall labels build (see journal)"
    log "recalls built: $(python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); print(m["counts"]["campaigns"], "campaigns, latest report", m["latest_report_date"])' "$WORK/recalls-build.json")"
    status recalls built "$(cat "$WORK/dl/FLAT_RCL_POST_2010.zip.last-modified" 2>/dev/null)"
  else
    status recalls unchanged
  fi
  check_space
  cmpl=$(fetch FLAT_CMPL.zip https://static.nhtsa.gov/odi/ffdd/cmpl/FLAT_CMPL.zip 2000000000) || exit 1
  log "complaint file: $cmpl"
  if [ "$cmpl" = changed ] || [ "$FORCE" = --force ] || [ ! -s "$DATA/nhtsa-complaints.db" ]; then
    lm=$(cat "$WORK/dl/FLAT_CMPL.zip.last-modified" 2>/dev/null)
    python3 "$REPO/scripts/import-nhtsa-complaints.py" --zip "$WORK/dl/FLAT_CMPL.zip" --out "$DATA/nhtsa-complaints.db" \
      ${lm:+--last-modified "$lm"} > "$WORK/complaints-build.json" || fail "complaints build (see journal)"
    log "complaints built: $(python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); print(m["counts"]["complaints"], "complaints, latest received", m["latest_received_date"])' "$WORK/complaints-build.json")"
    status complaints built "$(cat "$WORK/dl/FLAT_CMPL.zip.last-modified" 2>/dev/null)"
  else
    status complaints unchanged
  fi
  status flat done
}

refresh_ratings() {
  check_space
  local state=$WORK/ratings-crawl.db years=recent refresh=recent last_full now rc
  now=$(date +%s)
  last_full=$(cat "$WORK/ratings-last-full-crawl" 2>/dev/null || echo 0)
  if [ ! -s "$state" ] || [ $(( (now - last_full) / 86400 )) -ge "${NHTSA_FULL_CRAWL_DAYS:-90}" ]; then years=all; refresh=all; fi
  [ -s "$state" ] || refresh=none
  log "ratings crawl: years $years, refresh $refresh"
  python3 "$REPO/scripts/harvest-nhtsa-ratings.py" --state "$state" --years "$years" --refresh-years "$refresh" \
    --pause "${NHTSA_RATINGS_PAUSE:-1.0}" --summary "$WORK/ratings-crawl-summary.json" --stop-file "$WORK/STOP-ratings"
  rc=$?
  [ $rc -eq 0 ] || [ $rc -eq 3 ] || fail "ratings crawl exit $rc"
  [ $rc -eq 0 ] && [ "$years" = all ] && echo "$now" > "$WORK/ratings-last-full-crawl"
  # An incomplete crawl still builds: whatever was not crawled cleanly is left to the live API.
  python3 "$REPO/scripts/import-nhtsa-ratings.py" --state "$state" --out "$DATA/nhtsa-ratings.db" > "$WORK/ratings-build.json" || fail "ratings build (see journal)"
  log "ratings built: $(python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); c=m["counts"]; print(c["rated_variants"], "rated variants,", c["gaps"], "gaps")' "$WORK/ratings-build.json")"
  status ratings built "crawl exit $rc, years $years"
}

case "$MODE" in
  flat) refresh_flat ;;
  ratings) refresh_ratings ;;
  *) echo "unknown mode $MODE (flat|ratings)"; exit 1 ;;
esac
log done
