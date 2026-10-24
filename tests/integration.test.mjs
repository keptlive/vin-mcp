import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, symlink, writeFile, rm } from 'node:fs/promises';
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
for(const f of ['server.mjs','package.json','lib','public','tests/mock-upstream.mjs','tests/mopar-fixture.mjs'])await cp(path.join(root,f),path.join(stage,f),{recursive:true});
await symlink(path.join(root,'node_modules'),path.join(stage,'node_modules'),'dir');
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
test('registration, login and identity still work',async()=>{
 let res=await req('/api/auth/register',{email:'isolated@example.invalid',password:'fixture-password',display_name:'Test'});assert.equal(res.status,201);token=(await res.json()).token;
 res=await req('/api/auth/login',{email:'isolated@example.invalid',password:'fixture-password'});assert.equal(res.status,200);
 assert.equal((await(await req('/api/auth/me',undefined,token)).json()).display_name,'Test');
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
test('REST endpoints, direct VIN page and educational pages remain available',async()=>{
 for(const endpoint of ['/health','/api/status','/'+vin,'/free-vin-check/','/vin-decoder-api/','/vehicle-safety-recalls/','/vehicle-history-reports/','/app.js','/style.css'])assert.equal((await req(endpoint)).status,200,endpoint);
 for(const part of ['validate','recalls','complaints','safety','fuel'])assert.equal((await req(`/api/vin/${vin}/${part}`)).status,200,part);
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
 r=await client.callTool({name:'lookup_recalls',arguments:{make:'Honda',model:'Accord',year:2003}});assert.equal(JSON.parse(r.content[0].text).vin_specific,false);
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
 const page=await req('/research/');assert.equal(page.status,200);assert.equal(page.headers.get('cache-control'),'no-cache');assert.match(await page.text(),/research\.js\?v=1\.4\.0/);assert.match(await(await req('/')).text(),/app\.js\?v=1\.4\.0/);assert.equal((await req('/api/status')).headers.get('cache-control'),'no-store');assert.equal((await req('/client.mjs')).status,200);
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
