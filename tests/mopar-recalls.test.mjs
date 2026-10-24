import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMopar,moparUrl} from '../lib/mopar-recalls.mjs';
import {createRecallStatusLookup} from '../lib/recall-status.mjs';
import {validateVin} from '../lib/validate.mjs';
import {moparFixture,moparVin} from './mopar-fixture.mjs';

test('Mopar confirms the full VIN, separates rapid responses and preserves unknown completed history',()=>{
 const r=parseMopar(moparFixture(),moparVin);assert.equal(r.open_count,null);assert.equal(r.open_record_count,3);assert.equal(r.completed_count,null);assert.equal(r.service_campaigns.length,1);assert.equal(r.campaigns[0].stop_drive,true);assert.equal(r.campaigns[1].recall_date,null);assert.ok(r.campaigns.every(x=>x.repair_completed_at===null));assert.equal(r.coverage.zero_open_verifiable,false);
});
test('same last eight characters for another VIN never establish applicability',()=>{
 const other='2D3HW48K5'+moparVin.slice(-8);assert.equal(parseMopar(moparFixture(other),moparVin),null);
 const u=new URL(moparUrl(moparVin));assert.equal(u.searchParams.get('vins'),moparVin.slice(-8));assert.equal(u.hostname,'wrecall.extra.chrysler.com');
});
test('Mopar duplicate association rows do not inflate open campaign counts; encoded descriptions stay text',()=>{
 const row=['RC','S43','STOP DRIVE &amp; inspect &#x3c;component&#62;','2016-05-24'];const r=parseMopar(moparFixture(moparVin,[row,row]),moparVin);assert.equal(r.open_count,null);assert.equal(r.open_record_count,1);assert.equal(r.campaigns[0].summary,'STOP DRIVE & inspect <component>');
});
test('schema changes, malformed rows, unknown item codes and oversized HTML fail closed',()=>{
 for(const body of [moparFixture().replace('VIN First 9','VIN'),moparFixture().replace('<td class="tableCell"><FONT>RC</FONT></td>',''),moparFixture(moparVin,[['XX','S43','Description','2016-05-24']]),'x'.repeat(2*1024*1024+1)])assert.throws(()=>parseMopar(body,moparVin));
});
test('empty, mismatched and challenge responses never mean zero and are retried',async()=>{
 for(const body of [moparFixture(moparVin,[]),moparFixture('2D3HW48K5'+moparVin.slice(-8)),'<html>Verify you are human</html>']){
  let calls=0;const lookup=createRecallStatusLookup(async()=>new Response(++calls===1?body:moparFixture()));
  const first=await lookup(moparVin);assert.equal(first.available,false);assert.equal(first.open_count,null);assert.equal(first.completed_count,null);
  const retry=await lookup(moparVin);assert.equal(retry.open_count,null);assert.equal(retry.open_record_count,3);assert.equal(calls,2);
 }
});
test('rapid-response-only Mopar result does not invent zero open recalls',()=>{
 const r=parseMopar(moparFixture(moparVin,[['RR','TEST','Service campaign','2020-01-01']]),moparVin);assert.equal(r.open_count,null);assert.equal(r.completed_count,null);assert.equal(r.service_campaigns.length,1);
});
test('Toyota, Lexus and Scion return an interactive verification path without automated CAPTCHA requests',async()=>{
 let vin='4T1BF1FK0CU123456';vin=vin.slice(0,8)+validateVin(vin).checksum.expected+vin.slice(9);
 const lookup=createRecallStatusLookup(async()=>{throw Error('Unexpected request');});
 for(const make of ['TOYOTA','LEXUS','SCION']){const r=await lookup(vin,make);assert.equal(r.reason,'interactive_verification_required');assert.equal(r.open_count,null);assert.equal(r.completed_count,null);assert.equal(r.verification_url,'https://www.toyota.com/recall/');}
});
test('Mopar network errors are unknown and successful concurrent requests share one dated snapshot',async()=>{
 let calls=0;const lookup=createRecallStatusLookup(async()=>{calls++;if(calls===1)return new Response('',{status:503});await new Promise(r=>setTimeout(r,10));return new Response(moparFixture());});
 assert.equal((await lookup(moparVin)).reason,'upstream_unavailable');const [a,b]=await Promise.all([lookup(moparVin),lookup(moparVin)]);assert.equal(calls,2);assert.equal(a,b);assert.ok(a.source.retrieved_at);assert.equal((await lookup(moparVin)).completed_count,null);assert.equal(calls,2);
});
