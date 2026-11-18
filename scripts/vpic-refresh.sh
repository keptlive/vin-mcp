#!/bin/bash
# Monthly refresh of data/vpic.db from NHTSA's standalone vPIC database. Runs on the storage server (needs
# PostgreSQL for the parity check, ~1 GB disk, node 20+ with better-sqlite3, python3). Does NOT deploy: the result
# is a file to review and copy (docs/data-sources.md, "Monthly refresh").
#
#   scripts/vpic-refresh.sh YYYY_MM [WORKDIR]      e.g. scripts/vpic-refresh.sh 2026_12 /root/vpic-local
# Environment: VPIC_PARITY_N (synthesised parity VINs, default 20000), VPIC_PG_DB (PostgreSQL database to reuse).
#
# Steps (each logs to WORKDIR/RELEASE/logs; a step's failure stops the run and writes FAILED):
#   1. download vPICList_lite_RELEASE.plain.zip from vpic.nhtsa.dot.gov
#   2. build vpic.db with mcp.vin's rule fixes (scripts/import-vpic.py; stops if NHTSA changed its decode functions,
#      exit 3: review lib/vpic-local.mjs first)
#   3. check the rule fixes (scripts/check-vpic-rule-fixes.mjs): which apply, which need review because NHTSA changed
#      the rows they name or the values they were written against
#   4. parity: restore the dump into PostgreSQL database vpic_RELEASE, decode a sample of VINs with NHTSA's own
#      spvindecode (25 VINs per statement; a failed VIN is retried alone, then listed), compare with our interpreter on
#      NHTSA's pristine rules (scripts/vpic-parity.mjs)
#   5. the readable diff of our rules against NHTSA's (docs/vpic-rule-fixes.md for this release) and vpic.db.xz
# Then: WORKDIR/RELEASE/SUMMARY.txt and DONE. Run it detached (setsid nohup ... &) and wait for DONE or FAILED.
set -u
RELEASE=${1:?release YYYY_MM}
WORK=${2:-/root/vpic-local}/$RELEASE
REPO=$(cd "$(dirname "$0")/.." && pwd)
SAMPLE=${VPIC_PARITY_N:-20000}
mkdir -p "$WORK/logs" "$WORK/pg"
cd "$WORK" || exit 1
rm -f DONE FAILED SUMMARY.txt
fail() { echo "$1" > FAILED; echo "FAILED: $1" >> SUMMARY.txt; exit 1; }
say() { echo "$*" | tee -a SUMMARY.txt; }

# 1. download
ZIP=vPICList_lite_$RELEASE.plain.zip
[ -s "$ZIP" ] || curl -sS -f -m 3600 -A "Mozilla/5.0 (compatible; vpic-refresh)" -o "$ZIP" "https://vpic.nhtsa.dot.gov/downloads/$ZIP" || fail download
say "release $RELEASE: $(du -hL "$ZIP" | cut -f1) zip"

# 2. build (exit 4 = some rule fix needs review: the file is still written, without those fixes)
python3 "$REPO/scripts/import-vpic.py" --dump "$ZIP" --out vpic.db --release "$RELEASE" > logs/build.out 2> logs/build.err
rc=$?
[ $rc -eq 3 ] && fail "NHTSA changed its decode functions (logs/build.err): review lib/vpic-local.mjs"
[ $rc -ne 0 ] && [ $rc -ne 4 ] && fail "build exit $rc (logs/build.err)"
say "built vpic.db: $(tail -1 logs/build.out)"
[ $rc -eq 4 ] && say "rule fixes needing review: $(grep -c 'NEEDS REVIEW' logs/build.err) (logs/build.err)"

# 3. rule fixes on this release
node "$REPO/scripts/check-vpic-rule-fixes.mjs" --db vpic.db > logs/fixes.txt 2>&1
say "$(head -1 logs/fixes.txt)"; tail -n +2 logs/fixes.txt >> SUMMARY.txt

# 4. parity with NHTSA's spvindecode on NHTSA's own rules
DB=${VPIC_PG_DB:-vpic_$RELEASE}   # VPIC_PG_DB: reuse a database that already holds this release
if ! sudo -u postgres psql -tc "select 1 from pg_database where datname='$DB'" | grep -q 1; then
  rm -rf dump && mkdir dump && unzip -q -o "$ZIP" -d dump || fail unzip
  SQL=$(ls -S dump/* | head -1)
  sudo -u postgres createdb "$DB" || fail createdb
  chmod 644 "$SQL"
  sudo -u postgres psql -q -d "$DB" -f "$SQL" > logs/restore.out 2> logs/restore.err || fail restore
  rm -rf dump
fi
sudo -u postgres psql -q -d "$DB" > /dev/null <<'SQL' || fail "parity function"
create schema if not exists parity;
create or replace function parity.decode(v varchar) returns table(elementid int, value varchar, source varchar, patternid int, keys varchar, vinschemaid int)
language plpgsql as $$
begin
  return query select d.itemelementid, d.value, d.itemsource, d.itempatternid, d.itemkeys, d.itemvinschemaid from vpic.spvindecode(v) d;
exception when others then
  return query select -1, left(SQLERRM, 300)::varchar, 'ERROR'::varchar, null::int, null::varchar, null::int;
end $$;
SQL
EVID=""; [ -s "$REPO/data/decode-evidence.db" ] && EVID="--evidence $REPO/data/decode-evidence.db"
node "$REPO/scripts/vpic-parity.mjs" sample --db vpic.db --out vins.txt --n "$SAMPLE" $EVID > logs/sample.out 2>&1 || fail sample
decode() { # $1 VIN list, $2 VINs per statement, $3 output dir
  rm -rf "$3" in_tmp && mkdir -p "$3" in_tmp
  split -l "$2" -d -a 6 "$1" in_tmp/
  for f in in_tmp/*; do
    [ -e "$f" ] || continue   # empty list
    list=$(paste -sd, "$f")
    sudo -u postgres psql -q -d "$DB" -c "\copy (select u.vin, d.* from unnest(string_to_array('$list', ',')) with ordinality u(vin, o) cross join lateral parity.decode(u.vin) d order by u.o) to stdout with (format csv)" > "$3/$(basename "$f").csv" 2>> logs/pg.err
  done
  rm -rf in_tmp
}
decode vins.txt 25 pg/a
grep -h ',-1,' pg/a/*.csv | cut -d, -f1 | sort -u > retry.txt
: > never_clean.txt
if [ -s retry.txt ]; then
  decode retry.txt 1 pg/b
  grep -h ',-1,' pg/b/*.csv | cut -d, -f1 | sort -u > never_clean.txt
fi
# keep a VIN's rows only from the pass where it ran clean (FILENAME test, not NR==FNR: an empty list must drop nothing)
drop() { awk -F, 'FILENAME == ARGV[1] { bad[$1] = 1; next } !($1 in bad)' "$1" -; }
rm -rf pg/merged && mkdir pg/merged
cat pg/a/*.csv | drop retry.txt > pg/merged/a.csv
[ -s retry.txt ] && cat pg/b/*.csv | drop never_clean.txt > pg/merged/b.csv
say "spvindecode: $(wc -l < vins.txt) VINs, $(wc -l < retry.txt) retried alone, $(wc -l < never_clean.txt) never ran clean (never_clean.txt)"
node "$REPO/scripts/vpic-parity.mjs" compare --db vpic.db --pg pg/merged --out parity.json > logs/parity.out 2>&1
say "parity (our interpreter on NHTSA's rules vs spvindecode): $(tail -1 logs/parity.out)"
compared=$(node -e 'const p = JSON.parse(require("fs").readFileSync("parity.json", "utf8")); console.log(p.vins + p.nhtsa_errors)' 2>/dev/null || echo 0)
want=$(( $(wc -l < vins.txt) - $(wc -l < never_clean.txt) ))
[ "$compared" = "$want" ] || fail "parity compared $compared VINs, expected $want (pg/merged, logs/parity.out)"
differ=$(node -e 'const p = JSON.parse(require("fs").readFileSync("parity.json", "utf8")); console.log(p.vins - p.all_elements_agree)')
[ "$differ" = "0" ] || say "PARITY NOT EXACT: $differ VINs differ from spvindecode or failed locally (parity.json): review lib/vpic-local.mjs before using this file"

# 5. readable diff and the compressed file
node "$REPO/scripts/vpic-rule-diff.mjs" --db vpic.db --out vpic-rule-fixes.md > /dev/null 2>> logs/diff.err || fail diff
xz -T1 -9 -k -f vpic.db || fail xz
say "files: vpic.db $(du -h vpic.db | cut -f1), vpic.db.xz $(du -h vpic.db.xz | cut -f1), vpic-rule-fixes.md"
touch DONE
