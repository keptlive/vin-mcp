import test from 'node:test';
import assert from 'node:assert/strict';
import {scenario} from '../lib/scenario.mjs';
import {catalog,epaRecord,dimensions,emissions,ownerMpg} from '../lib/research.mjs';
import {rateBenchmarks} from '../lib/rate-benchmarks.mjs';
import {VinClient} from '../public/client.mjs';
test('zero-rate loan amortizes exactly and excludes double counted principal from ownership',()=>{
 const r=scenario({price:20000,apr:0,months:40,down_payment:4000,ownership:{years:5,annual_miles:10000,resale_value:10000,annual_insurance:1000,annual_maintenance:300,annual_repairs:200,energy_type:'gas',energy_price:4,efficiency:25}});
 assert.equal(r.financing.monthly_payment,400);assert.equal(r.financing.total_interest,0);assert.equal(r.schedule.at(-1).balance,0);assert.equal(r.ownership.breakdown.energy,8000);assert.equal(r.ownership.total,25500);assert.equal(r.ownership.cost_per_mile,.51);
});
test('standard amortization agrees with independent known example',()=>{const r=scenario({price:20000,apr:6,months:60});assert.equal(r.financing.monthly_payment,386.66);assert.equal(r.financing.total_interest,3199.36);assert.equal(r.schedule.at(-1).balance,0);});
test('electric energy uses kWh per 100mi, not miles per gallon',()=>{const r=scenario({price:20000,apr:0,months:60,ownership:{years:1,annual_miles:10000,resale_value:18000,annual_insurance:0,annual_maintenance:0,annual_repairs:0,energy_type:'electric',energy_price:.2,efficiency:30}});assert.equal(r.ownership.breakdown.energy,600);assert.equal(r.ownership.total,2600);});
test('invalid numeric and impossible input cannot silently become zero',()=>{for(const bad of [{price:-1},{apr:NaN},{apr:'6'},{months:2.5},{down_payment:30000},{months:0},{price:Infinity}])assert.throws(()=>scenario({price:20000,apr:6,months:60,...bad}));assert.throws(()=>scenario(null));});
test('source input validation happens before network access',async()=>{await assert.rejects(()=>catalog('anything'));await assert.rejects(()=>catalog('model',{year:0,make:'Honda'}));await assert.rejects(()=>epaRecord('../x'));await assert.rejects(()=>dimensions({year:2003,make:[],model:'Accord'}));});
test('source errors remain unavailable and are not cached',async()=>{const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response('{}',{status:503});};try{const a=await emissions('999991');const b=await emissions('999991');assert.equal(a.available,false);assert.equal(b.available,false);assert.equal(calls,2);}finally{globalThis.fetch=original;}});
test('client sends JSON to scoped endpoint, preserves error status and does not bind browser fetch to client',async()=>{let seen;const client=new VinClient({baseUrl:'http://localhost:3298/',fetchImpl:async function(url,opts){assert.equal(this,undefined);seen={url,opts};return new Response('{"ok":true}');}});assert.deepEqual(await client.compare(['a','b']),{ok:true});assert.equal(seen.url,'http://localhost:3298/api/research/compare');assert.deepEqual(JSON.parse(seen.opts.body),{vins:['a','b']});const bad=new VinClient({fetchImpl:async()=>new Response('{"error":"Bad input"}',{status:400})});await assert.rejects(()=>bad.capabilities(),e=>e.status===400&&e.message==='Bad input');});

test('near-zero APR stays finite and fully funded purchase has zero debt',()=>{const r=scenario({price:20000,apr:1e-12,months:40});assert.equal(r.financing.monthly_payment,500);assert.ok(Number.isFinite(r.financing.total_interest));const zero=scenario({price:20000,down_payment:20000,apr:7,months:60});assert.equal(zero.financing.monthly_payment,0);assert.equal(zero.financing.total_interest,0);});

test('malformed successful responses are rejected before caching; valid retry succeeds',async()=>{
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>new Response(JSON.stringify(++calls===1?{}:{id:'999981',year:'2003',make:'Honda',model:'Accord'}));
 try {assert.equal((await epaRecord('999981')).reason,'invalid_response');assert.equal((await epaRecord('999981')).available,true);await epaRecord('999981');assert.equal(calls,2);}finally{globalThis.fetch=original;}
});
test('documented null EPA results remain legitimate empty results',async()=>{
 const original=globalThis.fetch;globalThis.fetch=async()=>new Response('null');
 try {assert.deepEqual((await catalog('options',{year:2003,make:'Fixture',model:'Absent'})).data,[]);const r=await emissions('999982');assert.equal(r.available,true);assert.equal(r.data,null);}finally{globalThis.fetch=original;}
});
test('owner MPG rejects another configuration and preserves zero reports as unknown MPG',async()=>{
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>new Response(JSON.stringify(++calls===1?{vehicleId:'1',recordCount:'2',avgMpg:'20',minMpg:'10',maxMpg:'30'}:{vehicleId:'999983',recordCount:'0'}));
 try {assert.equal((await ownerMpg('999983')).reason,'invalid_response');const r=await ownerMpg('999983');assert.equal(r.available,true);assert.equal(r.data.record_count,0);assert.equal(r.data.average_mpg,null);assert.equal(calls,2);}finally{globalThis.fetch=original;}
});
test('owner MPG retains sample size and source statistical method',async()=>{
 const original=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({vehicleId:'999984',recordCount:'29',avgMpg:'23.548',minMpg:'15',maxMpg:'34',cityPercent:'43',highwayPercent:'57'}));
 try {const r=await ownerMpg('999984');assert.equal(r.data.average_mpg,23.548);assert.equal(r.data.record_count,29);assert.match(r.method,/Harmonic/);assert.match(r.scope,/not a representative/);}finally{globalThis.fetch=original;}
});
test('rate snapshot identifies its historical observation and manual update policy',()=>{const r=rateBenchmarks();assert.equal(r.source.observation_period,'2026-08');assert.equal(r.source.release_date,'2026-10-07');assert.match(r.update_policy,/manual/i);assert.equal(r.data.length,2);assert.equal(typeof r.stale,'boolean');});
