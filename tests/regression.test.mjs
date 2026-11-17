import test from 'node:test';
import assert from 'node:assert/strict';
import { getFuelEconomy } from '../lib/epa.mjs';
import { getRecalls, getComplaints, decodeVin, batchDecode, nhtsaDayFirstDate, relatedModelLabels, getRelatedModelRecalls, modelLabelMatch, relatedModelMatches, decodedNameForms, MAX_RELATED_LABELS } from '../lib/nhtsa.mjs';
import { lookupRecallLabels, compactName } from '../lib/recall-labels.mjs';
import { withRelatedRecalls } from '../lib/reports.mjs';
import { validateVin } from '../lib/validate.mjs';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
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
// These tests drive the FuelEconomy.gov web service path, so the local index is switched off.
const LIVE={file:'/nonexistent/fueleconomy.db'};
test.afterEach(()=>{globalThis.fetch=originalFetch;});

test('EPA picks V6 automatic, rather than first four-cylinder option',async()=>{
  const urls=[]; globalThis.fetch=async url=>{urls.push(String(url));return json(String(url).includes('menu/options')?{menuItem:options}:detail);};
  const f=await getFuelEconomy(2003,'HONDA','Accord',v6,LIVE);
  assert.equal(f.available,true); assert.equal(f.cylinders,6); assert.equal(f.vehicle_id,'18657');
  assert.equal(f.combined_mpg,22); assert.match(urls[1],/18657$/); assert.equal(f.co2_grams_per_mile,0);
});
test('EPA refuses ambiguous engine/transmission matches',async()=>{
  globalThis.fetch=async()=>json({menuItem:options});
  const f=await getFuelEconomy(2003,'Honda','Accord',{engine:{cylinders:6}},LIVE);
  assert.equal(f.available,false); assert.equal(f.reason,'ambiguous_variant');
});
test('EPA never substitutes an incompatible powertrain',async()=>{
  globalThis.fetch=async()=>json({menuItem:options});
  const f=await getFuelEconomy(2003,'Honda','Accord',{engine:{cylinders:8}},LIVE);
  assert.equal(f.reason,'no_matching_variant');
});
test('EPA rejects a detail response that disagrees with VIN engine',async()=>{
  globalThis.fetch=async url=>json(String(url).includes('menu/options')?{menuItem:options}:{...detail,cylinders:4});
  assert.equal((await getFuelEconomy(2003,'Honda','Accord',v6,LIVE)).available,false);
});
test('EPA rejects missing and wrong vehicle detail',async()=>{
  for(const body of [{},{...detail,year:2004},{...detail,make:'Toyota'}]){
    globalThis.fetch=async url=>json(String(url).includes('menu/options')?{menuItem:options}:body);
    assert.equal((await getFuelEconomy(2003,'Honda','Accord',v6,LIVE)).reason,'invalid_response');
  }
});
test('EPA identifies upstream HTTP and network errors',async()=>{
  globalThis.fetch=async()=>new Response('',{status:503});
  assert.equal((await getFuelEconomy(2003,'Honda','Accord',v6,LIVE)).reason,'upstream_error');
  globalThis.fetch=async()=>{throw new Error('offline');};
  assert.equal((await getFuelEconomy(2003,'Honda','Accord',v6,LIVE)).reason,'upstream_error');
});
test('EPA supports a single menu item object',async()=>{
  globalThis.fetch=async url=>json(String(url).includes('menu/options')?{menuItem:options[1]}:detail);
  assert.equal((await getFuelEconomy(2003,'Honda','Accord',v6,LIVE)).vehicle_id,'18657');
});
test('EPA handles EV option and zero tailpipe emissions',async()=>{
  globalThis.fetch=async url=>json(String(url).includes('menu/options')?{menuItem:{text:'Auto (A1), Electricity',value:'1'}}:{id:1,year:2024,make:'Tesla',model:'Model 3',fuelType:'Electricity',co2TailpipeGpm:0,charge240:8});
  const f=await getFuelEconomy(2024,'Tesla','Model 3',{engine:{fuel_type:'Electric'},transmission:{type:'Automatic'}},LIVE);
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
test('related NHTSA model labels: longer labels only, separate from exact campaigns, failures unknown',async()=>{
  assert.deepEqual(relatedModelLabels('CR-V',['CR-V','CR-V','CR-V HYBRID','CR-V HYBRID','CR-V FUEL CELL EV','CIVIC SEDAN','CR-VX']),['CR-V FUEL CELL EV','CR-V HYBRID']);
  assert.deepEqual(relatedModelLabels('',['CR-V HYBRID']),[]);assert.deepEqual(relatedModelLabels('CR-V',null),[]);
  const calls=[];
  globalThis.fetch=async url=>{const u=new URL(url);calls.push(u.pathname+'|'+(u.searchParams.get('model')||''));
    if(u.pathname.endsWith('/products/vehicle/models'))return json({count:3,results:[{model:'CR-V'},{model:'CR-V HYBRID'},{model:'CIVIC SEDAN'}]});
    return json({results:[{NHTSACampaignNumber:'24V744000'},{NHTSACampaignNumber:'26V366000',ReportReceivedDate:'05/06/2026'}]});};
  const r=await getRelatedModelRecalls('HONDA','CR-V',2024,[{campaign_number:'24V744000'}]);
  assert.equal(r.available,true);assert.equal(r.vin_specific,false);assert.equal(r.count,1);assert.equal(r.models[0].nhtsa_model,'CR-V HYBRID');
  assert.deepEqual(r.models[0].recalls.map(c=>c.campaign_number),['26V366000']);assert.match(r.note,/may or may not apply/);
  assert.deepEqual(calls,['/products/vehicle/models|','/recalls/recallsByVehicle|CR-V HYBRID']);
  globalThis.fetch=async url=>new URL(url).pathname.endsWith('/models')?json({results:[{model:'CR-V HYBRID'}]}):new Response('',{status:500});
  const f=await getRelatedModelRecalls('HONDA','CR-V',2024,[]);assert.equal(f.available,false);assert.equal(f.count,null);
  globalThis.fetch=async()=>json({unexpected:true});assert.equal((await getRelatedModelRecalls('HONDA','CR-V',2024,[])).available,false);
});
test('model label matching: measured NHTSA naming patterns, and the look-alikes that stay out',()=>{
  const m=(model,label,o={})=>modelLabelMatch(model,label,{make:'X',...o});
  for(const [model,label,kind] of [['CR-V','CR-V HYBRID','longer_name'],['ES','ES350','longer_name'],['C 650','C650 GT MAXI-SCOOTER','longer_name'],['F-150','F150','spelling'],['Mustang Mach-E','MUSTANG MACH E','spelling'],['Prius Prime (PHEV)','PRIUS PRIME','parenthetical'],['C-Class','C 300','family_name'],['C-Class','AMG C63','family_name'],['E-Class','E63 AMG','family_name'],['EQS-Class Sedan','EQS 450','family_name'],['Accord','accord','exact']])assert.equal(m(model,label),kind,model+' / '+label);
  for(const [model,label] of [['C-Class','CLA 250'],['S-Class','SL 450'],['EQE-Class Sedan','AMG EQE SUV 53 4MATIC'],['F-150','F-1500'],['CR-V','CR-VX'],['ProMaster 1500','1500'],['Expedition MAX','EXPEDITION'],['Golf GTI','GTI'],['Transit Connect','TRANSIT']])assert.equal(m(model,label),null,model+' / '+label);
  assert.equal(modelLabelMatch('Nissan Z','Z',{make:'NISSAN'}),'make_name');
  // Shorter or trailing labels only when NHTSA never files under the decoded name itself.
  assert.equal(m('Expedition MAX','EXPEDITION',{decodedNameUsed:false}),'shorter_name');assert.equal(m('Golf GTI','GTI',{decodedNameUsed:false}),'trailing_name');
  assert.equal(m('ProMaster 1500','1500',{decodedNameUsed:false}),null);
  assert.deepEqual(relatedModelMatches('F-150',['F-150 LIGHTNING','F150','F-150','F-250 SD']),[{label:'F-150 LIGHTNING',match:'longer_name'},{label:'F150',match:'spelling'}]);
  assert.deepEqual(decodedNameForms('Prius Prime (PHEV)'),['PRIUSPRIMEPHEV','PRIUSPRIME','PHEV']);
});
test('related labels use the local NHTSA label index when installed; partial lists say so',async()=>{
  const calls=[];
  globalThis.fetch=async url=>{const u=new URL(url);calls.push(u.searchParams.get('model')||u.pathname);
    if(u.pathname.endsWith('/products/vehicle/models'))return json({results:[{model:'4RUNNER'}]});
    return json({results:u.searchParams.get('model')==='PRIUS PRIME'?[{NHTSACampaignNumber:'19V123000'},{NHTSACampaignNumber:'18V001000'}]:[]});};
  const index=({makes,year,names})=>{assert.deepEqual(makes,['TOYOTA']);assert.equal(year,2019);assert.ok(names.includes('PRIUSPRIME'));
    return {available:true,labels:[{make:'TOYOTA',model:'PRIUS'},{make:'TOYOTA',model:'PRIUS PRIME'}],used_names:new Set(['PRIUSPRIME']),source:{latest_report_date:'2026-11-12'}};};
  let r=await getRelatedModelRecalls('TOYOTA','Prius Prime (PHEV)',2019,[{campaign_number:'18V001000'}],{labelIndex:index});
  assert.equal(r.available,true);assert.equal(r.vin_specific,false);assert.equal(r.count,1);
  assert.deepEqual(r.models,[{nhtsa_model:'PRIUS PRIME',match:'parenthetical',count:1,recalls:r.models[0].recalls}]);assert.equal(r.models[0].recalls[0].campaign_number,'19V123000');
  assert.deepEqual(r.checked_labels,['PRIUS PRIME']);assert.equal(r.label_sources.flat_file_index.latest_report_date,'2026-11-12');assert.match(r.note,/may or may not apply/);
  assert.ok(!calls.includes('PRIUS'),'PRIUS is a shorter label while NHTSA also files under PRIUS PRIME');
  // No index: the products list alone, said to be partial; shorter-name guesses stay off.
  r=await getRelatedModelRecalls('TOYOTA','Prius Prime (PHEV)',2019,[],{labelIndex:()=>({available:false,reason:'dataset_not_indexed'})});
  assert.equal(r.available,true);assert.equal(r.count,0);assert.equal(r.label_sources.flat_file_index,'not_installed');assert.match(r.note,/partial/);
  // Products reply failing is not fatal while the index answers; both failing stays unknown.
  globalThis.fetch=async url=>new URL(url).pathname.endsWith('/models')?new Response('',{status:503}):json({results:[]});
  r=await getRelatedModelRecalls('TOYOTA','Prius Prime (PHEV)',2019,[],{labelIndex:index});assert.equal(r.available,true);assert.equal(r.label_sources.products_api,'unavailable');
  r=await getRelatedModelRecalls('TOYOTA','Prius Prime (PHEV)',2019,[],{labelIndex:()=>({available:false})});assert.equal(r.available,false);assert.equal(r.count,null);
});
test('campaigns the flat-file index lists but the live API does not return are listed by number, not dropped',async()=>{
  // Live 2026-11-16: "C 300" 2017 returned no campaigns while NHTSA's flat file lists 15 under it.
  globalThis.fetch=async url=>{const u=new URL(url);if(u.pathname.endsWith('/models'))return json({results:[]});
    if(u.searchParams.get('model')==='C 300')return new Response(JSON.stringify({Count:0,Message:'Results returned successfully',results:[]}),{status:400});
    return json({results:u.searchParams.get('model')==='AMG C43'?[{NHTSACampaignNumber:'17V243000'}]:[]});};
  const index=()=>({available:true,source:{latest_report_date:'2026-11-12'},used_names:new Set(),labels:[
    {make:'MERCEDES-BENZ',model:'C 300',campaign_numbers:['17V114000','17V243000']},{make:'MERCEDES-BENZ',model:'AMG C43',campaign_numbers:['17V243000']},
    {make:'MERCEDES-BENZ',model:'C-CLASS',campaign_numbers:['17V900000']},{make:'MERCEDES-BENZ',model:'CLA250',campaign_numbers:['17V555000']}]});
  const r=await getRelatedModelRecalls('MERCEDES-BENZ','C-Class',2017,[],{labelIndex:index});
  assert.equal(r.count,1);assert.equal(r.models[0].nhtsa_model,'AMG C43');
  assert.deepEqual(r.flat_file_only.campaigns,[{campaign_number:'17V900000',nhtsa_model:'C-CLASS',match:'exact'},{campaign_number:'17V114000',nhtsa_model:'C 300',match:'family_name'}]);
  assert.equal(r.flat_file_only.count,2);assert.match(r.flat_file_only.note,/may or may not apply/);assert.equal(r.decoded_name_in_recall_data,false);
  const out=withRelatedRecalls({available:true,count:0,recalls:[]},r);
  assert.equal(out.count,0);assert.equal(out.related_campaigns_found,true);assert.match(out.count_note,/1 more campaign .* lists 2 more/);
  // Only flat-file campaigns: still flagged, never counted as exact.
  const only=withRelatedRecalls({available:true,count:0,recalls:[]},{available:true,count:0,models:[],flat_file_only:{count:1,campaigns:[]}});
  assert.equal(only.related_campaigns_found,true);assert.equal(only.count,0);assert.doesNotMatch(only.count_note,/related model names \(related_models\)/);
  // A decoded name NHTSA never files under, with nothing related found: say so instead of a clean zero.
  const unused=withRelatedRecalls({available:true,count:0,recalls:[]},{available:true,count:0,models:[],flat_file_only:{count:0,campaigns:[]},decoded_name_in_recall_data:false});
  assert.equal(unused.related_campaigns_found,false);assert.match(unused.count_note,/no campaign filed under this exact model name/);
});
test('related labels past the cap are listed as unchecked, not dropped',async()=>{
  const labels=Array.from({length:MAX_RELATED_LABELS+3},(_,i)=>({make:'MERCEDES-BENZ',model:`E ${300+i*10}`}));let lookups=0;
  globalThis.fetch=async url=>{const u=new URL(url);if(u.pathname.endsWith('/models'))return json({results:[]});lookups++;return json({results:[{NHTSACampaignNumber:'20V'+u.searchParams.get('model').slice(2)+'000'}]});};
  const r=await getRelatedModelRecalls('MERCEDES-BENZ','E-Class',2018,[],{labelIndex:()=>({available:true,labels,used_names:new Set(),source:{}})});
  assert.equal(lookups,MAX_RELATED_LABELS);assert.equal(r.checked_labels.length,MAX_RELATED_LABELS);assert.equal(r.unchecked_labels.length,3);
  assert.ok(r.models.every(x=>x.match==='family_name'));assert.match(r.note,/3 more related model names were not checked/);
});
test('an exact-label zero keeps its count but says when related labels carry campaigns or could not be checked',()=>{
  const exact={available:true,count:0,recalls:[],scope:'make_model_year'};
  let r=withRelatedRecalls(exact,{available:true,count:3,models:[]});
  assert.equal(r.count,0);assert.equal(r.related_campaigns_found,true);assert.match(r.count_note,/^No campaigns are filed under the exact decoded model name\. NHTSA files 3 more campaigns/);assert.match(r.count_note,/may or may not apply/);
  r=withRelatedRecalls({...exact,count:2},{available:true,count:1,models:[]});assert.equal(r.count,2);assert.match(r.count_note,/^2 campaigns are .* 1 more campaign for/);
  r=withRelatedRecalls(exact,{available:false,count:null,models:[]});assert.equal(r.count,0);assert.equal(r.related_campaigns_found,null);assert.match(r.count_note,/could not be checked/);
  r=withRelatedRecalls(exact,{available:true,count:0,models:[]});assert.equal(r.related_campaigns_found,false);assert.equal(r.count_note,null);
});
test('label index reader: labels for a make and year, names used in any year, missing file unknown',()=>{
  const dir=mkdtempSync(join(tmpdir(),'labels-')),file=join(dir,'recall-labels.db');
  try{
    assert.deepEqual(lookupRecallLabels({makes:['HONDA'],year:2024},file),{available:false,reason:'dataset_not_indexed'});
    const db=new Database(file);db.exec('CREATE TABLE labels(make TEXT,model TEXT,year INTEGER,campaigns INTEGER,compact TEXT,campaign_numbers TEXT);CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);');
    for(const r of [['HONDA','CR-V',2024,2,'24V508000 24V744000'],['HONDA','CR-V HYBRID',2024,4,'24V744000 24V763000 26V366000 26V663000'],['HONDA','CR-V HYBRID',2020,1,'20V001000'],['HONDA','ACCORD',2023,1,'23V001000'],['TOYOTA','PRIUS',2024,1,'24V001000']])db.prepare('INSERT INTO labels VALUES(?,?,?,?,?,?)').run(...r.slice(0,4),compactName(r[1]),r[4]);
    db.prepare('INSERT INTO metadata VALUES(?,?)').run('source',JSON.stringify({latest_report_date:'2026-11-12',indexed_at:'2026-11-16T23:00:00Z'}));db.close();
    const r=lookupRecallLabels({makes:['honda'],year:2024,names:['CRVHYBRID','ACCORD','PILOT']},file);
    assert.deepEqual(r.labels.map(l=>l.model),['CR-V','CR-V HYBRID']);assert.deepEqual(r.labels[1].campaign_numbers,['24V744000','24V763000','26V366000','26V663000']);assert.deepEqual([...r.used_names].sort(),['ACCORD','CRVHYBRID']);assert.equal(r.source.latest_report_date,'2026-11-12');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('NHTSA HTTP 400 empty-success body is zero campaigns; other 400s stay unavailable',async()=>{
  const body=b=>async()=>new Response(JSON.stringify(b),{status:400,headers:{'content-type':'application/json'}});
  globalThis.fetch=body({Count:0,Message:'Results returned successfully',results:[]});
  let r=await getRecalls('Honda','Accord Sedan',2024);assert.equal(r.available,true);assert.equal(r.count,0);assert.equal(r.vin_specific,false);
  for(const b of [{Count:0,Message:'Invalid parameters',results:[]},{Count:1,Message:'Results returned successfully',results:[]},{Count:0,Message:'Results returned successfully',results:[{}]},{Count:0,Message:'Results returned successfully'}]){
    globalThis.fetch=body(b);r=await getRecalls('Honda','Accord',2024);assert.equal(r.available,false);assert.equal(r.count,null);
  }
  globalThis.fetch=async()=>new Response('<h1>Bad Request</h1>',{status:400});r=await getRecalls('Honda','Accord',2024);assert.equal(r.available,false);
  globalThis.fetch=async()=>new Response(JSON.stringify({Count:0,Message:'Results returned successfully',results:[]}),{status:500});r=await getRecalls('Honda','Accord',2024);assert.equal(r.available,false);
});
test('NHTSA day-first report dates become ISO and campaign advisories stay unknown when absent',async()=>{
  globalThis.fetch=async()=>json({results:[
    {NHTSACampaignNumber:'24V763000',ReportReceivedDate:'15/10/2024',parkIt:true,parkOutSide:false,overTheAirUpdate:false},
    {NHTSACampaignNumber:'18V204000',ReportReceivedDate:'04/10/2024'},
    {NHTSACampaignNumber:'X',ReportReceivedDate:'2024-10-15',parkIt:'Yes'}]});
  const r=await getRecalls('Honda','CR-V Hybrid',2024);
  assert.equal(r.recalls[0].report_received_date,'2024-10-15');assert.equal(r.recalls[0].report_date,'15/10/2024');
  assert.equal(r.recalls[0].park_it,true);assert.equal(r.recalls[0].park_outside,false);assert.equal(r.recalls[0].over_the_air_update,false);
  assert.equal(r.recalls[1].report_received_date,'2024-10-04');assert.equal(r.recalls[1].park_it,null);assert.equal(r.recalls[1].park_outside,null);
  assert.equal(r.recalls[2].report_received_date,null);assert.equal(r.recalls[2].park_it,null);
  for(const v of ['31/02/2024','32/01/2024','01/13/2024','1/2/2024',null,'01/01/1900'])assert.equal(nhtsaDayFirstDate(v),null);
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
  const els=new Map();const element=()=>({style:{},dataset:{},handlers:{},value:'',classList:{add(){},remove(){},toggle(){}},addEventListener(k,fn){this.handlers[k]=fn;},dispatchEvent(e){return this.handlers[e.type]?.(e);},setAttribute(){},focus(){},setSelectionRange(){},querySelector(){return element();},querySelectorAll(){return [];},replaceChildren(){this.innerHTML='';},innerHTML:'',textContent:'',hidden:false});
  const document={createElement:()=>({set textContent(v){this.innerHTML=String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');}}),querySelector:s=>{if(!els.has(s))els.set(s,element());return els.get(s);},querySelectorAll:()=>[],addEventListener(){}};
  const ctx={document,window:{location:{pathname:'/'}},navigator:{},localStorage:{getItem(){return null;}},console,fetch:async()=>new Response('{}'),setTimeout(){},addEventListener(){}};
  vm.createContext(ctx);vm.runInContext(readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),ctx);
  return {ctx,els,run:script=>vm.runInContext(script,ctx)};
}
test('frontend displays unavailable recalls and complaints without zero/safe badges',()=>{
  const {els,run}=frontend();run('renderRecalls({recalls:{available:false,count:null}});renderComplaints({complaints:{available:false,count:null}})');
  assert.match(els.get('#recalls-body').innerHTML,/temporarily unavailable/);assert.equal(els.get('#recall-count').textContent,'?');
  assert.match(els.get('#complaints-body').innerHTML,/temporarily unavailable/);assert.equal(els.get('#complaint-count').textContent,'?');
});

test('frontend shows related-label campaigns apart, as may or may not apply, without a green zero',()=>{
  const {els,run}=frontend();
  const related={available:true,count:2,unchecked_labels:['C 400'],models:[{nhtsa_model:'C 300',match:'family_name',count:2,recalls:[{campaign_number:'24V001000',component:'AIR BAGS',summary:'<img src=x onerror=alert(1)>'},{campaign_number:'24V002000',component:'FUEL SYSTEM',summary:'Leak'}]}]};
  run(`renderRecalls({recalls:${JSON.stringify({available:true,count:0,recalls:[],related_campaigns_found:true,related_models:related})}})`);
  let html=els.get('#recalls-body').innerHTML;
  assert.match(html,/No campaigns are filed under this exact make, model and year/);assert.match(html,/<h3>Related model names · 2 campaigns<\/h3>/);
  assert.match(html,/may or may not apply to this vehicle/);assert.match(html,/NHTSA model name: C 300 \(model within the family\)/);assert.match(html,/24V002000/);
  assert.match(html,/1 more related model name was not checked/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);
  assert.equal(els.get('#recall-count').textContent,'0');assert.doesNotMatch(els.get('#recall-count').className,/green/);
  // Exact campaigns keep their own list and count; related ones follow under their own heading.
  run(`renderRecalls({recalls:${JSON.stringify({available:true,count:1,recalls:[{campaign_number:'24V744000',component:'ELECTRICAL'}],related_campaigns_found:true,related_models:related})}})`);
  html=els.get('#recalls-body').innerHTML;assert.equal(els.get('#recall-count').textContent,1);assert.ok(html.indexOf('24V744000')<html.indexOf('Related model names'));
  run(`renderRecalls({recalls:{available:true,count:0,recalls:[],related_campaigns_found:null,related_models:{available:false,count:null,models:[]}}})`);
  assert.match(els.get('#recalls-body').innerHTML,/could not be checked/);assert.doesNotMatch(els.get('#recall-count').className,/green/);
  run(`renderRecalls({recalls:{available:true,count:0,recalls:[],related_campaigns_found:false,related_models:{available:true,count:0,models:[]}}})`);
  assert.match(els.get('#recall-count').className,/green/);assert.doesNotMatch(els.get('#recalls-body').innerHTML,/Related model names/);
  // Campaigns only in NHTSA's flat file are shown by number under the related heading.
  run(`renderRecalls({recalls:{available:true,count:0,recalls:[],related_campaigns_found:true,related_models:{available:true,count:0,models:[],flat_file_only:{count:1,campaigns:[{campaign_number:'17V114000',nhtsa_model:'C 300',match:'family_name'}]}}}})`);
  html=els.get('#recalls-body').innerHTML;assert.match(html,/Related model names · 1 campaign</);assert.match(html,/17V114000 \(filed as C 300\)/);assert.match(html,/not returned by NHTSA's live lookup/);
  // A model name NHTSA never files under: no green zero.
  run(`renderRecalls({recalls:{available:true,count:0,recalls:[],related_campaigns_found:false,related_models:{available:true,count:0,models:[],decoded_name_in_recall_data:false}}})`);
  assert.doesNotMatch(els.get('#recall-count').className,/green/);assert.match(els.get('#recalls-body').innerHTML,/never filed a recall under this model name/);
});

test('editing VIN input invalidates a pending decode and prevents stale results',async()=>{
  const {ctx,els,run}=frontend();let resolve;
  ctx.fetch=()=>new Promise(r=>resolve=r);
  els.get('#vin-input').value='1N4AL3APXFN868842';
  const request=els.get('#vin-form').handlers.submit({preventDefault(){}});
  els.get('#vin-input').value='4T1BF1FK0CU123456';
  els.get('#vin-input').handlers.input();
  resolve(json({valid:true,vin:'1N4AL3APXFN868842',vehicle:{year:2015,make:'NISSAN',model:'Altima'}}));
  await request;
  assert.equal(run('currentReport'),null);assert.equal(els.get('#results').hidden,true);
});

test('a VIN URL loads context without overriding a selected research view',()=>{
  const {ctx,els,run}=frontend();let submitted;
  ctx.CustomEvent=class {constructor(type,options){this.type=type;this.detail=options.detail;}};
  ctx.window.location.pathname='/1N4AL3APXFN868842';
  els.get('#vin-form').dispatchEvent=e=>submitted=e;
  run('checkUrlVin()');
  assert.equal(els.get('#vin-input').value,'1N4AL3APXFN868842');
  assert.equal(submitted.type,'submit');assert.equal(submitted.detail.preserveView,true);
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

test('VIN status renderer distinguishes GM repair and closure dates and shows separate programs safely',()=>{
 const {els,run}=frontend();run(`renderRecalls({recalls:{available:true,count:0},recall_status:{available:true,open_count:0,completed_count:2,source:{provider:'GM',retrieved_at:'2026-10-24T18:00:00Z'},note:'Closure is not necessarily repair',recalls:[{campaign_number:'GM-1',manufacturer_status:'complete',record_kind:'safety_recall',summary:'Safety issue',completion_description:'Dealer Repaired',repair_completed_at:'2024-02-01',manufacturer_closed_at:'2024-02-03'},{campaign_number:'GM-2',manufacturer_status:'complete',summary:'Other issue',completion_description:'Manual Complete - OTHER',manufacturer_closed_at:'2025-03-01'}],service_campaigns:[{campaign_number:'PROGRAM',manufacturer_status:'incomplete',record_kind:'customer_satisfaction',summary:'<img src=x>'}]}})`);
 const html=els.get('#recalls-body').innerHTML;assert.match(html,/0 open recalls/);assert.match(html,/2 manufacturer-reported completed\/closed/);assert.match(html,/Reported repair date:<\/span> 2024-02-01/);assert.match(html,/Manufacturer closing date:<\/span> 2024-02-03/);assert.equal((html.match(/Reported repair date:/g)||[]).length,1);assert.match(html,/Manual Complete - OTHER/);assert.match(html,/Other manufacturer programs · 1/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);
});
