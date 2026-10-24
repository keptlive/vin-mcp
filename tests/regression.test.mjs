import test from 'node:test';
import assert from 'node:assert/strict';
import { getFuelEconomy } from '../lib/epa.mjs';
import { getRecalls, getComplaints, decodeVin, batchDecode } from '../lib/nhtsa.mjs';
import { validateVin } from '../lib/validate.mjs';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const json = data => new Response(JSON.stringify(data), { headers: {'content-type':'application/json'} });
const options = [
  {text:'Auto 5-spd, 4 cyl, 2.4 L',value:'18655'},
  {text:'Auto 5-spd, 6 cyl, 3.0 L',value:'18657'},
  {text:'Man 5-spd, 6 cyl, 3.0 L',value:'18658'},
];
const v6 = {engine:{cylinders:6,displacement_l:2.998832712},transmission:{type:'Automatic',speeds:5}};
const detail = {id:18657,year:2003,make:'Honda',model:'Accord',cylinders:6,displ:3.0,trany:'Automatic 5-spd',city08:19,highway08:27,comb08:22,co2TailpipeGpm:0,co2TailpipeAGpm:99};
const originalFetch=globalThis.fetch;
test.afterEach(()=>{globalThis.fetch=originalFetch;});

test('EPA picks V6 automatic, rather than first four-cylinder option',async()=>{
  const urls=[]; globalThis.fetch=async url=>{urls.push(String(url));return json(String(url).includes('menu/options')?{menuItem:options}:detail);};
  const f=await getFuelEconomy(2003,'HONDA','Accord',v6);
  assert.equal(f.available,true); assert.equal(f.cylinders,6); assert.equal(f.vehicle_id,'18657');
  assert.equal(f.combined_mpg,22); assert.match(urls[1],/18657$/); assert.equal(f.co2_grams_per_mile,0);
});
test('EPA refuses ambiguous engine/transmission matches',async()=>{
  globalThis.fetch=async()=>json({menuItem:options});
  const f=await getFuelEconomy(2003,'Honda','Accord',{engine:{cylinders:6}});
  assert.equal(f.available,false); assert.equal(f.reason,'ambiguous_variant');
});
test('EPA never substitutes an incompatible powertrain',async()=>{
  globalThis.fetch=async()=>json({menuItem:options});
  const f=await getFuelEconomy(2003,'Honda','Accord',{engine:{cylinders:8}});
  assert.equal(f.reason,'no_matching_variant');
});
test('EPA rejects a detail response that disagrees with VIN engine',async()=>{
  globalThis.fetch=async url=>json(String(url).includes('menu/options')?{menuItem:options}:{...detail,cylinders:4});
  assert.equal((await getFuelEconomy(2003,'Honda','Accord',v6)).available,false);
});
test('EPA rejects missing and wrong vehicle detail',async()=>{
  for(const body of [{},{...detail,year:2004},{...detail,make:'Toyota'}]){
    globalThis.fetch=async url=>json(String(url).includes('menu/options')?{menuItem:options}:body);
    assert.equal((await getFuelEconomy(2003,'Honda','Accord',v6)).reason,'invalid_response');
  }
});
test('EPA identifies upstream HTTP and network errors',async()=>{
  globalThis.fetch=async()=>new Response('',{status:503});
  assert.equal((await getFuelEconomy(2003,'Honda','Accord',v6)).reason,'upstream_error');
  globalThis.fetch=async()=>{throw new Error('offline');};
  assert.equal((await getFuelEconomy(2003,'Honda','Accord',v6)).reason,'upstream_error');
});
test('EPA supports a single menu item object',async()=>{
  globalThis.fetch=async url=>json(String(url).includes('menu/options')?{menuItem:options[1]}:detail);
  assert.equal((await getFuelEconomy(2003,'Honda','Accord',v6)).vehicle_id,'18657');
});
test('EPA handles EV option and zero tailpipe emissions',async()=>{
  globalThis.fetch=async url=>json(String(url).includes('menu/options')?{menuItem:{text:'Auto (A1), Electricity',value:'1'}}:{id:1,year:2024,make:'Tesla',model:'Model 3',fuelType:'Electricity',co2TailpipeGpm:0,charge240:8});
  const f=await getFuelEconomy(2024,'Tesla','Model 3',{engine:{fuel_type:'Electric'},transmission:{type:'Automatic'}});
  assert.equal(f.available,true);assert.equal(f.is_ev,true);assert.equal(f.co2_grams_per_mile,0);assert.equal(f.ev_charge_time_240v,8);
});
for(const [name,fn] of [['recalls',getRecalls],['complaints',getComplaints]]){
  test(`${name}: zero results are distinguished from a failed request`,async()=>{
    globalThis.fetch=async()=>json({results:[]});
    let result=await fn('Honda','Accord',2003); assert.equal(result.available,true); assert.equal(result.count,0);
    globalThis.fetch=async()=>new Response('',{status:500});
    result=await fn('Honda','Accord',2003);assert.equal(result.available,false);assert.equal(result.count,null);
    globalThis.fetch=async()=>{throw Error('timeout');};
    assert.equal((await fn('Honda','Accord',2003)).available,false);
    globalThis.fetch=async()=>json({unexpected:true});
    assert.equal((await fn('Honda','Accord',2003)).available,false);
  });
}
test('recall results state model-year scope, without claiming VIN repair status',async()=>{
  globalThis.fetch=async()=>json({results:[]});const r=await getRecalls('Honda','Accord',2003);
  assert.equal(r.vin_specific,false);assert.equal(r.scope,'make_model_year');assert.match(r.note,/not determined/);
});
test('vPIC current field names populate backup camera and braking',async()=>{
  globalThis.fetch=async()=>json({Results:[{Make:'Honda',Model:'Accord',ModelYear:'2020',RearVisibilitySystem:'Standard',CIB:'Standard'}]});
  const r=await decodeVin('fixture');assert.equal(r.safety.backup_camera,'Standard');assert.equal(r.safety.auto_emergency_braking,'Standard');
});
test('batch form encoding preserves values as data',async()=>{
  globalThis.fetch=async(url,opts)=>{const p=new URLSearchParams(opts.body);assert.equal(p.get('DATA'),'VIN&format=xml,');assert.equal(p.get('format'),'json');return json({Results:[]});};
  await batchDecode(['VIN&format=xml']);
});
test('VIN validation handles normalization, checksum and invalid input',()=>{
  assert.equal(validateVin(' 1hg-cm82633a004352 ').valid,true);
  for(const v of [null,123,'short','1HGCM82633A004353','1IGCM82633A004352'])assert.equal(validateVin(v).valid,false);
});

// Exercise actual frontend render functions with a minimal DOM, rather than
// testing source spellings or reproducing implementation logic.
function frontend(){
  const els=new Map();const element=()=>({style:{},dataset:{},classList:{add(){},remove(){},toggle(){}},addEventListener(){},innerHTML:'',textContent:'',hidden:false});
  const document={createElement:()=>({set textContent(v){this.innerHTML=String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');}}),querySelector:s=>{if(!els.has(s))els.set(s,element());return els.get(s);},querySelectorAll:()=>[],addEventListener(){}};
  const ctx={document,window:{location:{pathname:'/'}},navigator:{},localStorage:{getItem(){return null;}},console,fetch:async()=>new Response('{}'),setTimeout(){}};
  vm.createContext(ctx);vm.runInContext(readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),ctx);
  return {ctx,els,run:script=>vm.runInContext(script,ctx)};
}
test('frontend displays unavailable recalls and complaints without zero/safe badges',()=>{
  const {els,run}=frontend();run('renderRecalls({recalls:{available:false,count:null}});renderComplaints({complaints:{available:false,count:null}})');
  assert.match(els.get('#recalls-body').innerHTML,/temporarily unavailable/);assert.equal(els.get('#recall-count').textContent,'?');
  assert.match(els.get('#complaints-body').innerHTML,/temporarily unavailable/);assert.equal(els.get('#complaint-count').textContent,'?');
});
test('frontend fuel shows matched EPA variant and correct charging property',()=>{
  const {els,run}=frontend();run('renderFuel({fuel_economy:{available:true,ev_charge_time_240v:8,matched_variant:"Auto 5-spd, 6 cyl, 3.0 L"}})');
  assert.match(els.get('#fuel-body').innerHTML,/8 hr/);assert.match(els.get('#fuel-body').innerHTML,/6 cyl/);
});
test('frontend show-more label survives repeated expand/collapse',()=>{
  const {ctx}=frontend();const button={textContent:'Show 19 more',dataset:{},nextElementSibling:{hidden:true}};
  ctx.window.toggleRecalls(button);assert.equal(button.textContent,'Show less');ctx.window.toggleRecalls(button);assert.equal(button.textContent,'Show 19 more');
  ctx.window.toggleRecalls(button);assert.equal(button.textContent,'Show less');
});

test('VIN status renderer shows provider, unknown completed history and escaped Mopar summaries',()=>{
 const {els,run}=frontend();run(`renderRecalls({recalls:{available:true,count:0},recall_status:{available:true,open_count:2,completed_count:null,unknown_count:0,source:{provider:'Mopar Fleet',retrieved_at:'2026-10-24T16:00:00Z'},note:'Completed history is unknown',recalls:[{campaign_number:'S43',manufacturer_status:'Open recall',summary:'<img src=x onerror=alert(1)>'}]}})`);
 const html=els.get('#recalls-body').innerHTML;assert.match(html,/Mopar Fleet/);assert.match(html,/Unknown manufacturer-reported completed/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);
 run(`renderRecalls({recalls:{available:true,count:0},recall_status:{available:false,reason:'interactive_verification_required',note:'Toyota requires interactive verification',verification_url:'https://www.toyota.com/recall/'}})`);assert.match(els.get('#recalls-body').innerHTML,/Toyota requires interactive verification/);
});
