/**
 * Photos of the vehicle NHTSA tested (report block `photos`), from NHTSA's vehicle crash-test database: the test
 * lab's own photos of the car before the test and after the crash, chosen by file name
 * (scripts/nhtsa_photo_select.py), downloaded once, resized and served by mcp.vin from data/nhtsa-photos/ (built by
 * scripts/build-nhtsa-photos.py; the index rows are data-src/test-vehicle-photos.jsonl, table `photos` of
 * data/tire-placards.db). Visitors' browsers load them from mcp.vin only.
 *
 * Which car (lib/tire-placards.mjs lookup, same tiers as the tire and capacity blocks): the closest tested vehicle
 * with photos before the test, by selectClosest. Stricter than the other blocks, because a photo shows the shape:
 *  - a tested vehicle whose body class, cab or door count differs from the VIN's (as vPIC decodes both) is never
 *    used: a sedan is not shown for a coupe, a crew cab not for a regular cab;
 *  - another model year only when Transport Canada lists the same wheelbase for both years (same generation);
 *    'unknown' is not enough.
 * Crash views come from the same tested model year and make/model (NHTSA's frontal, side and pole tests use
 * separate cars): one per test kind, the main car's own test first. Every photo names its own test car and test.
 * No match, or no photo before the test: `photos` is null (the site shows no photo area).
 */
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const PHOTOS_DIR = process.env.NHTSA_PHOTOS_DIR || fileURLToPath(new URL('../data/nhtsa-photos/', import.meta.url));
/** Public URL path the server mounts PHOTOS_DIR at; reports carry absolute URLs on the site's origin (BASE_URL). */
export const PHOTOS_URL = '/nhtsa-photos/';
const ORIGIN = String(process.env.BASE_URL || 'https://mcp.vin').replace(/\/+$/, '');
const PRE_MAX = 3, CRASH_MAX = 3;
const KIND_ORDER = ['frontal', 'side', 'pole', 'rear'];
/** Differences that change what the car looks like: never shown for them. */
const SHAPE_FIELDS = new Set(['body', 'cab', 'doors']);

export const PHOTOS_NOTE = 'Photos of a vehicle NHTSA bought and tested, taken by NHTSA\'s test lab (NHTSA vehicle crash-test database). Not this vehicle: model year, trim, colour, wheels and equipment can differ; each photo names its test car and NHTSA test.';

const VIEW_WORDS = {
  front_34_left: 'left front three-quarter view', front_34_right: 'right front three-quarter view', front_34: 'front three-quarter view',
  rear_34_left: 'left rear three-quarter view', rear_34_right: 'right rear three-quarter view', rear_34: 'rear three-quarter view',
  side_left: 'left side', side_right: 'right side', side: 'side view', front: 'front view', rear: 'rear view', as_delivered: 'as delivered to the test lab',
};
const TEST_WORDS = {frontal: 'frontal crash test', side: 'side barrier crash test', pole: 'side pole crash test', rear: 'rear impact test'};
const mph = kmh => Math.round(kmh / 1.609344);

/** "NHTSA frontal crash test 10060". */
export function testLabel(row) {
  return `NHTSA ${TEST_WORDS[row.test_kind] || 'test'} ${row.test_no}`;
}

/** How the test was run, from NHTSA's test record (configuration, impact angle, closing speed); null when not a crash test. */
export function testDescription(row) {
  const v = Number(row.closing_speed_kmh);
  const at = Number.isFinite(v) && v > 0 ? ` at ${Math.round(v)} km/h (${mph(v)} mph)` : '';
  const side = row.struck_side === 'left' || row.struck_side === 'right' ? row.struck_side : null;
  switch (row.test_kind) {
    case 'frontal': return `The car was driven into a rigid barrier${at}.`;
    case 'side': return `A moving barrier was driven into the car's ${side ? `${side} ` : ''}side${at}.`;
    case 'pole': return `The car was moved sideways into a rigid pole${at}${side ? `, ${side} side first` : ''}.`;
    case 'rear': return `A moving barrier was driven into the car's rear${at}.`;
    default: return null;
  }
}

/** Plain-words label of one photo: "Before the test: right front three-quarter view", "After NHTSA's frontal crash test". */
export function photoLabel(photo, row) {
  if (photo.phase === 'pre') return photo.view === 'as_delivered' ? 'Before the test: as delivered to the test lab' : `Before the test: ${VIEW_WORDS[photo.view] || 'whole car'}`;
  return `After NHTSA's ${TEST_WORDS[row.test_kind] || 'test'}: ${VIEW_WORDS[photo.view] || 'whole car'}`;
}

const PHASES = {pre: 'pre_test', post: 'post_test'};

function item(photo, row, match) {
  const base = `${ORIGIN}${PHOTOS_URL}${row.test_no}/${photo.stem}`;
  return {
    url: `${base}-960.webp`, width: photo.w960.width, height: photo.w960.height,
    thumbnail_url: `${base}-320.webp`, thumbnail_width: photo.w320.width, thumbnail_height: photo.w320.height,
    phase: PHASES[photo.phase], view: photo.view, label: photoLabel(photo, row),
    tested_as: row.tested_as, model_year: row.year, test_no: row.test_no, test_kind: row.test_kind || null,
    test_label: testLabel(row), test_description: testDescription(row), test_type: row.test_type || null,
    match, nhtsa_test_url: row.report_url, nhtsa_photo_url: photo.nhtsa_url, original_file_name: photo.original_file_name,
  };
}

let dirChecked = null;
/** True when the photo folder is deployed (checked once per process unless `dir` is given). */
export function photosDeployed(dir) {
  if (dir) return existsSync(dir);
  if (dirChecked === null) dirChecked = existsSync(PHOTOS_DIR);
  return dirChecked;
}

/**
 * The photos block for one VIN. `rows`: photo rows of the VIN's make and model (powertrain already guarded), each with
 * `photos` parsed. `closest(rows)`: lib/tire-placards.mjs selectClosest bound to the VIN (best tier, match objects
 * included); `matchOf(row)`: the same match object for any row. Returns null when nothing qualifies.
 */
export function photosFor(rows, {closest, matchOf}) {
  const shapeOk = c => !c.match.differences.some(d => SHAPE_FIELDS.has(d.field))
    && (c.match.year_gap === 0 || c.match.generation_check === 'same_wheelbase');
  // The closest tier first; when all of it has another shape or generation, the next tiers in turn.
  let pool = rows.filter(r => r.photos.some(p => p.phase === 'pre')), main = null;
  while (pool.length && !main) {
    const tier = closest(pool);
    if (!tier.length) break;
    main = tier.find(shapeOk) || null;
    const seen = new Set(tier.map(c => c.row));
    pool = pool.filter(r => !seen.has(r));
  }
  if (!main) return null;
  const items = main.row.photos.filter(p => p.phase === 'pre').slice(0, PRE_MAX).map(p => item(p, main.row, main.match));
  // Crash views: the same tested model year and make/model; one test per kind, the main car's own test first, then
  // the fewest differences from the VIN; never another shape.
  const family = rows.filter(r => r.year === main.row.year && r.test_no !== main.row.test_no).map(r => ({row: r, match: matchOf(r)}))
    .filter(shapeOk).sort((a, b) => a.match.differences.length - b.match.differences.length || a.row.test_no - b.row.test_no);
  const ordered = [main, ...family];
  const crash = [];
  for (const kind of KIND_ORDER) {
    const c = ordered.find(x => x.row.test_kind === kind && x.row.photos.some(p => p.phase === 'post'));
    if (!c) continue;
    crash.push(item(c.row.photos.find(p => p.phase === 'post'), c.row, c.match));
    if (crash.length === CRASH_MAX) break;
  }
  return {items: [...items, ...crash]};
}
