#!/bin/bash
# Build mcp.vin's NHTSA-derived data files on the BUILD server (storage 104.37.188.237) and publish them for the web
# server to pull (scripts/nhtsa-install.py). Nothing here writes to the web server. Timers: deploy/systemd/README.md;
# the whole chain: docs/nhtsa-local-data.md, "Refresh".
#
#   nhtsa-build.sh odi [--force]       daily: NHTSA's ODI flat files -> nhtsa-recalls.db (with the recall campaign
#                                      crawl), recall-labels.db, nhtsa-complaints.db, investigations.db, communications.db
#   nhtsa-build.sh ratings [--force]   weekly: crawl the 5-Star Safety Ratings API for the current and next model
#                                      years -> nhtsa-ratings.db
#   nhtsa-build.sh vpic [--force]      daily: look for a new monthly vPIC release; build and parity-check it with
#                                      scripts/vpic-refresh.sh -> vpic.db
#
# A download happens only when NHTSA's file changed: a HEAD request first (the ETag is the file's MD5; a file NHTSA
# re-stamps with the same content is not fetched again), then a GET with If-Modified-Since. A dataset is rebuilt only
# when one of its files changed (or --force, or nothing is published yet). Every build goes through the gate
# (scripts/nhtsa_datasets.py: schema, row counts not down more than 3% from the published copy, known answers through
# the site's own lookup code) before it is published. A failed download, build or gate keeps the published copy and
# is written to publish/builder-status.json; the web server copies that file and its check mails the owner.
#
# Environment: NHTSA_WORK (default /srv/nhtsa-build: dl/ downloads, state/ crawl state, build/ fresh builds, publish/
# what the web server pulls through a read-only rsync key, logs/), NHTSA_MIN_FREE_GB (default 12: the complaint build
# stages ~4 GB, communications ~4.5 GB), NHTSA_PAUSE (seconds between API requests, default 1.0), NHTSA_CAMPAIGN_MAX
# (recall campaigns fetched per daily run, default 2500 = about an hour; 0 = off), NHTSA_CAMPAIGN_ROLLING (older
# campaigns re-checked per run, default 200), NHTSA_RATINGS_YEARS (default current = this calendar year and later),
# NHTSA_FULL_CRAWL_DAYS (re-crawl every model year when the last full crawl is this many days old; default 0 = never),
# NHTSA_TSB_PERIODS (override the TSB archive list, e.g. when NHTSA renames the newest archive), NHTSA_LOCK_WAIT.
# Exit codes: 0 ok, 1 something failed (recorded for the check), 2 another run of this mode holds the lock.
set -u
MODE=${1:?usage: nhtsa-build.sh odi|ratings|vpic [--force]}
FORCE=${2:-}
REPO=$(cd "$(dirname "$0")/.." && pwd)
WORK=${NHTSA_WORK:-/srv/nhtsa-build}
DL=$WORK/dl ST=$WORK/state BUILD=$WORK/build PUB=$WORK/publish LOGS=$WORK/logs
MIN_FREE_GB=${NHTSA_MIN_FREE_GB:-12}
PAUSE=${NHTSA_PAUSE:-1.0}
UA='nhtsa-data-sync/1.0'
ODI=https://static.nhtsa.gov/odi/ffdd
PY=(python3 "$REPO/scripts/nhtsa_datasets.py")
mkdir -p "$DL" "$ST" "$BUILD" "$PUB" "$LOGS" || exit 1
chmod 755 "$PUB"
exec 9> "$WORK/$MODE.lock"
flock -n 9 || { echo "another $MODE build is running"; exit 2; }
# One build at a time on this box (1 CPU, 3 GB): a mode waits up to NHTSA_LOCK_WAIT seconds (default 6 h) for another.
exec 8> "$WORK/build.lock"
if ! flock -w "${NHTSA_LOCK_WAIT:-21600}" 8; then
  for d in $(python3 -c 'import sys; sys.path.insert(0, sys.argv[1]); import nhtsa_datasets as n; print(" ".join(k for k, v in n.DATASETS.items() if v["mode"] == sys.argv[2]))' "$REPO/scripts" "$MODE"); do
    "${PY[@]}" note "$d" failed --publish "$PUB" --message "another build held $WORK/build.lock for ${NHTSA_LOCK_WAIT:-21600} s" > /dev/null
  done
  echo "gave up waiting for $WORK/build.lock"; exit 1
fi
RC=0

log() { echo "$(date -u +%FT%TZ) [$MODE] $*" >&2; }
note() { # DATASET RESULT [MESSAGE] [--confirmed]
  local ds=$1 result=$2 msg=${3:-} extra=()
  [ "${4:-}" = --confirmed ] && extra=(--confirmed)
  "${PY[@]}" note "$ds" "$result" --publish "$PUB" --dl "$DL" --message "$msg" "${extra[@]}" > /dev/null || log "could not record $ds $result"
  case "$result" in failed|gate_failed|needs_review) RC=1; log "$ds: $result: $msg" ;; *) log "$ds: $result${msg:+: $msg}" ;; esac
}
published() { [ -s "$PUB/$1.json" ]; }
lm_of() { cat "$DL/$1.last-modified" 2>/dev/null; }
free_gb() { df -P -BG "$1" | awk 'NR==2 {gsub("G","",$4); print $4}'; }
space_ok() { [ "$(free_gb "$WORK")" -ge "$MIN_FREE_GB" ]; }
publish() { # DATASET FILE [extra publish args]: gate + publish; the gate's own note records a failure
  local ds=$1 file=$2; shift 2
  if "${PY[@]}" publish "$ds" "$file" --publish "$PUB" --dl "$DL" "$@" > "$LOGS/$ds-publish.json" 2>> "$LOGS/$ds-build.err"; then
    log "$ds: published $(python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); print(m.get("file"), json.dumps(m.get("rows")))' "$LOGS/$ds-publish.json" 2>/dev/null)"
  else
    RC=1; log "$ds: gate failed or publish error, see $LOGS/$ds-publish.json"
  fi
}
build_failed() { # DATASET STEP: record the failing step with the end of its error log
  note "$1" failed "$2 failed: $(tail -c 600 "$LOGS/$1-build.err" 2>/dev/null | tr '\n' ' ')"
}

# fetch NAME URL MAXBYTES -> prints changed | same | failed. The file lands in $DL/NAME only when it is complete,
# matches its ETag (an MD5 on static.nhtsa.gov) and, for a zip, tests clean. static.nhtsa.gov ignores If-None-Match
# (checked 2026-11-27), so the ETag is compared after a HEAD, and the GET is conditional on the stored Last-Modified.
fetch() {
  local name=$1 url=$2 max=$3 head code etag lm part md5 cond=()
  head=$(curl -sSI -A "$UA" --retry 3 --retry-delay 20 --max-time 60 "$url" 2>> "$LOGS/fetch.err" | tr -d '\r')
  code=$(printf '%s\n' "$head" | awk 'NR==1 {print $2}')
  if [ "$code" = 404 ]; then log "$name: HTTP 404 at $url"; echo failed; return; fi
  etag=$(printf '%s\n' "$head" | grep -i '^etag:' | tail -1 | cut -d' ' -f2- | tr -d '"')
  lm=$(printf '%s\n' "$head" | grep -i '^last-modified:' | tail -1 | cut -d' ' -f2-)
  [ -n "$lm" ] && echo "$lm" > "$DL/$name.seen"
  if [ -s "$DL/$name" ] && [ -n "$etag" ] && [ "$etag" = "$(cat "$DL/$name.md5" 2>/dev/null)" ] && [ "$FORCE" != --force ]; then
    echo same; return
  fi
  part=$DL/$name.part
  rm -f "$part"
  [ -s "$DL/$name" ] && [ -s "$DL/$name.last-modified" ] && cond=(-z "$(cat "$DL/$name.last-modified")")
  code=$(curl -sS -A "$UA" --retry 4 --retry-delay 30 --max-time 3600 --max-filesize "$max" "${cond[@]}" \
    -D "$DL/$name.headers.new" -o "$part" -w '%{http_code}' "$url" 2>> "$LOGS/fetch.err") || { rm -f "$part"; log "$name: download failed"; echo failed; return; }
  if [ "$code" = 304 ]; then rm -f "$part" "$DL/$name.headers.new"; echo same; return; fi
  [ "$code" = 200 ] || { rm -f "$part"; log "$name: HTTP $code"; echo failed; return; }
  etag=$(grep -i '^etag:' "$DL/$name.headers.new" | tail -1 | cut -d' ' -f2- | tr -d '"\r\n')
  md5=$(md5sum "$part" | cut -d' ' -f1)
  case "$etag" in *-*|'') ;; *) [ "$etag" = "$md5" ] || { rm -f "$part"; log "$name: MD5 $md5 is not the ETag $etag"; echo failed; return; } ;; esac
  case "$name" in *.zip) unzip -tq "$part" > /dev/null 2>&1 || { rm -f "$part"; log "$name: zip test failed"; echo failed; return; } ;; esac
  mv "$part" "$DL/$name"
  mv "$DL/$name.headers.new" "$DL/$name.headers"
  echo "$md5" > "$DL/$name.md5"
  grep -i '^last-modified:' "$DL/$name.headers" | tail -1 | cut -d' ' -f2- | tr -d '\r' > "$DL/$name.last-modified"
  cp "$DL/$name.last-modified" "$DL/$name.seen"
  echo changed
}

odi_recalls() {
  local pre post rc sheets=0 lm
  pre=$(fetch FLAT_RCL_PRE_2010.zip $ODI/rcl/FLAT_RCL_PRE_2010.zip 200000000)
  post=$(fetch FLAT_RCL_POST_2010.zip $ODI/rcl/FLAT_RCL_POST_2010.zip 400000000)
  log "recall files: pre $pre, post $post"
  if [ "$pre" = failed ] || [ "$post" = failed ]; then
    note nhtsa-recalls failed "download of FLAT_RCL failed (pre $pre, post $post)"; note recall-labels failed "download of FLAT_RCL failed"; return
  fi
  # Values only the API has (over-the-air flag, the API's component and date per campaign): a capped, gentle crawl.
  # A failed or partial crawl is not fatal: the build uses the answers on hand and the next run continues.
  if [ "${NHTSA_CAMPAIGN_MAX:-2500}" != 0 ]; then
    python3 "$REPO/scripts/harvest-nhtsa-recall-campaigns.py" --state "$ST/recall-campaigns.db" \
      --pre "$DL/FLAT_RCL_PRE_2010.zip" --post "$DL/FLAT_RCL_POST_2010.zip" --pause "$PAUSE" \
      --max-requests "${NHTSA_CAMPAIGN_MAX:-2500}" --rolling "${NHTSA_CAMPAIGN_ROLLING:-200}" \
      --summary "$LOGS/recall-campaigns-summary.json" --stop-file "$WORK/STOP-campaigns" > "$LOGS/recall-campaigns.log" 2>&1
    rc=$?
    if [ $rc -eq 0 ] || [ $rc -eq 3 ]; then
      sheets=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["values_changed"])' "$LOGS/recall-campaigns-summary.json" 2>/dev/null || echo 0)
      log "campaign crawl exit $rc: $sheets campaigns with new values"
    else
      log "campaign crawl failed (exit $rc, $LOGS/recall-campaigns.log); building with the answers on hand"
    fi
  fi
  lm=$(lm_of FLAT_RCL_POST_2010.zip)
  if [ "$pre" = changed ] || [ "$post" = changed ] || [ "$sheets" != 0 ] || [ "$FORCE" = --force ] || ! published nhtsa-recalls; then
    local sheet_args=()
    [ -s "$ST/recall-campaigns.db" ] && sheet_args=(--campaign-sheets "$ST/recall-campaigns.db")
    if python3 "$REPO/scripts/import-nhtsa-recalls.py" --pre "$DL/FLAT_RCL_PRE_2010.zip" --post "$DL/FLAT_RCL_POST_2010.zip" \
        --out "$BUILD/nhtsa-recalls.db" "${sheet_args[@]}" ${lm:+--last-modified "$lm"} > "$LOGS/nhtsa-recalls-build.json" 2> "$LOGS/nhtsa-recalls-build.err"; then
      publish nhtsa-recalls "$BUILD/nhtsa-recalls.db"
    else build_failed nhtsa-recalls "recalls build"; fi
  else
    note nhtsa-recalls unchanged "NHTSA's files unchanged" --confirmed
  fi
  if [ "$pre" = changed ] || [ "$post" = changed ] || [ "$FORCE" = --force ] || ! published recall-labels; then
    if python3 "$REPO/scripts/import-recall-labels.py" --pre "$DL/FLAT_RCL_PRE_2010.zip" --post "$DL/FLAT_RCL_POST_2010.zip" \
        --out "$BUILD/recall-labels.db" > "$LOGS/recall-labels-build.json" 2> "$LOGS/recall-labels-build.err"; then
      publish recall-labels "$BUILD/recall-labels.db"
    else build_failed recall-labels "recall labels build"; fi
  else
    note recall-labels unchanged "NHTSA's files unchanged" --confirmed
  fi
}

odi_complaints() {
  local f lm
  f=$(fetch FLAT_CMPL.zip $ODI/cmpl/FLAT_CMPL.zip 2000000000)
  log "complaint file: $f"
  [ "$f" = failed ] && { note nhtsa-complaints failed "download of FLAT_CMPL.zip failed"; return; }
  if [ "$f" = changed ] || [ "$FORCE" = --force ] || ! published nhtsa-complaints; then
    lm=$(lm_of FLAT_CMPL.zip)
    if python3 "$REPO/scripts/import-nhtsa-complaints.py" --zip "$DL/FLAT_CMPL.zip" --out "$BUILD/nhtsa-complaints.db" \
        ${lm:+--last-modified "$lm"} > "$LOGS/nhtsa-complaints-build.json" 2> "$LOGS/nhtsa-complaints-build.err"; then
      publish nhtsa-complaints "$BUILD/nhtsa-complaints.db"
    else build_failed nhtsa-complaints "complaints build"; fi
  else
    note nhtsa-complaints unchanged "NHTSA's file unchanged" --confirmed
  fi
}

odi_investigations() {
  local f lm
  f=$(fetch FLAT_INV.zip $ODI/inv/FLAT_INV.zip 30000000)
  log "investigation file: $f"
  [ "$f" = failed ] && { note investigations failed "download of FLAT_INV.zip failed"; return; }
  if [ "$f" = changed ] || [ "$FORCE" = --force ] || ! published investigations; then
    lm=$(lm_of FLAT_INV.zip)
    if python3 "$REPO/scripts/import-investigations.py" --zip "$DL/FLAT_INV.zip" --out "$BUILD/investigations.db" \
        ${lm:+--last-modified "$lm"} > "$LOGS/investigations-build.json" 2> "$LOGS/investigations-build.err"; then
      publish investigations "$BUILD/investigations.db"
    else build_failed investigations "investigations build"; fi
  else
    note investigations unchanged "NHTSA's file unchanged" --confirmed
  fi
}

# The TSB archives are fixed five-year periods plus the newest one, which NHTSA names by its current end year
# (TSBS_RECEIVED_2025-2026.zip in 2026). Look for this year's name first, then last year's.
tsb_periods() {
  if [ -n "${NHTSA_TSB_PERIODS:-}" ]; then echo "$NHTSA_TSB_PERIODS"; return; fi
  local y code
  y=$(date -u +%Y)
  for end in "$y" "$((y - 1))"; do
    code=$(curl -sS -o /dev/null -I -A "$UA" --max-time 60 -w '%{http_code}' "$ODI/tsbs/TSBS_RECEIVED_2025-$end.zip" 2>> "$LOGS/fetch.err")
    if [ "$code" = 200 ]; then echo "1995-1999,2000-2004,2005-2009,2010-2014,2015-2019,2020-2024,2025-$end"; return; fi
  done
}

odi_communications() {
  local periods p f changed=0 failed='' newest='' names=() lm
  periods=$(tsb_periods)
  if [ -z "$periods" ]; then
    note communications failed "no TSBS_RECEIVED_2025-YYYY.zip found for this or last year: NHTSA renamed the newest archive? Set NHTSA_TSB_PERIODS (see $ODI/tsbs/ on https://www.nhtsa.gov/nhtsa-datasets-and-apis)"; return
  fi
  for p in ${periods//,/ }; do
    f=$(fetch "TSBS_RECEIVED_$p.zip" "$ODI/tsbs/TSBS_RECEIVED_$p.zip" 400000000)
    names+=("TSBS_RECEIVED_$p.zip:$f")
    case "$f" in changed) changed=1 ;; failed) failed="$failed $p" ;; esac
  done
  log "TSB files: ${names[*]}"
  [ -n "$failed" ] && { note communications failed "download failed for TSB periods$failed"; return; }
  # only the archives in use count for the source date: drop a renamed archive's leftovers
  for f in "$DL"/TSBS_RECEIVED_*.zip; do
    p=${f##*TSBS_RECEIVED_}; p=${p%.zip}
    case ",$periods," in *",$p,"*) ;; *) log "removing old TSB archive $f"; rm -f "$f" "$f".* ;; esac
  done
  if [ $changed = 1 ] || [ "$FORCE" = --force ] || ! published communications; then
    lm=$(for p in ${periods//,/ }; do lm_of "TSBS_RECEIVED_$p.zip"; done | python3 -c 'import sys,email.utils as e; d=[e.parsedate_to_datetime(l) for l in sys.stdin.read().splitlines() if l.strip()]; print(e.format_datetime(max(d), usegmt=True) if d else "")')
    rm -f "$BUILD/communications-wide.db" "$BUILD/communications.db.new"
    if python3 "$REPO/scripts/import-communications.py" --cache-dir "$DL" --periods "$periods" --out "$BUILD/communications-wide.db" \
          ${lm:+--last-modified "$lm"} > "$LOGS/communications-build.json" 2> "$LOGS/communications-build.err" &&
       python3 "$REPO/scripts/compact-communications.py" "$BUILD/communications-wide.db" "$BUILD/communications.db.new" \
          >> "$LOGS/communications-build.json" 2>> "$LOGS/communications-build.err"; then
      rm -f "$BUILD/communications-wide.db"
      mv -f "$BUILD/communications.db.new" "$BUILD/communications.db"
      publish communications "$BUILD/communications.db"
    else
      rm -f "$BUILD/communications-wide.db" "$BUILD/communications.db.new"
      build_failed communications "communications build"
    fi
  else
    note communications unchanged "NHTSA's archives unchanged" --confirmed
  fi
}

run_odi() {
  space_ok || { for d in nhtsa-recalls recall-labels nhtsa-complaints investigations communications; do note $d failed "less than $MIN_FREE_GB GB free on $WORK"; done; return; }
  odi_recalls
  odi_investigations
  if space_ok; then odi_complaints; else note nhtsa-complaints failed "less than $MIN_FREE_GB GB free on $WORK"; fi
  if space_ok; then odi_communications; else note communications failed "less than $MIN_FREE_GB GB free on $WORK"; fi
}

run_ratings() {
  local state=$ST/ratings-crawl.db years=${NHTSA_RATINGS_YEARS:-current} refresh last_full now rc full=${NHTSA_FULL_CRAWL_DAYS:-0}
  space_ok || { note nhtsa-ratings failed "less than $MIN_FREE_GB GB free on $WORK"; return; }
  now=$(date +%s)
  last_full=$(cat "$ST/ratings-last-full-crawl" 2>/dev/null || echo 0)
  refresh=$years
  if [ ! -s "$state" ]; then years=all; refresh=none
  elif [ "$full" != 0 ] && [ $(( (now - last_full) / 86400 )) -ge "$full" ]; then years=all; refresh=all; fi
  log "ratings crawl: years $years, refresh $refresh"
  python3 "$REPO/scripts/harvest-nhtsa-ratings.py" --state "$state" --years "$years" --refresh-years "$refresh" \
    --pause "$PAUSE" --summary "$LOGS/ratings-crawl-summary.json" --stop-file "$WORK/STOP-ratings" > "$LOGS/ratings-crawl.log" 2>&1
  rc=$?
  if [ $rc -ne 0 ] && [ $rc -ne 3 ]; then note nhtsa-ratings failed "ratings crawl exit $rc ($LOGS/ratings-crawl.log)"; return; fi
  [ $rc -eq 0 ] && [ "$years" = all ] && echo "$now" > "$ST/ratings-last-full-crawl"
  # An incomplete crawl still builds (what was not crawled cleanly is left to the live API) but keeps its old date.
  if python3 "$REPO/scripts/import-nhtsa-ratings.py" --state "$state" --out "$BUILD/nhtsa-ratings.db" > "$LOGS/nhtsa-ratings-build.json" 2> "$LOGS/nhtsa-ratings-build.err"; then
    publish nhtsa-ratings "$BUILD/nhtsa-ratings.db"
  else build_failed nhtsa-ratings "ratings build"; return; fi
  [ $rc -eq 3 ] && note nhtsa-ratings failed "ratings crawl incomplete (exit 3, $LOGS/ratings-crawl.log): built from the answers on hand; the copy keeps the date of the last complete crawl"
}

# vPIC: NHTSA publishes vPICList_lite_YYYY_MM.plain.zip about mid-month. vpic-refresh.sh builds it with mcp.vin's
# rule fixes and compares 20,000 decodes with NHTSA's own spvindecode (needs PostgreSQL here; hours). A release
# whose parity is not exact, or whose rule fixes need review, is NOT published: it waits for a person.
run_vpic() {
  local rel cand code lm head pubrel dir
  for cand in "$(date -u +%Y_%m)" "$(date -u -d "$(date -u +%Y-%m-01) -1 day" +%Y_%m)"; do
    head=$(curl -sSI -A "$UA" --max-time 60 "https://vpic.nhtsa.dot.gov/downloads/vPICList_lite_$cand.plain.zip" 2>> "$LOGS/fetch.err" | tr -d '\r')
    code=$(printf '%s\n' "$head" | awk 'NR==1 {print $2}')
    if [ "$code" = 200 ]; then rel=$cand; lm=$(printf '%s\n' "$head" | grep -i '^last-modified:' | tail -1 | cut -d' ' -f2-); break; fi
  done
  [ -n "${rel:-}" ] || { note vpic failed "no vPIC release found for this or last month (vpic.nhtsa.dot.gov/downloads/)"; return; }
  pubrel=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("release",""))' "$PUB/vpic.json" 2>/dev/null)
  if [ "$rel" = "$pubrel" ] && [ "$FORCE" != --force ]; then
    "${PY[@]}" note vpic unchanged --publish "$PUB" --message "release $rel is published" --confirmed --source-modified "$lm" > /dev/null; log "vpic: $rel already published"; return
  fi
  dir=$WORK/vpic/$rel
  if [ -e "$dir/FAILED" ] && [ -z "$(find "$dir/FAILED" -mtime +6)" ] && [ "$FORCE" != --force ]; then
    note vpic failed "release $rel failed $(date -u -r "$dir/FAILED" +%F): $(cat "$dir/FAILED") ($dir/SUMMARY.txt; retried weekly or with --force)"; return
  fi
  if [ ! -e "$dir/DONE" ] || [ "$FORCE" = --force ]; then
    space_ok || { note vpic failed "less than $MIN_FREE_GB GB free on $WORK"; return; }
    log "vpic: building release $rel (scripts/vpic-refresh.sh, $LOGS/vpic-$rel.log)"
    bash "$REPO/scripts/vpic-refresh.sh" "$rel" "$WORK/vpic" > "$LOGS/vpic-$rel.log" 2>&1
  fi
  if [ ! -e "$dir/DONE" ]; then note vpic failed "vpic-refresh.sh $rel: $(cat "$dir/FAILED" 2>/dev/null || echo 'no DONE') ($dir/SUMMARY.txt)"; return; fi
  if grep -qE 'PARITY NOT EXACT|rule fixes needing review' "$dir/SUMMARY.txt"; then
    note vpic needs_review "release $rel built but not published: $(grep -E 'PARITY NOT EXACT|rule fixes needing review' "$dir/SUMMARY.txt" | head -2 | tr '\n' ' ') ($dir/SUMMARY.txt)"; return
  fi
  publish vpic "$dir/vpic.db" --source-date "$(python3 -c 'import sys,email.utils as e; print(e.parsedate_to_datetime(sys.argv[1]).strftime("%Y-%m-%dT%H:%M:%SZ"))' "$lm" 2>/dev/null)" --extra "{\"release\": \"$rel\"}"
}

case "$MODE" in
  odi) run_odi ;;
  ratings) run_ratings ;;
  vpic) run_vpic ;;
  *) echo "unknown mode $MODE (odi|ratings|vpic)"; exit 1 ;;
esac
log "done (exit $RC)"
exit $RC
