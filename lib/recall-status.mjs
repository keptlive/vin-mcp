/** Manufacturer-reported VIN recall status. Never inferred from model-year campaigns. */
import https from 'node:https';
import { validateVin, normalizeVin } from './validate.mjs';
import { InputError } from './research.mjs';
import { MOPAR_LOOKUP, moparUrl, parseMopar } from './mopar-recalls.mjs';

const API = 'https://akamai-apigateway-teslaservice-api.tesla.com/api/VinRecall';
const LOOKUP = 'https://service.tesla.com/en-US/vin-recall-search';
const TESLA_WMIS = new Set(['5YJ', '7SA', '7G2', 'LRW', 'XP7']);
const MOPAR_WMIS = new Set(['1B3','1B4','1B7','1C3','1C4','1C6','1D3','1D4','1D7','1D8','1J4','1J8','1P3','1P4','2B3','2B4','2B5','2B7','2C3','2C4','2D4','2D7','2D8','3B7','3C3','3C4','3C6','3D3','3D4','3D6','3D7','3D2','ZAC','ZAR','ZFA']);
const TOYOTA_WMIS = new Set(['1NX','2T1','2T2','2T3','2T4','3TM','3TY','4T1','4T3','4T4','4TA','5TB','5TD','5TE','5TF','5YF','58A','7MU','7SV','JT2','JT3','JT4','JT5','JT6','JT8','JTD','JTE','JTH','JTJ','JTK','JTM','JTN']);
const TTL = 15 * 60 * 1000;
const note = 'Manufacturer-reported status for this VIN, checked at the stated time. Coverage and reporting delays vary. This is not a complete service history or a guarantee of safety. Recall date is not repair date.';

function documentUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 'service.tesla.com' ? u.href : null; }
  catch { return null; }
}

// The upstream returns an application error to Node fetch; its public endpoint
// works with the standard HTTPS client. Bound response size and request duration.
function manufacturerRequest(url, {signal}) {
  return new Promise((resolve,reject) => {
    const req=https.get(url,{signal,headers:{Accept:url.startsWith(API)?'application/json':'text/html','User-Agent':'mcp.vin/1.4.0 (+https://mcp.vin)'}},res=>{
      let size=0;const chunks=[];
      res.on('error',reject);
      res.on('data',chunk=>{size+=chunk.length;if(size>2*1024*1024){res.destroy(new Error('Response too large'));return;}chunks.push(chunk);});
      res.on('end',()=>{const text=Buffer.concat(chunks).toString('utf8');resolve({ok:res.statusCode===200,json:async()=>JSON.parse(text),text:async()=>text});});
    });
    req.on('error',reject);
  });
}
export function createRecallStatusLookup(request=manufacturerRequest) {
 const cache=new Map(),pending=new Map();
 return async function vinRecallStatus(input, make = '') {
  const vin = normalizeVin(input);
  if (!validateVin(vin).valid) throw new InputError('Provide a valid 17-character VIN including checksum');
  const brand=String(make).toUpperCase(),wmi=vin.slice(0,3);
  const provider=TESLA_WMIS.has(wmi)||brand==='TESLA'?'tesla':MOPAR_WMIS.has(wmi)||['CHRYSLER','DODGE','JEEP','RAM','FIAT','ALFA ROMEO','PLYMOUTH'].includes(brand)?'mopar':TOYOTA_WMIS.has(wmi)||['TOYOTA','LEXUS','SCION'].includes(brand)?'toyota':null;
  const verification_url = provider==='tesla' ? `${LOOKUP}?VIN=${encodeURIComponent(vin)}` : provider==='mopar' ? MOPAR_LOOKUP : provider==='toyota' ? 'https://www.toyota.com/recall/' : 'https://www.nhtsa.gov/recalls';
  const base = {vin, scope:'vin', vin_specific:true, verification_url, note};
  if (provider==='toyota') return {...base,available:false,reason:'interactive_verification_required',open_count:null,completed_count:null,recalls:[],
    note:'Toyota, Lexus and Scion U.S. VIN recall lookup requires interactive reCAPTCHA verification. Automated repair status is not available. Check this VIN on the official Toyota site; no repair completion is inferred.'};
  if (!provider) {
    return {...base, available:false, reason:'manufacturer_not_supported', open_count:null, completed_count:null, recalls:[],
      note:'Automated recall status supports Tesla and positive Mopar fleet records. Use the official VIN checker for other makes; model-year campaigns do not establish applicability or completed repairs.'};
  }
  const old = cache.get(vin);
  if (old && old.expires > Date.now()) return old.result;
  if (pending.has(vin)) return pending.get(vin);
  const task = (async () => {
    const url = provider==='mopar' ? moparUrl(vin) : `${API}?VIN=${encodeURIComponent(vin)}`;
    const source = {provider:provider==='mopar'?'Mopar Fleet Recall/Rapid Response Inquiry':'Tesla Service VIN Recall Search', url, reference_url:verification_url};
    try {
      const response = await request(url, {signal:AbortSignal.timeout(10000)});
      if (!response.ok) throw new Error('Upstream unavailable');
      if (provider==='mopar') {
        let data;
        try { data=parseMopar(await response.text(),vin); }
        catch { return {...base,available:false,reason:'invalid_response',source,open_count:null,completed_count:null,recalls:[]}; }
        if (!data) return {...base,available:false,reason:'vin_not_confirmed',source,open_count:null,completed_count:null,recalls:[],note:'Mopar returned no records that confirm this full VIN. This can mean no open records or an unrecognized VIN; repair status remains unknown. Check the official source.'};
        const result={...base,...data,available:true,source:{...source,retrieved_at:new Date().toISOString()}};
        if(cache.size>=300)cache.delete(cache.keys().next().value);
        cache.set(vin,{expires:Date.now()+TTL,result});return result;
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
      cache.set(vin, {expires:Date.now()+TTL,result});
      return result;
    } catch {
      return {...base, available:false, reason:'upstream_unavailable', source, open_count:null, completed_count:null, recalls:[]};
    }
  })();
  pending.set(vin, task);
  try { return await task; } finally { pending.delete(vin); }
}

}
export const vinRecallStatus = createRecallStatusLookup();
