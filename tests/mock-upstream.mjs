import {moparFixture} from './mopar-fixture.mjs';
import {fordPage,fordState,gmFixture,hondaFixture,hondaPage,hondaVin} from './manufacturer-fixtures.mjs';
import https from 'node:https';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
const nativeGet=https.get;
https.get=(url,opts,callback)=>{
 if(String(url).includes('ford.com/support/recalls-details/')){
  const vin=new URL(url).pathname.split('/').filter(Boolean).at(-1);const response=Readable.from([Buffer.from(fordPage(fordState(vin)))]);response.statusCode=200;queueMicrotask(()=>callback(response));return new EventEmitter();
 }
 if(String(url).includes('experience.gm.com/ownercenter/api/')){
  const vin=new URL(url).pathname.split('/').at(-2);const response=Readable.from([Buffer.from(JSON.stringify(gmFixture(vin)))]);response.statusCode=200;queueMicrotask(()=>callback(response));return new EventEmitter();
 }
 if(String(url).startsWith('https://mygarage.honda.com/s/recall-search')){
  const response=Readable.from([Buffer.from(hondaPage())]);response.statusCode=200;queueMicrotask(()=>callback(response));return new EventEmitter();
 }
 if(String(url).includes('wrecall.extra.chrysler.com')){
  const response=Readable.from([Buffer.from(moparFixture())]);response.statusCode=200;queueMicrotask(()=>callback(response));return new EventEmitter();
 }
 if(String(url).includes('teslaservice-api.tesla.com')){
  const response=Readable.from([Buffer.from(JSON.stringify({success:true,responseObject:[{recallNumber:'24V051',recallStatus:'Recall Incomplete'},{recallNumber:'18V204',recallStatus:'Recall Completed'}]}))]);
  response.statusCode=200;queueMicrotask(()=>callback(response));return new EventEmitter();
 }
 return nativeGet(url,opts,callback);
};
const nativeRequest=https.request;
https.request=(url,opts,callback)=>{
 if(String(url).includes('mygarage.honda.com/s/sfsites/aura')){
  const req=new EventEmitter();req.end=body=>{const vin=JSON.parse(new URLSearchParams(body).get('message')).actions[0].params.params.productIdentifier;
   const response=Readable.from([Buffer.from(JSON.stringify(hondaFixture(vin===hondaVin?vin:'NOT_CONFIRMED')))]);response.statusCode=200;queueMicrotask(()=>callback(response));};return req;
 }
 return nativeRequest(url,opts,callback);
};
const json = data => new Response(JSON.stringify(data), {headers:{'content-type':'application/json'}});
const nativeFetch = globalThis.fetch;
const detailAttempts=new Map();
globalThis.fetch=async (input,opts)=>{
 const u=String(input);
 if(u.includes('vpic.nhtsa.dot.gov')){
  const vin=u.includes('DecodeVINValuesBatch')?'1HGCM82633A004352':decodeURIComponent(u.split('/').at(-1).split('?')[0]);
  const four=vin.endsWith('353');
  const model=vin.endsWith('354')?'Recovery Accord':vin.endsWith('355')?'MCP Recovery Accord':'Accord';
  return json({Results:[{VIN:vin,ModelYear:'2003',Make:vin.startsWith('1D3')?'DODGE':vin.startsWith('4T1')?'TOYOTA':vin.startsWith('5YJ')?'TESLA':'HONDA',Model:model,EngineCylinders:four?'4':'6',DisplacementL:four?'2.4':'2.998832712',TransmissionStyle:'Automatic',TransmissionSpeeds:'5',RearVisibilitySystem:'Standard',CIB:'Standard'}]});
 }
 if(u.includes('api.nhtsa.gov/recalls'))return json({results:[]});
 if(u.includes('api.nhtsa.gov/complaints'))return json({results:[]});
 if(u.includes('api.nhtsa.gov/SafetyRatings'))return json({Results:[]});
 if(u.includes('fueleconomy.gov')){
  const url=new URL(u),model=url.searchParams.get('model');
  if(u.includes('menu/options')&&model?.includes('Recovery'))return json({menuItem:{text:'Auto 5-spd, 6 cyl, 3.0 L',value:model.startsWith('MCP')?'90002':'90001'}});
  const id=url.pathname.split('/').at(-1);
  if(['90001','90002'].includes(id)){
   const attempts=detailAttempts.get(id)||0;detailAttempts.set(id,attempts+1);
   if(attempts===0)return json({id});
   return json({id,year:2003,make:'Honda',model:id==='90001'?'Recovery Accord':'MCP Recovery Accord',cylinders:6,displ:3,trany:'Automatic 5-spd',comb08:22});
  }
  return json(u.includes('menu/options')?{menuItem:[{text:'Auto 5-spd, 4 cyl, 2.4 L',value:'18655'},{text:'Auto 5-spd, 6 cyl, 3.0 L',value:'18657'}]}:{id:u.endsWith('18655')?18655:18657,year:2003,make:'Honda',model:'Accord',cylinders:u.endsWith('18655')?4:6,displ:u.endsWith('18655')?2.4:3.0,trany:'Automatic 5-spd',comb08:u.endsWith('18655')?25:22});
 }
 return nativeFetch(input,opts);
};
