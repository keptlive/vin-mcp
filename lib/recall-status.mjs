/** Manufacturer-reported VIN recall status. Never inferred from model-year campaigns. */
import https from 'node:https';
import { validateVin, normalizeVin } from './validate.mjs';
import { InputError } from './research.mjs';
import { MOPAR_LOOKUP, moparUrl, parseMopar } from './mopar-recalls.mjs';
import {FORD_LOOKUP,GM_LOOKUP,GM_API,HONDA_LOOKUP,HONDA_API,parseFord,parseGm,parseHonda,hondaContext,hondaRequest} from './manufacturer-recalls.mjs';

const API = 'https://akamai-apigateway-teslaservice-api.tesla.com/api/VinRecall';
const LOOKUP = 'https://service.tesla.com/en-US/vin-recall-search';
const TESLA_WMIS = new Set(['5YJ', '7SA', '7G2', 'LRW', 'XP7']);
const MOPAR_WMIS = new Set(['1B3','1B4','1B7','1C3','1C4','1C6','1D3','1D4','1D7','1D8','1J4','1J8','1P3','1P4','2B3','2B4','2B5','2B7','2C3','2C4','2D4','2D7','2D8','3B7','3C3','3C4','3C6','3D3','3D4','3D6','3D7','3D2','ZAC','ZAR','ZFA']);
const TOYOTA_WMIS = new Set(['1NX','2T1','2T2','2T3','2T4','3TM','3TY','4T1','4T3','4T4','4TA','5TB','5TD','5TE','5TF','5YF','58A','7MU','7SV','JT2','JT3','JT4','JT5','JT6','JT8','JTD','JTE','JTH','JTJ','JTK','JTM','JTN']);
const FORD_WMIS=new Set(['1FA','1FB','1FC','1FD','1FM','1FT','1LN','1ME','2FA','2FM','2FT','2LM','2LN','2ME','3FA','3FD','3FM','3FT','3LN','3MA','NM0','WF0']);
const GM_WMIS=new Set(['1G1','1G2','1G3','1G4','1G6','1G8','1GC','1GK','1GT','1GY','1GZ','2G1','2G2','2G4','2G6','2G8','2GC','2GK','2GT','2GY','3G1','3G5','3G7','3GC','3GK','3GN','3GT','3GY','5GA','5GR','KL1','KL4','KL7','KL8','YS3']);
const HONDA_WMIS=new Set(['1HG','19X','2HG','2HK','3CZ','5FN','5FP','5J6','5KB','7FA','JHM','JHL']);
const TTL = 15 * 60 * 1000;
const note = 'Manufacturer-reported status for this VIN, checked at the stated time. Coverage and reporting delays vary. This is not a complete service history or a guarantee of safety. Recall date is not repair date.';

function documentUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 'service.tesla.com' ? u.href : null; }
  catch { return null; }
}

// The upstream returns an application error to Node fetch; its public endpoint
// works with the standard HTTPS client. Bound response size and request duration.
function manufacturerRequest(url, {signal,method='GET',headers={},body}) {
  return new Promise((resolve,reject) => {
    const options={signal,method,headers:{Accept:url.startsWith(API)?'application/json':'text/html','User-Agent':'mcp.vin/1.5.0 (+https://mcp.vin)',...headers}};
    const receive=res=>{
      let size=0;const chunks=[];
      res.on('error',reject);
      res.on('data',chunk=>{size+=chunk.length;if(size>2*1024*1024){res.destroy(new Error('Response too large'));return;}chunks.push(chunk);});
      res.on('end',()=>{const text=Buffer.concat(chunks).toString('utf8');resolve({ok:res.statusCode===200,json:async()=>JSON.parse(text),text:async()=>text});});
    };
    const req=method==='GET'?https.get(url,options,receive):https.request(url,options,receive);
    req.on('error',reject);
    if(method!=='GET')req.end(body);
  });
}
export function createRecallStatusLookup(request=manufacturerRequest) {
 const cache=new Map(),pending=new Map();
 let guestContext=null,guestPending=null;
 async function getHondaContext(signal){
  if(guestContext?.expires>Date.now())return guestContext.value;
  if(guestPending)return guestPending;
  guestPending=(async()=>{const r=await request(HONDA_LOOKUP,{signal});if(!r.ok)throw Error('Guest page unavailable');const value=hondaContext(await r.text());guestContext={value,expires:Date.now()+TTL};return value;})();
  try{return await guestPending;}finally{guestPending=null;}
 }
 return async function vinRecallStatus(input, make = '') {
  const vin = normalizeVin(input);
  if (!validateVin(vin).valid) throw new InputError('Provide a valid 17-character VIN including checksum');
  const brand=String(make).toUpperCase(),wmi=vin.slice(0,3);
  const byWmi=[[TESLA_WMIS,'tesla'],[MOPAR_WMIS,'mopar'],[TOYOTA_WMIS,'toyota'],[FORD_WMIS,'ford'],[GM_WMIS,'gm'],[HONDA_WMIS,'honda']].find(([set])=>set.has(wmi))?.[1];
  const byBrand={TESLA:'tesla',CHRYSLER:'mopar',DODGE:'mopar',JEEP:'mopar',RAM:'mopar',FIAT:'mopar','ALFA ROMEO':'mopar',PLYMOUTH:'mopar',TOYOTA:'toyota',LEXUS:'toyota',SCION:'toyota',FORD:'ford',LINCOLN:'ford',MERCURY:'ford',CHEVROLET:'gm',BUICK:'gm',GMC:'gm',CADILLAC:'gm',PONTIAC:'gm',OLDSMOBILE:'gm',SATURN:'gm',HUMMER:'gm',SAAB:'gm',GEO:'gm',BRIGHTDROP:'gm',HONDA:'honda'};
  const provider=byWmi||(Object.hasOwn(byBrand,brand)?byBrand[brand]:null);
  const verification_url = provider==='tesla' ? `${LOOKUP}?VIN=${encodeURIComponent(vin)}` : provider==='mopar' ? MOPAR_LOOKUP : provider==='toyota' ? 'https://www.toyota.com/recall/' : provider==='ford'?FORD_LOOKUP+vin+'/':provider==='gm'?GM_LOOKUP+'?vin='+vin:provider==='honda'?HONDA_LOOKUP:'https://www.nhtsa.gov/recalls';
  const base = {vin, scope:'vin', vin_specific:true, verification_url, note};
  if (provider==='toyota') return {...base,available:false,reason:'interactive_verification_required',open_count:null,completed_count:null,recalls:[],
    note:'Toyota, Lexus and Scion U.S. VIN recall lookup requires interactive reCAPTCHA verification. Automated repair status is not available. Check this VIN on the official Toyota site; no repair completion is inferred.'};
  if (!provider) {
    return {...base, available:false, reason:'manufacturer_not_supported', open_count:null, completed_count:null, recalls:[],
      note:'Automated VIN recall status supports Tesla, Ford, GM, Honda and positive Mopar fleet records, with manufacturer-specific coverage limits. Use the official VIN checker for other makes; model-year campaigns do not establish applicability or completed repairs.'};
  }
  const key=provider+'|'+vin;
  const old = cache.get(key);
  if (old && old.expires > Date.now()) return old.result;
  if (pending.has(key)) return pending.get(key);
  const task = (async () => {
    const url = provider==='mopar' ? moparUrl(vin) : provider==='ford'?verification_url:provider==='gm'?GM_API+vin+'/gfas':provider==='honda'?HONDA_API:`${API}?VIN=${encodeURIComponent(vin)}`;
    const names={mopar:'Mopar Fleet Recall/Rapid Response Inquiry',tesla:'Tesla Service VIN Recall Search',ford:'Ford Owner Support VIN Recalls',gm:'GM Recall and Warranty Center',honda:'Honda MyGarage VIN Recall Search'};
    const source = {provider:names[provider], url, reference_url:verification_url};
    try {
      const signal=AbortSignal.timeout(15000);
      const options=provider==='honda'?hondaRequest(vin,await getHondaContext(signal)):{};
      const response = await request(url, {...options,signal,headers:{Accept:['tesla','gm','honda'].includes(provider)?'application/json':'text/html',...(provider==='gm'?{'User-Agent':'vin-mcp/1.5.0'}:{}),...options.headers}});
      if (!response.ok) throw new Error('Upstream unavailable');
      if(['ford','gm','honda'].includes(provider)){
        let data;try{data=provider==='ford'?parseFord(await response.text(),vin):provider==='gm'?parseGm(await response.json(),vin):parseHonda(await response.json(),vin);}
        catch{if(provider==='honda')guestContext=null;return {...base,available:false,reason:'invalid_response',source,open_count:null,completed_count:null,recalls:[]};}
        if(!data)return {...base,available:false,reason:'vin_not_confirmed',source,open_count:null,completed_count:null,recalls:[],note:'The manufacturer did not confirm this full VIN. Counts and completed repairs remain unknown. Check the official source.'};
        const result={...base,...data,available:true,source:{...source,retrieved_at:new Date().toISOString()}};
        if(cache.size>=300)cache.delete(cache.keys().next().value);
        cache.set(key,{expires:Date.now()+TTL,result});return result;
      }
      if (provider==='mopar') {
        let data;
        try { data=parseMopar(await response.text(),vin); }
        catch { return {...base,available:false,reason:'invalid_response',source,open_count:null,completed_count:null,recalls:[]}; }
        if (!data) return {...base,available:false,reason:'vin_not_confirmed',source,open_count:null,completed_count:null,recalls:[],note:'Mopar returned no records that confirm this full VIN. This can mean no open records or an unrecognized VIN; repair status remains unknown. Check the official source.'};
        const result={...base,...data,available:true,source:{...source,retrieved_at:new Date().toISOString()}};
        if(cache.size>=300)cache.delete(cache.keys().next().value);
        cache.set(key,{expires:Date.now()+TTL,result});return result;
      }
      const body = await response.json();
      if (body?.success !== true || !Array.isArray(body.responseObject) || body.responseObject.length > 200 ||
        !body.responseObject.every(r => r && typeof r.recallNumber === 'string' && r.recallNumber.trim() && typeof r.recallStatus === 'string' && r.recallStatus.trim())) {
        return {...base, available:false, reason:'invalid_response', source, open_count:null, completed_count:null, recalls:[]};
      }
      const recalls = body.responseObject.map(r => ({
        campaign_number:r.recallNumber, manufacturer_status:r.recallStatus,
        repair_status:r.recallStatus.trim().toLowerCase() === 'recall completed' ? 'completed' : r.recallStatus.trim().toLowerCase() === 'recall incomplete' ? 'open' : 'unknown',
        recall_date:typeof r.recallDate === 'string' ? r.recallDate : null, repair_completed_at:null,
        summary:typeof r.description === 'string' ? r.description : null,
        remedy:typeof r.remedy === 'string' ? r.remedy : null,
        safety_risk:typeof r.safetyRisk === 'string' ? r.safetyRisk : null,
        bulletin:typeof r.bulletinReferenceNumber === 'string' ? r.bulletinReferenceNumber : null,
        document_url:documentUrl(r.documentPath)
      }));
      const unknown_count = recalls.filter(r => r.repair_status === 'unknown').length;
      const result = {...base, available:true, source:{...source,retrieved_at:new Date().toISOString()},
        open_count:unknown_count ? null : recalls.filter(r => r.repair_status === 'open').length,
        completed_count:recalls.filter(r => r.repair_status === 'completed').length, unknown_count, recalls};
      if (cache.size >= 300) cache.delete(cache.keys().next().value);
      cache.set(key, {expires:Date.now()+TTL,result});
      return result;
    } catch {
      return {...base, available:false, reason:'upstream_unavailable', source, open_count:null, completed_count:null, recalls:[]};
    }
  })();
  pending.set(key, task);
  try { return await task; } finally { pending.delete(key); }
}

}
export const vinRecallStatus = createRecallStatusLookup();
