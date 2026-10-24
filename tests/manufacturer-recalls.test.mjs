import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFord,parseGm,parseHonda,hondaContext,hondaRequest,isoDate,HONDA_API,HONDA_LOOKUP} from '../lib/manufacturer-recalls.mjs';
import {createRecallStatusLookup} from '../lib/recall-status.mjs';
import {validateVin} from '../lib/validate.mjs';
import {fordVin,gmVin,hondaVin,fordState,fordPage,gmFixture,hondaFixture,hondaPage,guestContext} from './manufacturer-fixtures.mjs';
import {NISSAN_LOOKUP,HYUNDAI_LOOKUP,KIA_LOOKUP,nissanEndpoint,nissanRequest,parseNissan} from '../lib/manufacturer-recalls.mjs';
import {nissanVin,nissanPage,nissanFixture} from './manufacturer-fixtures.mjs';
const json=b=>new Response(JSON.stringify(b)),html=b=>new Response(b);
test('Nissan discovers only its bounded same-origin public recall endpoint and sends the normal VIN form',()=>{
 const u=nissanEndpoint(nissanPage);assert.match(u,/^https:\/\/www.nissanusa.com\/content\/nissan_prod\/en_US\//);
 const opts=nissanRequest(nissanVin);assert.equal(opts.method,'POST');assert.deepEqual(JSON.parse(new URLSearchParams(opts.body).get('vinNums')),[nissanVin]);
 for(const page of ['<h1>Challenge</h1>',nissanPage+nissanPage,nissanPage.replace('/content/nissan_prod/','https://evil.invalid/'),nissanPage.replace('/index/','/../'),nissanPage.replace('/en_US/','/en_CA/')])assert.throws(()=>nissanEndpoint(page));
});
test('Nissan confirms positive safety recalls without claiming completed history or repair dates',()=>{
 const b=nissanFixture(),r=parseNissan(b,nissanVin);assert.equal(r.open_count,1);assert.equal(r.completed_count,null);assert.equal(r.recalls[0].repair_status,'open');assert.equal(r.recalls[0].repair_completed_at,null);assert.equal(r.recalls[0].recall_date,'2020-05-28');assert.equal(r.recalls[0].source_effective_date,'2021-06-23');assert.equal(r.coverage.zero_open_verifiable,false);assert.equal(r.coverage.since,'1994-03-15');
 b.recalls.push(structuredClone(b.recalls[0]));assert.equal(parseNissan(b,nissanVin).open_count,1);b.recalls[1].primaryDescription='Changed';assert.throws(()=>parseNissan(b,nissanVin),/Conflicting/);
});
test('Nissan empty results, any mismatched VIN or wrong brand never become zero recalls',()=>{
 assert.equal(parseNissan({recalls:[]},nissanVin),null);assert.equal(parseNissan(nissanFixture(hondaVin),nissanVin),null);
 const b=nissanFixture();b.recalls[0].brand='INFINITI';assert.equal(parseNissan(b,nissanVin),null);b.recalls.push(nissanFixture().recalls[0]);assert.equal(parseNissan(b,nissanVin),null);
});
test('Nissan rejects changed schemas and unfamiliar campaign classifications',()=>{
 for(const mutate of [b=>b.recalls=null,b=>b.recalls[0].typeCode='Service Campaign',b=>b.recalls[0].typeCode='Future Type',b=>b.recalls[0].govtRecallId='',b=>b.recalls[0].nissanRecallId='']){const b=nissanFixture();mutate(b);assert.throws(()=>parseNissan(b,nissanVin));}
 const b=nissanFixture();b.recalls[0].defectInfoRptDate='2025-02-30';assert.equal(parseNissan(b,nissanVin).recalls[0].recall_date,null);
});
test('Nissan lookup caches positive results, shares page discovery and deduplicates requests',async()=>{
 let pages=0,posts=0;const lookup=createRecallStatusLookup(async(url,opts)=>{if(url===NISSAN_LOOKUP){pages++;return html(nissanPage);}posts++;assert.equal(url,nissanEndpoint(nissanPage));return json(nissanFixture(JSON.parse(new URLSearchParams(opts.body).get('vinNums'))[0]));});
 const [a,b]=await Promise.all([lookup(nissanVin,'TOYOTA'),lookup(nissanVin)]);assert.equal(a,b);assert.equal(a.available,true);assert.equal(a.source.reference_url,NISSAN_LOOKUP);assert.equal(await lookup(nissanVin),a);assert.equal(pages,1);assert.equal(posts,1);
 let other=nissanVin.slice(0,-1)+'3';other=other.slice(0,8)+validateVin(other).checksum.expected+other.slice(9);assert.equal((await lookup(other)).available,true);assert.equal(pages,1);assert.equal(posts,2);
});
test('Nissan 404, blocked, malformed and empty responses stay unknown and retry',async()=>{
 for(const response of [()=>new Response('',{status:404}),()=>new Response('Forbidden',{status:403}),()=>html('<h1>Challenge</h1>'),()=>json({recalls:[]}),()=>json(nissanFixture(hondaVin))]){
  let calls=0;const lookup=createRecallStatusLookup(async url=>url===NISSAN_LOOKUP?html(nissanPage):(++calls,response()));
  for(let i=0;i<2;i++){const r=await lookup(nissanVin);assert.equal(r.available,false);assert.equal(r.open_count,null);assert.equal(r.completed_count,null);}assert.equal(calls,2);
 }
});
test('Toyota, Hyundai and Kia route to their official interactive verification without protected requests',async()=>{
 let calls=0;const lookup=createRecallStatusLookup(async()=>{calls++;throw Error('Protected flow must not be called');});
 for(const [input,url,make] of [['4T1BF1FK0CU123456','https://www.toyota.com/recall/','Toyota'],['KM8K53AG0MU098173',HYUNDAI_LOOKUP,'Hyundai'],['5XXGR4A60FG353263',KIA_LOOKUP,'Kia']]){
  const vin=input.slice(0,8)+validateVin(input).checksum.expected+input.slice(9),r=await lookup(vin,'TESLA');assert.equal(r.reason,'interactive_verification_required');assert.equal(r.open_count,null);assert.equal(r.completed_count,null);assert.equal(r.verification_url,url);assert.match(r.note,new RegExp(make));
 }assert.equal(calls,0);
});
test('Ford reads split page data without executing scripts; recalls and service programs stay separate',()=>{
 const r=parseFord(fordPage(fordState(),true)+'<script>throw Error("Do not execute")</script>',fordVin);
 assert.equal(r.open_count,1);assert.equal(r.completed_count,1);assert.equal(r.service_campaigns.length,1);assert.equal(r.recalls[1].remedy_available,false);assert.equal(r.recalls[0].repair_completed_at,null);assert.equal(r.coverage.since,'2004-01-01');
});
test('Ford rejects unconfirmed VIN, incomplete arrays, ambiguous states and invalid pages without zero',()=>{
 for(const field of ['serverUserVin','nestedVin','isVinInvalid','successfulResponse']){const s=fordState();if(field==='nestedVin')s.serverRecallsData.vehicleDetails.vin=hondaVin;else if(field==='successfulResponse')s.serverRecallsData.successfulResponse=false;else s[field]=field==='isVinInvalid'?true:hondaVin;assert.equal(parseFord(fordPage(s),fordVin),null);}
 const bad=fordState();bad.serverRecallsData.nhtsa=[];assert.throws(()=>parseFord(fordPage(bad),fordVin),/Incomplete/);
 assert.throws(()=>parseFord('<h1>Challenge</h1>',fordVin));assert.throws(()=>parseFord(fordPage()+fordPage(),fordVin));
 const s=fordState();s.serverRecallsData.nhtsa[0].recallStatus='Future status';const r=parseFord(fordPage(s),fordVin);assert.equal(r.open_count,null);assert.equal(r.completed_count,null);assert.equal(r.unknown_count,1);
});
test('Ford confirms empty records only with matching VIN and complete success schema',()=>{
 const s=fordState();Object.assign(s.serverRecallsData,{nhtsa:[],recalls:[],fsa:[],recallsCount:0,cspCount:0,totalFsaCount:0});assert.equal(parseFord(fordPage(s),fordVin).open_count,0);
});
test('GM preserves repair date and administrative closure separately and excludes other programs',()=>{
 const r=parseGm(gmFixture(),gmVin);assert.equal(r.open_count,1);assert.equal(r.completed_count,2);assert.equal(r.service_campaign_count,2);
 assert.equal(r.recalls[0].repair_completed_at,'2024-02-01');assert.equal(r.recalls[0].manufacturer_closed_at,'2024-02-03');assert.equal(r.recalls[1].manufacturer_closed_at,null);
 assert.equal(r.recalls[2].repair_completed_at,null);assert.equal(r.recalls[2].manufacturer_closed_at,'2025-03-01');assert.match(r.recalls[2].completion_description,/Manual/);
 assert.equal(r.coverage.completion_is_not_always_repair,true);
});
test('GM errors, VIN mismatch, changed types and invalid dates never fabricate success or repair dates',()=>{
 assert.equal(parseGm(gmFixture(hondaVin),gmVin),null);
 for(const mutate of [b=>b.serverErrorMsgs.push('down'),b=>b.messages.push('invalid'),b=>b.data.gfas=null,b=>b.data.gfas[0].type='FUTURE']){const b=gmFixture();mutate(b);assert.throws(()=>parseGm(b,gmVin));}
 const b=gmFixture();b.data.gfas[0].vinStatusInfo.repairDate='2025-02-30';b.data.gfas[0].vinStatusInfo.vinStatus='Pending Review';const r=parseGm(b,gmVin);assert.equal(r.open_count,null);assert.equal(r.recalls[0].repair_completed_at,null);
 for(const d of ['1900-01-01','2025-02-30','2026-13-01','bad',null])assert.equal(isoDate(d),null);
});
test('GM deduplicates identical records, but conflicting statuses fail rather than silently winning',()=>{
 const b=gmFixture();b.data.gfas.push(structuredClone(b.data.gfas[0]));assert.equal(parseGm(b,gmVin).recalls.length,3);b.data.gfas.at(-1).vinStatusInfo.vinStatus='incomplete';assert.throws(()=>parseGm(b,gmVin),/Conflicting/);
});
test('Honda uses public guest metadata, VIN action and null token without login or CAPTCHA',()=>{
 assert.deepEqual(hondaContext(hondaPage()).loaded,guestContext.loaded);assert.throws(()=>hondaContext('<h1>Challenge</h1>'));
 const request=hondaRequest(hondaVin,hondaContext(hondaPage())),p=new URLSearchParams(request.body),action=JSON.parse(p.get('message')).actions[0];assert.equal(request.method,'POST');assert.equal(p.get('aura.token'),'null');assert.equal(action.params.method,'getRecallsByProductIdentifier');assert.equal(action.params.params.productIdentifier,hondaVin);
 const r=parseHonda(hondaFixture(),hondaVin);assert.equal(r.open_count,1);assert.equal(r.completed_count,null);assert.equal(r.recalls[0].recall_date,'2026-06-04');assert.equal(r.recalls[0].repair_completed_at,null);assert.equal(r.coverage.lookback_calendar_years,15);
});
test('Honda distinguishes confirmed empty VIN results, mismatches, API errors and unrecognized statuses',()=>{
 const b=hondaFixture(),r=b.actions[0].returnValue.returnValue.response.recalls_response.response;
 r.recall.campaignType.campaign=[];assert.equal(parseHonda(b,hondaVin).open_count,0);assert.equal(parseHonda(b,hondaVin).completed_count,null);
 assert.equal(parseHonda(hondaFixture(gmVin),hondaVin),null);r.error='true';assert.throws(()=>parseHonda(b,hondaVin));
 const c=hondaFixture();c.actions[0].state='ERROR';assert.throws(()=>parseHonda(c,hondaVin));
 const u=hondaFixture();u.actions[0].returnValue.returnValue.response.recalls_response.response.recall.campaignType.campaign[0].mfrRecallStatus.value='Pending Review';assert.equal(parseHonda(u,hondaVin).open_count,null);
});
test('new manufacturer adapters cache successes, deduplicate concurrent calls and retry failures',async()=>{
 for(const [vin,reply] of [[fordVin,()=>html(fordPage())],[gmVin,()=>json(gmFixture())]]){
  let calls=0,fail=true;const lookup=createRecallStatusLookup(async()=>{calls++;return fail?new Response('blocked',{status:403}):reply();});
  assert.equal((await lookup(vin)).open_count,null);fail=false;const [a,b]=await Promise.all([lookup(vin),lookup(vin)]);assert.equal(a.available,true);assert.equal(a,b);assert.equal(await lookup(vin),a);assert.equal(calls,2);
 }
});
test('Honda guest metadata is shared across different VINs; failures are not cached as zero',async()=>{
 let pages=0,posts=0,fail=true;const lookup=createRecallStatusLookup(async(url,opts)=>{if(url===HONDA_LOOKUP){pages++;return html(hondaPage());}assert.equal(url,HONDA_API);posts++;const vin=JSON.parse(new URLSearchParams(opts.body).get('message')).actions[0].params.params.productIdentifier;return fail?json({actions:[]}):json(hondaFixture(vin));});
 assert.equal((await lookup(hondaVin)).reason,'invalid_response');fail=false;
 let other=hondaVin.slice(0,-1)+'6';other=other.slice(0,8)+validateVin(other).checksum.expected+other.slice(9);
 const [a,b]=await Promise.all([lookup(hondaVin),lookup(other)]);assert.ok(a.available&&b.available);assert.equal(pages,2);assert.equal(posts,3);assert.equal(a.completed_count,null);
});
test('known WMI overrides conflicting make hints and unsupported makes never hit upstream',async()=>{
 let calls=0;const lookup=createRecallStatusLookup(async()=>{calls++;return html(fordPage());});assert.equal((await lookup(fordVin,'TESLA')).source.provider,'Ford Owner Support VIN Recalls');
 let vin='4US'+fordVin.slice(3);vin=vin.slice(0,8)+validateVin(vin).checksum.expected+vin.slice(9);assert.equal((await lookup(vin)).reason,'manufacturer_not_supported');assert.equal(calls,1);
});
