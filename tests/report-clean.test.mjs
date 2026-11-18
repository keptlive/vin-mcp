import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const read = file => readFileSync(new URL('../public/' + file, import.meta.url), 'utf8');
function clean() {
  const ctx = vm.createContext({console});
  vm.runInContext(read('report-clean.js') + '\nthis.ReportClean = ReportClean;', ctx);
  return ctx.ReportClean;
}

test('clean view: short values share a row, long ones keep the full row', () => {
  const C = clean();
  assert.equal(C.isWide('Year', '2021'), false);
  assert.equal(C.isWide('Seats', '5 in 2 rows'), false);
  assert.equal(C.isWide('Body', 'Sport Utility Vehicle [SUV]/Multipurpose Vehicle [MPV]'), true);
  assert.equal(C.isWide('Rated horsepower (EPA test vehicles)', '190 hp'), true);
  assert.equal(C.isWide('Doors', '  5  '), false);
});

test('clean view: a recall campaign folds to its number and month', () => {
  const C = clean();
  assert.equal(C.recallMeta('21V900000', '2021-11-18'), '21V900000 · Nov 2021');
  assert.equal(C.recallMeta('21V900000', ''), '21V900000');
  assert.equal(C.recallMeta('', '2024-02-01'), 'Feb 2024');
  assert.equal(C.recallMeta('', 'unknown'), '');
});

test('clean view: only badges that repeat the Vehicle section or state the normal case are dropped', () => {
  const C = clean();
  assert.equal(C.badgeIsExtra('Checksum Valid', false), true);
  assert.equal(C.badgeIsExtra('MULTIPURPOSE PASSENGER VEHICLE (MPV)', true), true);
  assert.equal(C.badgeIsExtra('5/5 Stars', true), false);
  assert.equal(C.badgeIsExtra('4 model-year recall campaigns', false), false);
  assert.equal(C.badgeIsExtra('Checksum invalid', false), false);        // a problem is never hidden
  assert.equal(C.badgeIsExtra('2 open recalls', true), false);
});

test('clean view: every rule is screen only, so print keeps the full text', () => {
  const css = read('report-clean.css').replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0, outside = '';
  for (const part of css.split(/(@media[^{]*\{|\{|\})/)) {
    if (/^@media/.test(part)) { assert.match(part, /@media screen/); depth++; continue; }
    if (part === '{') { depth++; continue; }
    if (part === '}') { depth--; continue; }
    if (depth === 0) outside += part;
  }
  assert.equal(outside.trim(), '', 'no rule outside an @media screen block');
  // correction forms keep their own notes while a section's notes are folded
  assert.match(css, /\.sheet-section\[data-clean-box\]:not\(\.is-open\) :is\([^)]*\):not\(\.placard-fix \*,\.decode-fix \*\)\{display:none\}/);
  const html = read('index.html');
  assert.ok(html.includes('/report-clean.css') && html.includes('/report-clean.js'));
});
