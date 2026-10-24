/** Manufacturer-reported VIN recall status. Never inferred from model-year campaigns. */
import { validateVin, normalizeVin } from './validate.mjs';
import { InputError } from './research.mjs';

const API = 'https://akamai-apigateway-teslaservice-api.tesla.com/api/VinRecall';
const LOOKUP = 'https://service.tesla.com/en-US/vin-recall-search';
const TESLA_WMIS = new Set(['5YJ', '7SA', '7G2', 'LRW', 'XP7']);
const cache = new Map();
const pending = new Map();
const TTL = 15 * 60 * 1000;
const note = 'Manufacturer-reported status for this VIN, checked at the stated time. Coverage and reporting delays vary. This is not a complete service history or a guarantee of safety. Recall date is not repair date.';

function documentUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 'service.tesla.com' ? u.href : null; }
  catch { return null; }
}

export async function vinRecallStatus(input, make = '') {
  const vin = normalizeVin(input);
  if (!validateVin(vin).valid) throw new InputError('Provide a valid 17-character VIN including checksum');
  const verification_url = TESLA_WMIS.has(vin.slice(0, 3)) || String(make).toUpperCase() === 'TESLA'
    ? `${LOOKUP}?VIN=${encodeURIComponent(vin)}` : 'https://www.nhtsa.gov/recalls';
  const base = {vin, scope:'vin', vin_specific:true, verification_url, note};
  if (!TESLA_WMIS.has(vin.slice(0, 3)) && String(make).toUpperCase() !== 'TESLA') {
    return {...base, available:false, reason:'manufacturer_not_supported', open_count:null, completed_count:null, recalls:[],
      note:'Automated VIN repair status currently supports Tesla only. Use the official VIN checker for other makes; model-year campaigns do not establish applicability or completed repairs.'};
  }
  const old = cache.get(vin);
  if (old && old.expires > Date.now()) return old.result;
  if (pending.has(vin)) return pending.get(vin);
  const task = (async () => {
    const url = `${API}?VIN=${encodeURIComponent(vin)}`;
    const source = {provider:'Tesla Service VIN Recall Search', url, reference_url:verification_url};
    try {
      const response = await fetch(url, {headers:{Accept:'application/json'}, signal:AbortSignal.timeout(10000)});
      if (!response.ok) throw new Error('Upstream unavailable');
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
