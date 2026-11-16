import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSubaru, parseVw, parseAudi, audiRequest, parseLandRover} from '../lib/more-manufacturer-recalls.mjs';
import {parseHonda} from '../lib/manufacturer-recalls.mjs';
import {createRecallStatusLookup} from '../lib/recall-status.mjs';

// Reply shapes below are trimmed copies of real replies seen on 2026-11-16.
const SUBARU = '4S4BSBJCXG3250910', VW = '3VWD17AJ9GM333431', AUDI = 'WAUEFAFL5FN036481', LR = 'SALVP2BG4GH078924', ACURA = '5FRYD3H43GB009835';
const subaruRecall = (over = {}) => ({date: {rawDate: 1447977600000}, code: 'WQV57', nhtsaRecallNumber: '15V794000', type: 'Safety', status: 'Completed', description: 'Propeller shaft bolts', shortDescription: 'Prop Shaft Rr Flange Bolt Torque', safetyRiskDescription: 'Risk', remedyDescription: 'Inspect', ...over});
const subaru = (recalls, over = {}) => ({modelYear: 2016, modelName: 'Outback', trimName: '2.5i Limited', vin: SUBARU, recalls, ...over});
const vw = (over = {}) => ({vin: VW, status: true, year: 2016, make: 'VW', model: 'JETTA SPORT 1.8L AUTO PZ', manufacturerId: 1, isRecallsAvailable: false, numberOfRecalls: 0, refreshDate: 'Nov 13, 2026', ...over});
const audi = recalls => ({data: {vehicleRecalls: {brand: 'AUDI', model: 'A4 Sedan 2.0T FWD Multitronic', modelYear: 2015, refreshDate: 'Nov 13, 2026', recalls}}});

test('Subaru keeps safety recalls apart from emissions campaigns and reads completed and incomplete status', () => {
  const r = parseSubaru(subaru([subaruRecall(), subaruRecall({code: 'WUJ95', nhtsaRecallNumber: null, type: 'Emissions'}), subaruRecall({code: 'WRA24', status: 'Incomplete'})]), SUBARU);
  assert.equal(r.open_count, 1); assert.equal(r.completed_count, 1); assert.equal(r.service_campaign_count, 1);
  assert.equal(r.recalls[0].nhtsa_campaign_number, '15V794000'); assert.equal(r.recalls[0].recall_date, '2015-11-20'); assert.equal(r.recalls[0].repair_completed_at, null);
  assert.equal(r.service_campaigns[0].record_kind, 'emissions_recall');
});
test('Subaru: an unrecognized VIN is not zero, an unfamiliar status is unknown, a wrong VIN or shape fails', () => {
  assert.equal(parseSubaru({modelYear: 0, modelName: null, trimName: '', vin: SUBARU, recalls: []}, SUBARU), null);
  const r = parseSubaru(subaru([subaruRecall({status: 'No further action needed'})]), SUBARU);
  assert.equal(r.open_count, null); assert.equal(r.unknown_count, 1);
  assert.equal(parseSubaru(subaru([]), SUBARU).open_count, 0);
  assert.throws(() => parseSubaru(subaru([], {vin: VW}), SUBARU));
  assert.throws(() => parseSubaru(subaru(null), SUBARU));
  assert.throws(() => parseSubaru(subaru([{status: 'Completed'}]), SUBARU));
});

test('Volkswagen: a recognized vehicle with no records is zero open with completed unknown', () => {
  const r = parseVw(vw(), VW);
  assert.equal(r.open_count, 0); assert.equal(r.completed_count, null); assert.equal(r.coverage.completed_history, false);
});
test('Volkswagen: status codes map as on its page, service campaigns stay separate, counts must agree', () => {
  const rec = (n, status, type = 'SAFETY') => ({mfrRecallNumber: n, mfrRecallStatus: status, vwgoaActionType: type, nhtsaRecallNumber: '16V078', recallDate: '2016-02-10T00:00:00', recallDescription: 'd', remedyDescription: 'r'});
  const r = parseVw(vw({numberOfRecalls: 4, isRecallsAvailable: true, recalls: [rec('69L7', 11), rec('69M1', 12), rec('69N2', 13), rec('24DG', 11, 'SERVICE')]}), VW);
  assert.equal(r.open_count, 2); assert.equal(r.completed_count, 1); assert.equal(r.service_campaign_count, 1);
  assert.equal(r.recalls[1].remedy_available, false); assert.equal(r.recalls[0].recall_date, '2016-02-10');
  assert.equal(parseVw(vw({numberOfRecalls: 1, recalls: [rec('69L7', 99)]}), VW).open_count, null);
  assert.throws(() => parseVw(vw({numberOfRecalls: 2, recalls: [rec('69L7', 11)]}), VW));
  assert.throws(() => parseVw(vw({numberOfRecalls: 1}), VW));
});
test('Volkswagen: other-market and unrecognized VINs stay unknown; errors and mismatches fail', () => {
  for (const errorCode of [62, 64, 72, 74, 91]) assert.equal(parseVw({vin: VW, status: false, errorCode}, VW), null);
  assert.throws(() => parseVw({vin: VW, status: false, errorCode: 92}, VW));
  assert.throws(() => parseVw(vw({vin: SUBARU}), VW));
  assert.throws(() => parseVw(vw({year: 0}), VW));
});

test('Audi sends the public page query and reads completion status', () => {
  const q = audiRequest(AUDI), sent = JSON.parse(q.body);
  assert.equal(q.method, 'POST'); assert.equal(q.headers['apollographql-client-name'], 'fa-nar-vehicle-recall');
  assert.deepEqual(sent.variables, {input: {vin: AUDI, market: 'US', language: 'en'}});
  let r = parseAudi(audi([]));
  assert.equal(r.open_count, 0); assert.equal(r.completed_count, null);
  const rec = (n, s, t = 'SAFETY') => ({manufacturerRecallNumber: n, repairCompletionStatus: s, actionType: t, recallNumber: '19V-123', recallDate: '2019-03-01', actionTitle: 't'});
  r = parseAudi(audi([rec('A1', 'INCOMPLETE'), rec('A2', 'INCOMPLETE_NO_REMEDY'), rec('A3', 'COMPLETE'), rec('A4', 'COMPLETE', 'ENVIRONMENTAL')]));
  assert.equal(r.open_count, 2); assert.equal(r.completed_count, 1); assert.equal(r.service_campaigns[0].record_kind, 'emissions_recall');
  assert.equal(parseAudi(audi([rec('A1', 'SOMETHING_NEW')])).open_count, null);
});
test('Audi: "not found for US market" stays unknown; other errors and changed shapes fail', () => {
  const err = code => ({data: null, errors: [{message: 'x', extensions: {code: 'VEHICLE_RECALLS_API_FAILURE', message: 'Vehicle Recalls API failed with error code: ' + code}}]});
  assert.equal(parseAudi(err(91)), null);
  assert.throws(() => parseAudi(err(100)));
  assert.throws(() => parseAudi({data: {vehicleRecalls: {brand: 'VW', model: 'x', modelYear: 2015, recalls: []}}}));
  assert.throws(() => parseAudi({data: {vehicleRecalls: {brand: 'AUDI', model: 'x', modelYear: 2015, recalls: null}}}));
});

test('Land Rover: "no recalls found" for a recognized vehicle is zero open; codes map as on its page', () => {
  let r = parseLandRover({model: '2016', vin: LR, error: 204, vehicle: 'Range Rover Evoque 2.0L Si4 Petrol 4WD A'}, LR);
  assert.equal(r.open_count, 0); assert.equal(r.completed_count, null);
  assert.equal(parseLandRover({model: '', vin: LR, error: 204, vehicle: ''}, LR), null);
  const rec = (n, c) => ({mfrRecallNumber: n, mfrRecallStatus: c, nhtsaRecallNumber: '17V-457', recallDate: '2017-07-20', recallDescription: 'd'});
  r = parseLandRover({year: '2016', vehicleName: 'Range Rover Evoque', vehicleIdentificationNumber: LR, recalls: [rec('N098', 11), rec('N101', 12), rec('N111', 14)]}, LR);
  assert.equal(r.open_count, 2); assert.equal(r.completed_count, 1); assert.equal(r.recalls[1].remedy_available, false);
  assert.equal(parseLandRover({year: '2016', vehicleName: 'x', vehicleIdentificationNumber: LR, recalls: [rec('N098', 13)]}, LR).open_count, null);
  assert.throws(() => parseLandRover({year: '2016', vehicleName: 'x', vehicleIdentificationNumber: SUBARU, recalls: []}, LR));
});

test('Acura is answered by the Honda lookup under its own division', () => {
  const body = division => ({actions: [{id: '1;a', state: 'SUCCESS', error: [], returnValue: {returnValue: {response: {recalls_response: {response: {error: 'false', recall: {campaignType: {}, division_cd: division, model_group_name: 'MDX', VIN: ACURA}}}}}}}]});
  assert.equal(parseHonda(body('B'), ACURA).open_count, 0);
  assert.equal(parseHonda(body('C'), ACURA), null);
});

test('new makes route by VIN prefix, name their source, cache successes and keep failures unknown', async () => {
  const calls = [];
  const lookup = createRecallStatusLookup(async (url, options) => {
    calls.push([url, options.method || 'GET']);
    const body = url.includes('subaru.com') ? subaru([subaruRecall()]) : url.includes('vwusa.io') ? vw() : url.includes('audi.com') ? audi([]) : {model: '2016', vin: LR, error: 204, vehicle: 'Range Rover Evoque'};
    return {ok: true, json: async () => body, text: async () => JSON.stringify(body)};
  });
  let r = await lookup(SUBARU); assert.equal(r.available, true); assert.equal(r.completed_count, 1); assert.match(r.source.provider, /Subaru/); assert.equal(r.verification_url, 'https://www.subaru.com/recalls.html');
  r = await lookup(VW); assert.equal(r.available, true); assert.equal(r.open_count, 0); assert.match(r.source.url, /vin=3VWD17AJ9GM333431$/);
  r = await lookup(AUDI); assert.equal(r.available, true); assert.equal(calls.at(-1)[1], 'POST');
  r = await lookup(LR); assert.equal(r.available, true); assert.match(r.source.provider, /Land Rover/);
  const before = calls.length; await lookup(SUBARU); assert.equal(calls.length, before);
  const failing = createRecallStatusLookup(async () => ({ok: false, json: async () => ({}), text: async () => ''}));
  r = await failing(VW); assert.equal(r.available, false); assert.equal(r.open_count, null);
  const wrong = createRecallStatusLookup(async () => ({ok: true, json: async () => ({vin: VW, status: false, errorCode: 91})}));
  r = await wrong(VW); assert.equal(r.reason, 'vin_not_confirmed'); assert.equal(r.open_count, null);
});
