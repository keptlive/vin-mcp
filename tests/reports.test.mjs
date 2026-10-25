import test from 'node:test';
import assert from 'node:assert/strict';
import { fullReport } from '../lib/reports.mjs';
import { vinCache, recallCache, ratingCache, fuelCache } from '../lib/cache.mjs';

test('concurrent reports share assembly, and a failed assembly can be retried', async () => {
  const original = globalThis.fetch;
  const vin = '4T1BF1FK0CU123456';
  const caches = [vinCache, recallCache, ratingCache, fuelCache];
  caches.forEach(cache => cache.clear());
  let decodeCalls = 0, fail = true;
  let release;
  let gate = new Promise(resolve => { release = resolve; });
  globalThis.fetch = async url => {
    if (String(url).includes('DecodeVinValues')) {
      decodeCalls++;
      await gate;
      if (fail) return new Response('', {status:503});
      return Response.json({Results:[{VIN:vin,Make:'TOYOTA',Model:'Camry',ModelYear:'2012'}]});
    }
    if (String(url).includes('SafetyRatings')) return Response.json({Results:[]});
    if (String(url).includes('fueleconomy')) return Response.json(null);
    return Response.json({results:[]});
  };
  try {
    const first = fullReport(vin), duplicate = fullReport(vin.toLowerCase());
    release();
    const failed = await Promise.all([first, duplicate]);
    assert.equal(decodeCalls, 1);
    assert.equal(failed[0].vehicle, null);
    fail = false;
    const recovered = await fullReport(vin);
    assert.equal(decodeCalls, 2);
    assert.equal(recovered.vehicle.model, 'Camry');
    assert.equal(recovered.recall_status.open_count, null);
    const cached = await fullReport(vin);
    assert.equal(decodeCalls, 2);
    assert.equal(cached.provenance.assembled_at, recovered.provenance.assembled_at);
  } finally {
    globalThis.fetch = original;
    caches.forEach(cache => cache.clear());
  }
});
