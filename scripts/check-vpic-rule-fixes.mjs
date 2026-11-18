#!/usr/bin/env node
/**
 * Check mcp.vin's rule fixes against a built data/vpic.db (run after every monthly refresh):
 *   needs_review        the build did not apply the fix: NHTSA changed a row it names (see `problem`)
 *   official_changed    NHTSA's own rules no longer decode the value the fix was written against for its test VINs
 *                       (NHTSA may have fixed it, or changed something nearby): review the fix
 *   fix_not_effective   the fixed rules do not give the fixed value for its test VINs (another row now outranks it)
 *   ok                  every test VIN decodes as reviewed: NHTSA's value on NHTSA's rules, ours on the fixed rules
 * The test VINs and values are the `checks` of each entry in data-src/vpic-rule-fixes.jsonl (NHTSA test vehicles).
 *
 * Usage: node scripts/check-vpic-rule-fixes.mjs [--db data/vpic.db] [--changeset data-src/vpic-rule-fixes.jsonl] [--json]
 * Exit 0 when every fix is ok, 1 otherwise.
 */
import Database from 'better-sqlite3';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {decodeLocal} from '../lib/vpic-local.mjs';

export const CHANGESET_FILE = fileURLToPath(new URL('../data-src/vpic-rule-fixes.jsonl', import.meta.url));

/** One result per changeset entry: {id, status, problems[]}. `ids` limits the check to some entries. */
export function checkRuleFixes({db, changeset = CHANGESET_FILE, ids = null} = {}) {
  const entries = readFileSync(changeset, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l)).filter(e => !ids || ids.includes(e.id));
  const sdb = new Database(db, {readonly: true, fileMustExist: true});
  const has = !!sdb.prepare("SELECT 1 FROM sqlite_master WHERE name = 'rule_fix_entry'").get();
  const built = new Map(has ? sdb.prepare('SELECT fix_id, status, problem FROM rule_fix_entry').all().map(r => [r.fix_id, r]) : []);
  sdb.close();
  const out = [];
  for (const e of entries) {
    const b = built.get(e.id);
    if (!b) { out.push({id: e.id, status: 'needs_review', problems: ['not in this build (built without rule fixes, or from another changeset)']}); continue; }
    if (b.status !== 'applied') { out.push({id: e.id, status: 'needs_review', problems: [b.problem || b.status]}); continue; }
    const problems = [];
    let status = 'ok';
    if (!Array.isArray(e.checks) || !e.checks.length) { out.push({id: e.id, status: 'no_checks', problems: ['the entry has no test VINs to check']}); continue; }
    for (const c of e.checks) {
      const fixed = decodeLocal(c.vin, {file: db}), pristine = decodeLocal(c.vin, {file: db, rules: 'pristine'});
      if (!fixed.available || !pristine.available) { problems.push(`${c.vin}: decode failed (${fixed.reason || pristine.reason})`); status = 'fix_not_effective'; continue; }
      for (const [field, want] of Object.entries(c.fields || {})) {
        const off = pristine.values[field], ours = fixed.values[field];
        if (off !== want.official_value) {
          problems.push(`${c.vin} ${field}: NHTSA's rules now give ${JSON.stringify(off)}, the fix was written against ${JSON.stringify(want.official_value)}`);
          if (status === 'ok') status = 'official_changed';
        }
        if (ours !== want.fixed_value) {
          problems.push(`${c.vin} ${field}: the fixed rules give ${JSON.stringify(ours)}, expected ${JSON.stringify(want.fixed_value)}`);
          status = 'fix_not_effective';
        }
      }
    }
    out.push({id: e.id, status, problems});
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
  const db = opt('--db', fileURLToPath(new URL('../data/vpic.db', import.meta.url)));
  const res = checkRuleFixes({db, changeset: opt('--changeset', CHANGESET_FILE)});
  const counts = {};
  for (const r of res) counts[r.status] = (counts[r.status] || 0) + 1;
  if (args.includes('--json')) console.log(JSON.stringify({db, counts, results: res}, null, 1));
  else {
    console.log(`rule fixes in ${db}: ${JSON.stringify(counts)}`);
    for (const r of res.filter(r => r.status !== 'ok')) console.log(`  ${r.id} ${r.status}: ${r.problems.join('; ')}`);
  }
  process.exit(res.every(r => r.status === 'ok') ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
