import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecallStatusLookup} from '../lib/recall-status.mjs';
import {validateVin} from '../lib/validate.mjs';
const vinRecallStatus=createRecallStatusLookup((...args)=>globalThis.fetch(...args));
const original = globalThis.fetch;
test.after(()=>{globalThis.fetch=original;});
let seq=10000;
const nextVin=()=>{let v='5YJSA1DG0DFP'+String(seq++);return v.slice(0,8)+validateVin(v).checksum.expected+v.slice(9);};
const respond=body=>async()=>new Response(JSON.stringify(body));
test('only explicit manufacturer status determines completed and open counts; recall date is not repair date',async()=>{
 globalThis.fetch=respond({success:true,responseObject:[{recallNumber:'18V204',recallStatus:'Recall Completed',recallDate:'2018-03-30',documentPath:'javascript:alert(1)'},{recallNumber:'24V051',recallStatus:'Recall Incomplete',documentPath:'https://service.tesla.com/docs/bulletin.pdf'}]});
 const r=await vinRecallStatus(nextVin());assert.equal(r.available,true);assert.equal(r.open_count,1);assert.equal(r.completed_count,1);assert.equal(r.recalls[0].repair_completed_at,null);assert.equal(r.recalls[0].document_url,null);assert.match(r.recalls[1].document_url,/^https:/);assert.ok(r.source.retrieved_at);
});
test('new status strings stay unknown instead of implying no open recalls',async()=>{
 globalThis.fetch=respond({success:true,responseObject:[{recallNumber:'A',recallStatus:'Repair Pending Review'}]});
 const r=await vinRecallStatus(nextVin());assert.equal(r.open_count,null);assert.equal(r.unknown_count,1);assert.equal(r.recalls[0].manufacturer_status,'Repair Pending Review');
});
test('invalid, rejected, null and upstream error responses stay unknown and are retried',async()=>{
 for(const body of [{success:false,responseObject:[]},{success:true,responseObject:null},{success:true,responseObject:[{}]}]){
  const vin=nextVin();globalThis.fetch=respond(body);let r=await vinRecallStatus(vin);assert.equal(r.available,false);assert.equal(r.open_count,null);
  globalThis.fetch=respond({success:true,responseObject:[]});r=await vinRecallStatus(vin);assert.equal(r.available,true);assert.equal(r.open_count,0);
 }
 const vin=nextVin();globalThis.fetch=async()=>{throw Error('offline');};const r=await vinRecallStatus(vin);assert.equal(r.available,false);assert.equal(r.open_count,null);
});
test('unsupported makes never call upstream or invent completed repairs; invalid VINs rejected',async()=>{
 globalThis.fetch=async()=>{throw Error('Unexpected network call');};const r=await vinRecallStatus('1HGCM82633A004352');assert.equal(r.reason,'manufacturer_not_supported');assert.equal(r.completed_count,null);await assert.rejects(()=>vinRecallStatus('invalid'),/valid/);
});
test('successful snapshots deduplicate concurrent lookups and are cached per VIN',async()=>{
 let calls=0;globalThis.fetch=async()=>{calls++;await new Promise(r=>setTimeout(r,10));return new Response(JSON.stringify({success:true,responseObject:[]}));};
 const vin=nextVin();const [a,b]=await Promise.all([vinRecallStatus(vin),vinRecallStatus(vin)]);assert.equal(calls,1);assert.equal(a,b);assert.equal(await vinRecallStatus(vin),a);assert.equal(calls,1);
});
