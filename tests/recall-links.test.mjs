// The link table (lib/recall-links.mjs): the maker's own recall page, the VIN in the link only where shown to work,
// NHTSA always; counts null. Pure: no request is made here or in the module.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAKERS, makerKey, recallLinks, recallStatusFor, nhtsaRecallUrl, NHTSA_RECALLS } from '../lib/recall-links.mjs';
import { InputError } from '../lib/research.mjs';
import { validateVin } from '../lib/validate.mjs';

const fix = v => v.slice(0, 8) + validateVin(v).checksum.expected + v.slice(9);
const FORD = '1FTEX1EP4FFD06976';

test('every entry: an https page, a VIN link only with a recorded basis, a name and what it covers', () => {
  for (const [key, m] of Object.entries(MAKERS)) {
    assert.match(m.page, /^https:\/\/[a-z0-9.-]+\//, key);
    assert.ok(m.maker && m.covers, key);
    if (m.vinUrl) {
      assert.ok(['in_use', 'browser_1118', 'page_code'].includes(m.basis), `${key}: a prefilled link needs a basis`);
      const url = m.vinUrl(FORD);
      assert.ok(url.startsWith('https://') && url.includes(FORD), key);
      assert.equal(new URL(url).hostname, new URL(m.page).hostname, `${key}: same site as its page`);
    } else assert.equal(m.basis, null, key);
  }
  assert.deepEqual(Object.entries(MAKERS).filter(([, m]) => m.vinUrl).map(([k]) => k).sort(), ['acura', 'ford', 'honda', 'hyundai', 'subaru', 'tesla']);
  assert.ok(Object.isFrozen(MAKERS));
});

test('the decoded make picks the page; the WMI only when there is no make', () => {
  const cases = [['FORD', 'ford'], ['LINCOLN', 'ford'], ['MERCURY', 'ford'], ['CHEVROLET', 'gm'], ['GMC', 'gm'], ['CADILLAC', 'gm'], ['TESLA', 'tesla'],
    ['HONDA', 'honda'], ['ACURA', 'acura'], ['SUBARU', 'subaru'], ['HYUNDAI', 'hyundai'], ['TOYOTA', 'toyota'], ['LEXUS', 'toyota'], ['SCION', 'toyota'],
    ['KIA', 'kia'], ['NISSAN', 'nissan'], ['INFINITI', 'infiniti'], ['JEEP', 'mopar'], ['RAM', 'mopar'], ['ALFA ROMEO', 'mopar'], ['VOLKSWAGEN', 'vw'],
    ['AUDI', 'audi'], ['LAND ROVER', 'landrover'], ['JAGUAR', 'jaguar'], ['MERCEDES-BENZ', 'mercedes'], ['MAZDA', 'mazda'], ['BMW', 'bmw'], ['LUCID', 'lucid'],
    ['VOLVO', null], ['MINI', null], ['GENESIS', null], ['MITSUBISHI', null], ['PORSCHE', null], ['RIVIAN', null], ['POLESTAR', null]];
  for (const [make, key] of cases) assert.equal(makerKey(FORD, make), key, make);
  assert.equal(makerKey(FORD, 'ford'), 'ford', 'case does not matter');
  // No make: the WMI, except WMIs two makes share (Nissan and INFINITI build on JN1, JN8, 5N1).
  assert.equal(makerKey(FORD), 'ford');
  assert.equal(makerKey('19UUA8F59CA123456'), 'acura');
  assert.equal(makerKey('JN1AZ4EH5FM730841'), null);
  assert.equal(makerKey('YV1MS382062123456'), null);
});

test('Ford: the VIN is in the link; NHTSA always; counts null, never zero', () => {
  const s = recallStatusFor(FORD, 'FORD');
  assert.deepEqual(s, {vin: FORD, scope: 'vin', vin_specific: true, available: false, reason: 'manufacturer_link_only', checked_by_mcp_vin: false,
    maker: 'Ford', manufacturer_lookup_url: `https://www.ford.com/support/recalls-details/${FORD}/`, manufacturer_page_url: 'https://www.ford.com/support/recalls/',
    vin_prefilled: true, nhtsa_lookup_url: `https://www.nhtsa.gov/recalls?vin=${FORD}`, nhtsa_vin_prefilled: null,
    verification_url: `https://www.ford.com/support/recalls-details/${FORD}/`, open_count: null, completed_count: null, recalls: [], note: s.note});
  assert.match(s.note, /^mcp\.vin does not check this VIN with Ford or NHTSA/);
  assert.match(s.note, /unknown here \(never zero\)/);
  assert.match(s.note, /Only the manufacturer or NHTSA can say whether this exact car's repairs are done/);
});

test('a page that does not take the VIN is linked plain; an unlisted make gets NHTSA only', () => {
  const toyota = fix('4T1BF1FK0CU123456');
  const t = recallLinks(toyota, 'LEXUS');
  assert.deepEqual([t.maker, t.manufacturer_lookup_url, t.vin_prefilled], ['Toyota', 'https://www.toyota.com/recall/', false]);
  const volvo = recallStatusFor(fix('YV1MS382062123456'), 'VOLVO');
  assert.deepEqual([volvo.maker, volvo.manufacturer_lookup_url, volvo.manufacturer_page_url, volvo.vin_prefilled], [null, null, null, null]);
  assert.equal(volvo.verification_url, volvo.nhtsa_lookup_url);
  assert.match(volvo.note, /check NHTSA's recall page \(nhtsa_lookup_url\); no manufacturer page is listed/);
  assert.doesNotMatch(volvo.note, /manufacturer's page/);
});

test('NHTSA link: the VIN only when it is well formed; an invalid VIN is an input error', () => {
  assert.equal(nhtsaRecallUrl(FORD.toLowerCase()), `${NHTSA_RECALLS}?vin=${FORD}`);
  assert.equal(nhtsaRecallUrl('not a vin'), NHTSA_RECALLS);
  assert.throws(() => recallStatusFor('1FTEX1EP5FFD06976', 'FORD'), InputError, 'bad check digit');
  assert.throws(() => recallStatusFor('<script>', 'FORD'), InputError);
});
