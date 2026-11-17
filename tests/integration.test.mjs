import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, symlink, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { validateVin } from '../lib/validate.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const stage=await mkdtemp(path.join(tmpdir(),'vin-mcp-tests-'));
for(const f of ['server.mjs','package.json','lib','public','tests/mock-upstream.mjs','tests/mopar-fixture.mjs','tests/manufacturer-fixtures.mjs'])await cp(path.join(root,f),path.join(stage,f),{recursive:true});
await symlink(path.join(root,'node_modules'),path.join(stage,'node_modules'),'dir');
// Fixture tire placard index (built by the real import script): one NHTSA test vehicle for the mock HONDA Accord 2003.
{const {mkdir}=await import('node:fs/promises');const {spawnSync}=await import('node:child_process');await mkdir(path.join(stage,'data'),{recursive:true});
 const src=path.join(stage,'data','tire-placards-fixture.jsonl');
 await writeFile(src,JSON.stringify({make:'HONDA',model:'Accord',model_year:2003,tested_as:'2003 Honda Accord fixture sedan',tires:{front:'P205/65R15 92V',rear:'P205/65R15 92V'},cold_pressure_kpa:{front:220,rear:220},cold_pressure_psi:{front:32,rear:32},test_no:1,report_url:'https://nrd-static.nhtsa.dot.gov/reports/vehdb/fixture.pdf',confidence:'normal',other_reports:[],powertrain:'not_battery_electric'})+'\n');
 const specs=path.join(stage,'data','test-vehicle-specs-fixture.jsonl');
 await writeFile(specs,JSON.stringify({make:'HONDA',model:'Accord',model_year:2003,tested_as:'2003 Honda Accord fixture sedan',powertrain:'not_battery_electric',fuel_type:'Gasoline',test_no:1,report_url:'https://nrd-static.nhtsa.dot.gov/reports/vehdb/fixture.pdf',
  fuel_tank_standard:{litres:64.7,printed:64.7,unit_printed:'L',method:'fixture'},vehicle_capacity_weight_kg:385,seating:{front:2,rear:3,third:0,total:5},gvwr:{value:1950,unit_printed:'kg'},curb_weight_kg:{front:900,rear:550,total:1450}})+'\n');
 const code="import importlib.util,sys;s=importlib.util.spec_from_file_location('i',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.build(sys.argv[2],sys.argv[3],None,sys.argv[4])";
 const run=spawnSync('python3',['-c',code,path.join(root,'scripts/import-tire-placards.py'),src,path.join(stage,'data','tire-placards.db'),specs],{encoding:'utf8'});if(run.status!==0)throw Error(run.stderr);}
const port=23291, base=`http://127.0.0.1:${port}`;
const env={...process.env,JWT_SECRET:'isolated-test-secret',ADMIN_KEY:'a'.repeat(64),NODE_ENV:'production'};
const child=spawn(process.execPath,['--import',path.join(stage,'tests/mock-upstream.mjs'),path.join(stage,'server.mjs'),'--http','--port',String(port)],{cwd:stage,env,stdio:['ignore','ignore','pipe']});
let stderr='';child.stderr.on('data',b=>stderr+=b);
test.after(async()=>{child.kill();await new Promise(resolve=>child.once('exit',resolve));await rm(stage,{recursive:true,force:true});});
for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));if(i===99)throw Error(stderr);}
const req=async(url,body,token,method)=>fetch(base+url,{method:method||(body===undefined?'GET':'POST'),headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
let token, saved;
const vin='1HGCM82633A004352';
test('REST full report selects matching fuel and caches engine variants separately',async()=>{
  const r=await(await req('/api/vin/'+vin)).json();assert.equal(r.engine.cylinders,6);assert.equal(r.fuel_economy.cylinders,6);assert.equal(r.fuel_economy.combined_mpg,22);
  let other='1HGCM82633A004353';other=other.slice(0,8)+validateVin(other).checksum.expected+other.slice(9);
  const r2=await(await req('/api/vin/'+other)).json();assert.equal(r2.engine.cylinders,4);assert.equal(r2.fuel_economy.cylinders,4);assert.equal(r2.fuel_economy.combined_mpg,25);
});
test('REST and MCP reports carry the NHTSA test-vehicle blocks with the match stated',async()=>{
  const r=await(await req('/api/vin/'+vin)).json();const t=r.tire_placard,s=r.test_vehicle_specs;
  assert.equal(t.available,true);assert.equal(t.scope,'nhtsa_test_vehicle');assert.equal(t.vin_specific,false);assert.match(t.note,/your own door placard governs/i);assert.equal(t.match_kind,'exact');
  assert.deepEqual(t.vehicles.map(v=>[v.model_year,v.make,v.model,v.tested_as,v.tires.front,v.cold_pressure_psi.front,v.cold_pressure_kpa.rear,v.test_no,v.confidence,v.match.kind]),[[2003,'HONDA','Accord','2003 Honda Accord fixture sedan','P205/65R15 92V',32,220,1,'normal','exact']]);
  assert.equal(s.available,true);assert.equal(s.match_kind,'exact');assert.equal(s.vehicles[0].test_no,1);assert.deepEqual(s.vehicles[0].payload_vehicle_capacity_weight,{kg:385,lb:849});
  // The mock decode gives no fuel type, so the VIN's electrification is unknown: the strict guard shows no tank.
  assert.equal(s.fuel_tank.shown,false);assert.equal(s.fuel_tank.reason,'different_electrification');
  let toyota='4T1BF1FK0CU123456';toyota=toyota.slice(0,8)+validateVin(toyota).checksum.expected+toyota.slice(9);
  const none=(await(await req('/api/vin/'+toyota)).json());assert.equal(none.tire_placard.available,true);assert.deepEqual(none.tire_placard.vehicles,[]);assert.equal(none.tire_placard.reason,'no_close_match');
  assert.equal(none.test_vehicle_specs.reason,'no_close_match');
  const client=new Client({name:'placard-check',version:'1'}),transport=new StreamableHTTPClientTransport(new URL(base+'/mcp'));
  try{await client.connect(transport);const m=JSON.parse((await client.callTool({name:'decode_vin',arguments:{vin}})).content[0].text);
    assert.deepEqual(m.tire_placard,t);assert.deepEqual(m.test_vehicle_specs,s);}finally{await transport.terminateSession();await client.close();}
});
test('placard corrections: validated, stored for review with the VIN prefix only, listed for the admin, never shown, rate limited',async()=>{
  const post=body=>req('/api/placard-corrections',body);
  let res=await post({vin,tire_front:'<script>alert(1)</script>'});assert.equal(res.status,400);assert.match((await res.json()).error,/Front tire size/);
  res=await post({vin:'NOT-A-VIN',psi_front:32});assert.equal(res.status,400);assert.match((await res.json()).error,/valid VIN/);
  res=await post({vin,psi_front:500,note:'x'.repeat(10)});assert.equal(res.status,400);assert.match((await res.json()).error,/from 10 to 120/);
  res=await post({vin,tire_front:'P205/65R15 92V',psi_front:32,psi_rear:'30',fuel_tank:'17.1',fuel_tank_unit:'gal',note:'Door says 32/30.\u0007\n',ip:'203.0.113.9',user:'someone'});
  assert.equal(res.status,201);assert.deepEqual(await res.json(),{ok:true,message:'Thanks. We review corrections before using them.'});
  assert.equal((await req('/api/admin/placard-corrections')).status,403);
  const list=await(await fetch(base+'/api/admin/placard-corrections',{headers:{'x-admin-key':'a'.repeat(64)}})).json();
  assert.equal(list.count,1);const c=list.corrections[0];
  assert.deepEqual([c.vin_prefix,c.model_year,c.make,c.model,c.tire_front,c.tire_rear,c.psi_front,c.psi_rear,c.fuel_tank,c.fuel_tank_unit,c.note],
    [vin.slice(0,11),2003,'HONDA','Accord','P205/65R15 92V',null,32,30,17.1,'gal','Door says 32/30.']);
  assert.deepEqual(c.shown.tire_placard,{match_kind:'exact',reason:null,vehicles:[{test_no:1,model_year:2003,match_kind:'exact'}]});
  assert.equal(c.shown.test_vehicle_specs.vehicles[0].test_no,1);assert.ok(c.created_at);
  // No IP address, no account, no full VIN is stored.
  const stored=JSON.stringify(list);assert.doesNotMatch(stored,/203\.0\.113\.9|127\.0\.0\.1|someone/);assert.ok(!stored.includes(vin));assert.ok(!('ip' in c));
  // Never shown to other readers and never changes a value.
  assert.equal((await(await req('/api/vin/'+vin)).json()).tire_placard.vehicles[0].cold_pressure_psi.front,32);
  // Rate limited like the other POSTs (5 a minute).
  res=await post({vin});assert.equal(res.status,400);
  res=await post({vin,psi_front:33});assert.equal(res.status,429);
});
test('registration, login and identity still work',async()=>{
 let res=await req('/api/auth/register',{email:'isolated@example.invalid',password:'fixture-password',display_name:'Test'});assert.equal(res.status,201);token=(await res.json()).token;
 res=await req('/api/auth/login',{email:'isolated@example.invalid',password:'fixture-password'});assert.equal(res.status,200);
 assert.equal((await(await req('/api/auth/me',undefined,token)).json()).display_name,'Test');
});
test('an account can be deleted with its password, and its data goes with it',async()=>{
 const del=(body,t)=>fetch(base+'/api/auth/account',{method:'DELETE',headers:{'content-type':'application/json',...(t?{authorization:'Bearer '+t}:{})},body:JSON.stringify(body)});
 const creds={email:'delete-me@example.invalid',password:'fixture-password'};
 let res=await req('/api/auth/register',creds);assert.equal(res.status,201);const t=(await res.json()).token;
 assert.equal((await del({password:'fixture-password'})).status,401);
 assert.equal((await del({},t)).status,400);
 assert.equal((await del({password:'not-the-password'},t)).status,401);
 assert.equal((await(await req('/api/auth/me',undefined,t)).json()).email,creds.email);
 res=await del({password:'fixture-password'},t);assert.equal(res.status,200);assert.deepEqual(await res.json(),{deleted:true});
 assert.equal((await req('/api/auth/me',undefined,t)).status,404);
 assert.equal((await req('/api/auth/login',creds)).status,401);
});
test('a VIN URL is served with that vehicle in the page head, and bad VINs are not indexable',async()=>{
 let res=await fetch(base+'/'+vin);assert.equal(res.status,200);let html=await res.text();
 assert.match(html,new RegExp('<link rel="canonical" href="https://mcp.vin/'+vin+'">'));assert.match(html,/id="ssr-summary"/);assert.match(html,new RegExp('<title>[^<]*VIN '+vin));
 res=await fetch(base+'/'+vin.toLowerCase(),{redirect:'manual'});assert.equal(res.status,301);assert.equal(res.headers.get('location'),'/'+vin);
 res=await fetch(base+'/1HGCM82633A00435X');assert.equal(res.status,200);html=await res.text();assert.match(html,/<meta name="robots" content="noindex">/);assert.equal(html.includes('ssr-summary"'),false);
});
test('REST full reports retry an invalid EPA response and cache the recovered report',async()=>{
 let candidate='1HGCM82633A004354';candidate=candidate.slice(0,8)+validateVin(candidate).checksum.expected+candidate.slice(9);
 const first=await(await req('/api/vin/'+candidate)).json();assert.equal(first.fuel_economy.reason,'invalid_response');
 const retry=await(await req('/api/vin/'+candidate)).json();assert.equal(retry.fuel_economy.available,true);assert.equal(retry.fuel_economy.combined_mpg,22);
 const cached=await(await req('/api/vin/'+candidate)).json();assert.equal(cached.provenance.assembled_at,retry.provenance.assembled_at);
});
test('MCP full reports also recover after malformed EPA detail',async()=>{
 let candidate='1HGCM82633A004355';candidate=candidate.slice(0,8)+validateVin(candidate).checksum.expected+candidate.slice(9);
 const client=new Client({name:'epa-recovery-test',version:'1'}),transport=new StreamableHTTPClientTransport(new URL(base+'/mcp'));
 try{await client.connect(transport);
  const first=await client.callTool({name:'decode_vin',arguments:{vin:candidate}});assert.equal(JSON.parse(first.content[0].text).fuel_economy.reason,'invalid_response');
  const retry=await client.callTool({name:'decode_vin',arguments:{vin:candidate}});assert.equal(JSON.parse(retry.content[0].text).fuel_economy.available,true);
 }finally{await transport.terminateSession();await client.close();}
});
test('saved VIN create, list, label edit and delete still work',async()=>{
 let res=await req('/api/user/vins',{vin,label:'Fixture'},token);assert.equal(res.status,201);saved=(await res.json()).id;
 let list=await(await req('/api/user/vins',undefined,token)).json();assert.equal(list.length,1);assert.equal(list[0].vin,vin);
 assert.equal((await req('/api/user/vins/'+saved,{label:'Edited'},token,'PUT')).status,200);
 list=await(await req('/api/user/vins',undefined,token)).json();assert.equal(list[0].label,'Edited');
});
test('all preference fields remain available',async()=>{
 const prefs=await(await req('/api/user/preferences',undefined,token)).json();assert.equal(prefs.show_overview,1);
 const res=await req('/api/user/preferences',{show_engine:false,show_photos:false},token,'PUT');assert.equal(res.status,200);assert.equal((await res.json()).show_engine,0);
});
test('invalid saved VINs are rejected without changing the collection',async()=>{
 const before=await(await req('/api/user/vins',undefined,token)).json();
 for(const bad of ['short','1HGCM82633A004353',{vin}]) {
  const res=await req('/api/user/vins',{vin:bad,label:'Invalid fixture'},token);
  assert.equal(res.status,400);assert.match((await res.json()).error,/valid VIN/);
 }
 const client=new Client({name:'saved-validation-check',version:'1'}),transport=new StreamableHTTPClientTransport(new URL(base+'/mcp'));
 try {
  await client.connect(transport);
  const result=await client.callTool({name:'save_vin',arguments:{user_token:token,vin:'short'}});
  assert.equal(result.isError,true);assert.match(result.content[0].text,/valid VIN/);
 }finally{await transport.terminateSession();await client.close();}
 assert.deepEqual(await(await req('/api/user/vins',undefined,token)).json(),before);
});
test('specialized VIN endpoints reject invalid VINs consistently',async()=>{
 for(const part of ['recalls','complaints','safety','fuel','photo']) {
  const res=await req('/api/vin/short/'+part);assert.equal(res.status,400);assert.match((await res.json()).error,/valid VIN/);
 }
});
test('grouped tool directory matches registered MCP tools and mutation hints',async()=>{
 const directory=await(await req('/api/tools')).json();assert.equal(directory.groups.length,3);
 const client=new Client({name:'registry-check',version:'1'}),transport=new StreamableHTTPClientTransport(new URL(base+'/mcp'));
 try {
  await client.connect(transport);const {tools}=await client.listTools();
  assert.deepEqual(directory.groups.flatMap(g=>g.tools.map(t=>t.name)).sort(),tools.map(t=>t.name).sort());
  assert.equal(tools.find(t=>t.name==='decode_vin').annotations.readOnlyHint,true);
  assert.equal(tools.find(t=>t.name==='save_vin').annotations.readOnlyHint,false);
  assert.equal(tools.find(t=>t.name==='remove_saved_vin').annotations.destructiveHint,true);
  const invalid=await client.callTool({name:'lookup_recalls',arguments:{vin:'short'}});assert.equal(invalid.isError,true);
 }finally{await transport.terminateSession();await client.close();}
});
test('REST endpoints, direct VIN page and educational pages remain available',async()=>{
 for(const endpoint of ['/health','/api/status','/'+vin,'/free-vin-check/','/vin-decoder-api/','/vehicle-safety-recalls/','/vehicle-history-reports/','/app.js','/style.css'])assert.equal((await req(endpoint)).status,200,endpoint);
 for(const part of ['validate','recalls','complaints','safety','fuel'])assert.equal((await req(`/api/vin/${vin}/${part}`)).status,200,part);
 const recalls=await(await req(`/api/vin/${vin}/recalls`)).json();assert.equal(recalls.count,0);assert.equal(recalls.related_models.available,true);
 assert.equal(recalls.related_campaigns_found,false);assert.equal(recalls.related_models.label_sources.flat_file_index,'not_installed');
 const photo=await fetch(base+`/api/vin/${vin}/photo`,{redirect:'manual'});assert.equal(photo.status,302);
});
test('bad JSON and malformed batches return JSON errors',async()=>{
 let res=await fetch(base+'/api/batch',{method:'POST',headers:{'Content-Type':'application/json'},body:'{bad'});assert.equal(res.status,400);assert.equal((await res.json()).error,'Invalid JSON body');
 res=await req('/api/batch',{vins:[null]});assert.equal(res.status,400);
 res=await req('/api/batch',{vins:[vin]});assert.equal(res.status,200);assert.equal((await res.json()).count,1);
});
test('admin rejects multibyte key without crashing',async()=>{
 const res=await fetch(base+'/api/admin/system',{headers:{'x-admin-key':'é'.repeat(64)}});assert.equal(res.status,403);
});
test('remote MCP initializes, lists all twenty-two tools, validates, decodes and updates preferences',async()=>{
 const client=new Client({name:'isolated-http-check',version:'1'});const transport=new StreamableHTTPClientTransport(new URL(base+'/mcp'));
 try{
 await client.connect(transport);const list=await client.listTools();assert.equal(list.tools.length,22);
 const status=await(await req('/api/status')).json();assert.deepEqual(status.tools.toSorted(),list.tools.map(t=>t.name).toSorted());
 let r=await client.callTool({name:'validate_vin',arguments:{vin}});assert.equal(JSON.parse(r.content[0].text).valid,true);
 r=await client.callTool({name:'decode_vin',arguments:{vin}});assert.equal(JSON.parse(r.content[0].text).fuel_economy.cylinders,6);assert.equal(JSON.parse(r.content[0].text).raw_nhtsa,undefined);
 r=await client.callTool({name:'update_output_preferences',arguments:{user_token:token,show_engine:true}});assert.equal(r.isError,undefined);
 r=await client.callTool({name:'get_output_preferences',arguments:{user_token:token}});assert.equal(JSON.parse(r.content[0].text).show_engine,1);
 r=await client.callTool({name:'list_saved_vins',arguments:{user_token:token}});assert.equal(JSON.parse(r.content[0].text).length,1);
 r=await client.callTool({name:'lookup_recalls',arguments:{make:'Honda',model:'Accord',year:2003}});assert.equal(JSON.parse(r.content[0].text).vin_specific,false);assert.equal(JSON.parse(r.content[0].text).related_models.vin_specific,false);
 r=await client.callTool({name:'batch_decode',arguments:{vins:[]}});assert.equal(r.isError,true);
 }finally{await transport.terminateSession();await client.close();}
});
test('stale MCP sessions get 404 and browser clients can read session IDs',async()=>{
 let res=await fetch(base+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-session-id':'expired-fixture'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});assert.equal(res.status,404);
 res=await fetch(base+'/health',{headers:{Origin:'https://mcp.vin'}});assert.match(res.headers.get('access-control-expose-headers'),/Mcp-Session-Id/);
});
test('stdio MCP supports authenticated preference updates without ReferenceError',async()=>{
 const client=new Client({name:'isolated-stdio-check',version:'1'});
 const transport=new StdioClientTransport({command:process.execPath,args:['--import',path.join(stage,'tests/mock-upstream.mjs'),path.join(stage,'server.mjs')],cwd:stage,env,stderr:'pipe'});
 try{await client.connect(transport);assert.equal((await client.listTools()).tools.length,22);
 const r=await client.callTool({name:'update_output_preferences',arguments:{user_token:token,show_photos:true}});assert.equal(r.isError,undefined);assert.match(r.content[0].text,/updated/);
 }finally{await client.close();}
});
test('OAuth discovery, consent, PKCE exchange and refresh client binding',async()=>{
 assert.equal((await(await req('/.well-known/oauth-authorization-server')).json()).issuer,'https://mcp.vin');
 const registered=await(await req('/oauth/register',{client_name:'Isolated fixture',redirect_uris:['http://127.0.0.1/callback'],token_endpoint_auth_method:'none'})).json();
 const verifier='test-verifier-'.repeat(4),challenge=crypto.createHash('sha256').update(verifier).digest('base64url');
 const params=new URLSearchParams({client_id:registered.client_id,redirect_uri:'http://127.0.0.1/callback',code_challenge:challenge,code_challenge_method:'S256',response_type:'code'});
 let res=await req('/oauth/authorize?'+params);assert.equal(res.status,200);const html=await res.text();const csrf=html.match(/name="csrf" value="([^"]+)"/)[1];
 res=await fetch(base+'/oauth/approve',{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...Object.fromEntries(params),csrf})});assert.equal(res.status,302);const code=new URL(res.headers.get('location')).searchParams.get('code');
 res=await req('/oauth/token',{grant_type:'authorization_code',client_id:registered.client_id,redirect_uri:'http://127.0.0.1/callback',code,code_verifier:verifier});assert.equal(res.status,200);const grant=await res.json();assert.ok(grant.access_token);
 res=await req('/oauth/token',{grant_type:'refresh_token',client_id:'wrong-client',refresh_token:grant.refresh_token});assert.equal(res.status,400);
 res=await req('/oauth/token',{grant_type:'refresh_token',client_id:registered.client_id,refresh_token:grant.refresh_token});assert.equal(res.status,200);
});
test('saved VIN removal remains user-scoped',async()=>{assert.equal((await req('/api/user/vins/'+saved,undefined,token,'DELETE')).status,200);assert.deepEqual(await(await req('/api/user/vins',undefined,token)).json(),[]);});

test('auth rejects structured fields without a server error',async()=>{
 for(const endpoint of ['/api/auth/register','/api/auth/login']){
  const res=await req(endpoint,{email:{invalid:true},password:['invalid']});assert.equal(res.status,400);
 }
});
test('batch limits still reject excessive requests within their own route',async()=>{
 let limited=false;for(let i=0;i<6;i++){const res=await req('/api/batch',{vins:[null]});if(res.status===429)limited=true;}
 assert.equal(limited,true);assert.equal((await req('/api/auth/login',{email:'isolated@example.invalid',password:'fixture-password'})).status,200);
});

test('research routes preserve explicit scope and validate malformed requests',async()=>{
 const page=await req('/research/');assert.equal(page.status,200);assert.equal(page.headers.get('cache-control'),'no-cache');assert.match(await page.text(),/location\.replace/);
 const digest=async file=>crypto.createHash('sha256').update(await readFile(path.join(root,'public',file))).digest('hex').slice(0,12);
 const shell=await(await req('/')).text();
 for(const file of ['app.js','workspace.js','research/research.js'])assert.ok(shell.includes(file+'?v='+await digest(file)),file);
 assert.equal((await req('/api/status')).headers.get('cache-control'),'no-store');assert.equal((await req('/client.mjs')).status,200);
 const caps=await(await req('/api/research/capabilities')).json();assert.equal(caps.find(x=>x.feature==='Plate-to-VIN').status,'gap');
 const r=await req('/api/research/scenario',{price:20000,apr:0,months:40});assert.equal(r.status,200);assert.equal((await r.json()).financing.monthly_payment,500);
 assert.equal((await req('/api/research/scenario',{price:'20000',apr:0,months:40})).status,400);
 assert.equal((await req('/api/research/compare',{vins:[vin,vin]})).status,400);
 const missing=await req('/api/research/communications?year=2003&make=Honda&model=Accord');assert.equal(missing.status,503);assert.equal((await missing.json()).reason,'dataset_not_indexed');
});
test('new MCP calculation and coverage tools execute through actual transport',async()=>{
 const client=new Client({name:'research-test',version:'1'}),transport=new StreamableHTTPClientTransport(new URL(base+'/mcp'));
 try{await client.connect(transport);const r=await client.callTool({name:'ownership_scenario',arguments:{price:20000,apr:0,months:40}});assert.equal(JSON.parse(r.content[0].text).financing.monthly_payment,500);const c=await client.callTool({name:'explore_capabilities',arguments:{}});assert.ok(JSON.parse(c.content[0].text).some(x=>x.status==='gap'));}finally{await transport.terminateSession();await client.close();}
});

 test('VIN recall repair status reaches REST, MCP reports and comparisons without replacing model-year campaigns',async()=>{
 const tesla='5YJSA1DG9DFP14705';
 const status=await(await req('/api/vin/'+tesla+'/recall-status')).json();assert.equal(status.open_count,1);assert.equal(status.completed_count,1);
 const report=await(await req('/api/vin/'+tesla)).json();assert.equal(report.recall_status.open_count,1);assert.equal(report.recalls.scope,'make_model_year');
 const comparison=await(await req('/api/research/compare',{vins:[vin,tesla]})).json();assert.equal(comparison.results[0].report.recall_status.open_count,null);assert.equal(comparison.results[1].report.recall_status.completed_count,1);
 const client=new Client({name:'recall-status-test',version:'1'}),transport=new StreamableHTTPClientTransport(new URL(base+'/mcp'));
 try{await client.connect(transport);const result=await client.callTool({name:'vin_recall_status',arguments:{vin:tesla}});assert.equal(JSON.parse(result.content[0].text).completed_count,1);}finally{await transport.close();}
 assert.equal((await req('/api/vin/invalid/recall-status')).status,400);
 });

test('Mopar and Toyota recall paths preserve unknown history through REST, reports, comparison and MCP',async()=>{
 const mopar='1D3HW48K55S152258',toyota='4T1BF1FK'+validateVin('4T1BF1FK0CU123456').checksum.expected+'CU123456';
 const status=await(await req('/api/vin/'+mopar+'/recall-status')).json();assert.equal(status.open_count,null);assert.equal(status.open_record_count,3);assert.equal(status.completed_count,null);assert.equal(status.service_campaigns.length,1);
 const report=await(await req('/api/vin/'+mopar)).json();assert.equal(report.recall_status.open_count,null);assert.equal(report.recall_status.open_record_count,3);assert.equal(report.recalls.scope,'make_model_year');
 const comparison=await(await req('/api/research/compare',{vins:[mopar,toyota]})).json();assert.equal(comparison.results[0].report.recall_status.completed_count,null);assert.equal(comparison.results[1].report.recall_status.reason,'interactive_verification_required');
 const client=new Client({name:'mopar-status-test',version:'1'}),transport=new StreamableHTTPClientTransport(new URL(base+'/mcp'));try{await client.connect(transport);const r=await client.callTool({name:'vin_recall_status',arguments:{vin:mopar}});assert.equal(JSON.parse(r.content[0].text).open_count,null);assert.equal(JSON.parse(r.content[0].text).open_record_count,3);}finally{await transport.close();}
});

test('Ford, GM and Honda VIN status survives REST, full reports, comparisons and real MCP transport',async()=>{
 const cases=[['1FTEX1EP4FFD06976',1,1,1],['1G1FW6S06H4188545',1,2,2],['5J6RS6H82RL008945',1,null,0]];
 const client=new Client({name:'manufacturer-status-test',version:'1'}),transport=new StreamableHTTPClientTransport(new URL(base+'/mcp'));
 try{await client.connect(transport);for(const [vin,open,complete,programs] of cases){
  const status=await(await req('/api/vin/'+vin+'/recall-status')).json();assert.equal(status.available,true);assert.equal(status.open_count,open);assert.equal(status.completed_count,complete);assert.equal(status.service_campaigns.length,programs);assert.ok(status.source.retrieved_at);
  const report=await(await req('/api/vin/'+vin)).json();assert.equal(report.recall_status.open_count,open);assert.equal(report.recalls.scope,'make_model_year');
  const r=await client.callTool({name:'vin_recall_status',arguments:{vin}});assert.equal(JSON.parse(r.content[0].text).completed_count,complete);
 }
 const c=await(await req('/api/research/compare',{vins:cases.map(x=>x[0])})).json();assert.deepEqual(c.results.map(x=>x.report.recall_status.completed_count),[1,2,null]);
 }finally{await transport.close();}
});

test('Nissan status and Hyundai/Kia handoffs survive REST, reports, comparison and MCP',async()=>{
 const vins=['1N4AL3APXFN868842','KM8K53AG0MU098173','5XXGR4A60FG353263'];
 const client=new Client({name:'nissan-status-test',version:'1'}),transport=new StreamableHTTPClientTransport(new URL(base+'/mcp'));
 try{await client.connect(transport);for(const [i,vin] of vins.entries()){
  const res=await req('/api/vin/'+vin+'/recall-status'),s=await res.json();assert.equal(res.status,i===0?200:502);assert.equal(s.completed_count,null);assert.equal(s.open_count,i===0?1:null);assert.equal(s.available,i===0);
  if(i>0){assert.equal(s.reason,'interactive_verification_required');assert.match(s.verification_url,i===1?/hyundaiusa.com/:/owners.kia.com/);}
  const report=await(await req('/api/vin/'+vin)).json();assert.equal(report.recall_status.open_count,i===0?1:null);assert.equal(report.recalls.scope,'make_model_year');
  const r=JSON.parse((await client.callTool({name:'vin_recall_status',arguments:{vin}})).content[0].text);assert.equal(r.available,i===0);assert.equal(r.completed_count,null);
 }
 const c=await(await req('/api/research/compare',{vins})).json();assert.deepEqual(c.results.map(x=>x.report.recall_status.open_count),[1,null,null]);
 }finally{await transport.close();}
});
