// Test upstream for the server process (loaded with --import): every outbound request is either answered here with
// fixture data or refused. Nothing reaches the network, so no test can reach a manufacturer or any other host
// (fail closed). MOCK_OUTBOUND_LOG (a file path): one JSON line per outbound request, {via, host, url}; via is
// 'fetch', 'https.get', 'https.request', 'http.get', 'http.request' or 'blocked' (no mock: refused).
// tests/no-maker-requests.test.mjs reads it to prove the report path asks only government hosts.
import https from 'node:https';
import http from 'node:http';
import {appendFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
// MOCK_COMPLAINTS_DELAY_MS: NHTSA's complaint list answers after that long (5-17 s for a common model live).
const complaintsDelay=Number(process.env.MOCK_COMPLAINTS_DELAY_MS)||0;
const LOG=process.env.MOCK_OUTBOUND_LOG||null;
const hostOf=u=>{try{return new URL(u).hostname;}catch{return String(u).slice(0,80);}};
const isLoopback=u=>['127.0.0.1','localhost','::1','[::1]'].includes(hostOf(u));
function record(via,u){if(LOG)appendFileSync(LOG,JSON.stringify({via,host:hostOf(u),url:String(u).slice(0,300)})+'\n');}
// node:https and node:http: no code path uses them for upstream data (lib/ uses fetch), so every call is refused.
function refuse(mod,name){
 const native=mod[name];
 mod[name]=(url,...rest)=>{
  const u=typeof url==='string'||url instanceof URL?String(url):`${mod===https?'https':'http'}://${url?.hostname||url?.host||'unknown'}${url?.path||''}`;
  if(isLoopback(u))return native.call(mod,url,...rest);
  record(`${mod===https?'https':'http'}.${name}`,u);record('blocked',u);
  const req=new EventEmitter();req.end=()=>req;req.write=()=>true;req.destroy=()=>req;req.setTimeout=()=>req;req.abort=()=>{};
  queueMicrotask(()=>req.emit('error',new Error('mock-upstream: outbound '+name+' to '+hostOf(u)+' is blocked in tests')));
  return req;
 };
}
refuse(https,'get');refuse(https,'request');refuse(http,'get');refuse(http,'request');
const json = data => new Response(JSON.stringify(data), {headers:{'content-type':'application/json'}});
const nativeFetch = globalThis.fetch;
// The decoded make per WMI (anything else decodes as HONDA); YV1 (Volvo) has no maker page in lib/recall-links.mjs.
const MAKE_BY_WMI={'1D3':'DODGE','4T1':'TOYOTA','5YJ':'TESLA','1FT':'FORD','1G1':'CHEVROLET','1N4':'NISSAN','KM8':'HYUNDAI','5XX':'KIA','YV1':'VOLVO','WAU':'AUDI'};
const detailAttempts=new Map();
globalThis.fetch=async (input,opts)=>{
 const u=String(input?.url ?? input);
 if(isLoopback(u))return nativeFetch(input,opts);
 record('fetch',u);
 if(u.includes('vpic.nhtsa.dot.gov')){
  const vin=u.includes('DecodeVINValuesBatch')?'1HGCM82633A004352':decodeURIComponent(u.split('/').at(-1).split('?')[0]);
  const shift=vin.endsWith('356'),four=vin.endsWith('353')||shift; // ...356: EPA lists an automatic and a manual; the decode gives no transmission
  const model=vin.endsWith('354')?'Recovery Accord':vin.endsWith('355')?'MCP Recovery Accord':shift?'Shift Accord':'Accord';
  return json({Results:[{VIN:vin,ModelYear:'2003',Make:MAKE_BY_WMI[vin.slice(0,3)]||'HONDA',Model:model,EngineCylinders:four?'4':'6',DisplacementL:four?'2.4':'2.998832712',TransmissionStyle:shift?'':'Automatic',TransmissionSpeeds:shift?'':'5',RearVisibilitySystem:'Standard',CIB:'Standard'}]});
 }
 // mcp.vin's own private price service (lib/market.mjs, MARKET_API_URL): tests point it at this name.
 if(hostOf(u)==='price-service.mock.invalid')return json({ok:true,query:Object.fromEntries(new URL(u).searchParams),dealer_asking:null,listings:[]});
 if(u.includes('api.nhtsa.gov/recalls'))return json({results:[]});
 if(u.includes('api.nhtsa.gov/products/vehicle/models'))return json({results:[]});
 if(u.includes('api.nhtsa.gov/complaints')){if(complaintsDelay)await new Promise(r=>setTimeout(r,complaintsDelay));return json({results:[]});}
 if(u.includes('api.nhtsa.gov/SafetyRatings'))return json({Results:[]});
 if(u.includes('fueleconomy.gov')){
  const url=new URL(u),model=url.searchParams.get('model');
  if(u.includes('menu/options')&&model?.includes('Recovery'))return json({menuItem:{text:'Auto 5-spd, 6 cyl, 3.0 L',value:model.startsWith('MCP')?'90002':'90001'}});
  if(u.includes('menu/options')&&model==='Shift Accord')return json({menuItem:[{text:'Auto 5-spd, 4 cyl, 2.4 L',value:'91001'},{text:'Man 5-spd, 4 cyl, 2.4 L',value:'91002'}]});
  const id=url.pathname.split('/').at(-1);
  if(['91001','91002'].includes(id))return json({id:Number(id),year:2003,make:'Honda',model:'Shift Accord',cylinders:4,displ:2.4,trany:id==='91001'?'Automatic 5-spd':'Manual 5-spd',city08:id==='91001'?22:24,highway08:id==='91001'?30:33,comb08:id==='91001'?25:27,fuelType:'Regular'});
  if(['90001','90002'].includes(id)){
   const attempts=detailAttempts.get(id)||0;detailAttempts.set(id,attempts+1);
   if(attempts===0)return json({id});
   return json({id,year:2003,make:'Honda',model:id==='90001'?'Recovery Accord':'MCP Recovery Accord',cylinders:6,displ:3,trany:'Automatic 5-spd',comb08:22});
  }
  return json(u.includes('menu/options')?{menuItem:[{text:'Auto 5-spd, 4 cyl, 2.4 L',value:'18655'},{text:'Auto 5-spd, 6 cyl, 3.0 L',value:'18657'}]}:{id:u.endsWith('18655')?18655:18657,year:2003,make:'Honda',model:'Accord',cylinders:u.endsWith('18655')?4:6,displ:u.endsWith('18655')?2.4:3.0,trany:'Automatic 5-spd',comb08:u.endsWith('18655')?25:22});
 }
 record('blocked',u);
 throw new TypeError('mock-upstream: no mock for '+hostOf(u)+' (outbound requests are blocked in tests)');
};
