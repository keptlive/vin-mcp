/** Public EPA and Transport Canada research; independent of VIN-specific claims. */
const cache = new Map();
const EPA = 'https://www.fueleconomy.gov/ws/rest';
export class InputError extends Error {}
export function yearValue(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1971 || n > new Date().getUTCFullYear()+2) throw new InputError('Invalid model year');
  return String(n);
}
export function textValue(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100) throw new InputError(`Provide ${name} (1–100 characters)`);
  return value.trim();
}
async function source(url, provider, validate = () => true) {
  const old = cache.get(url);
  if (old && old.expires > Date.now()) return old.value;
  try {
    const r = await fetch(url, {headers:{Accept:'application/json'}, signal:AbortSignal.timeout(12000)});
    if (!r.ok) throw Error('HTTP '+r.status);
    const data = await r.json();
    if (!validate(data)) return {available:false,reason:'invalid_response',source:{provider,url},data:null};
    const value = {available:true, source:{provider,url,retrieved_at:new Date().toISOString()},data};
    if (cache.size >= 300) cache.delete(cache.keys().next().value);
    cache.set(url,{expires:Date.now()+3600000,value});
    return value;
  } catch {
    return {available:false,reason:'upstream_unavailable',source:{provider,url},data:null};
  }
}
export async function catalog(level, query={}) {
  if (!['year','make','model','options'].includes(level)) throw new InputError('Unknown catalog level');
  const params = new URLSearchParams();
  if (level !== 'year') params.set('year',yearValue(query.year));
  if (['model','options'].includes(level)) params.set('make',textValue(query.make,'make'));
  if (level === 'options') params.set('model',textValue(query.model,'model'));
  const r = await source(`${EPA}/vehicle/menu/${level}?${params}`, 'EPA FuelEconomy.gov', d => d === null || (d && (Array.isArray(d.menuItem) ? d.menuItem : [d.menuItem]).every(i => i && typeof i.value === 'string' && typeof i.text === 'string')));
  if (!r.available) return r;
  const items=r.data?.menuItem;
  if (!items) return {...r,data:[]};
  const data=(Array.isArray(items)?items:[items]).map(i=>({value:String(i.value),text:String(i.text)}));
  return {...r,data,scope:'vehicle configuration; not VIN-specific'};
}
export async function epaRecord(id) {
  if (!/^\d{1,6}$/.test(String(id))) throw new InputError('Invalid EPA vehicle ID');
  const r=await source(`${EPA}/vehicle/${id}`,'EPA FuelEconomy.gov', d => d && String(d.id)===String(id) && d.year && d.make && d.model);
  return {...r,scope:'EPA test configuration; not an exact-VIN match',reference_url:`https://www.fueleconomy.gov/feg/Find.do?action=sbs&id=${id}`};
}
export async function emissions(id) {
  if (!/^\d{1,6}$/.test(String(id))) throw new InputError('Invalid EPA vehicle ID');
  return {...await source(`${EPA}/vehicle/emissions/${id}`,'EPA emissions',d => d===null || (d && (Array.isArray(d.emissionsInfo)?d.emissionsInfo:[d.emissionsInfo]).every(x=>x && String(x.id)===String(id)))),scope:'EPA test configuration'};
}
export async function fuelPrices() {
  return {...await source(`${EPA}/fuelprices`,'EPA FuelEconomy.gov', d => d && ['regular','electric'].every(k => d[k] !== null && d[k] !== '' && Number.isFinite(Number(d[k])) && Number(d[k])>0)),scope:'EPA calculation assumptions; not a local pump-price quote',units:{regular:'USD/gallon',midgrade:'USD/gallon',premium:'USD/gallon',diesel:'USD/gallon',e85:'USD/gallon',electric:'USD/kWh'}};
}
export async function dimensions(query) {
  const params=new URLSearchParams({year:yearValue(query.year),make:textValue(query.make,'make'),model:textValue(query.model,'model'),units:'Metric',format:'json'});
  const r=await source('https://vpic.nhtsa.dot.gov/api/vehicles/GetCanadianVehicleSpecifications/?'+params,'Transport Canada via NHTSA vPIC', d => Array.isArray(d?.Results) && d.Results.every(x => Array.isArray(x.Specs)));
  return {...r,data:r.available?r.data.Results:null,scope:'Canadian model variants; select the applicable configuration; not VIN-specific',units:'lengths cm, mass kg',coverage_note:'An empty result means no matching records, not zero dimensions.'};
}

export async function ownerMpg(id) {
  if (!/^\d{1,6}$/.test(String(id))) throw new InputError('Invalid EPA vehicle ID');
  const numeric=v=>v!==null && v!==undefined && v!=='' && Number.isFinite(Number(v));
  const r=await source(`${EPA}/ympg/shared/ympgVehicle/${id}`,'FuelEconomy.gov Your MPG',d => d && String(d.vehicleId)===String(id) && numeric(d.recordCount) && Number.isInteger(Number(d.recordCount)) && Number(d.recordCount)>=0 && (Number(d.recordCount)===0 || ['avgMpg','minMpg','maxMpg'].every(k=>numeric(d[k]) && Number(d[k])>0)));
  const data=r.available?{vehicle_id:String(id),record_count:Number(r.data.recordCount),average_mpg:Number(r.data.recordCount)?Number(r.data.avgMpg):null,minimum_mpg:Number(r.data.recordCount)?Number(r.data.minMpg):null,maximum_mpg:Number(r.data.recordCount)?Number(r.data.maxMpg):null,city_percent:numeric(r.data.cityPercent)?Number(r.data.cityPercent):null,highway_percent:numeric(r.data.highwayPercent)?Number(r.data.highwayPercent):null}:null;
  return {...r,data,scope:'Voluntary owner reports for this EPA configuration; not a representative sample or an exact-VIN measurement',method:'Harmonic mean of owner-submitted MPG. Record count is not necessarily a count of unique drivers.',reference_url:'https://www.fueleconomy.gov/feg/ws/'};
}
