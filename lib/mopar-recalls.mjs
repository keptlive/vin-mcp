/** Official public fleet lookup: positive open records only, matched to the full VIN. */
export const MOPAR_LOOKUP = 'https://www.mopar.com/en-us/my-vehicle/recalls/search.html';
export const MOPAR_FLEET = 'https://wrecall.extra.chrysler.com/fleetreports/restricted/wrecall/RecallInq';
const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;
const ENTITIES = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
function cellText(value) {
  return value.replace(/<[^>]*>/g,' ').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole,key)=>{
    if (key[0] !== '#') return ENTITIES[key.toLowerCase()];
    const n = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2),16) : Number(key.slice(1));
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
  }).replace(/\s+/g,' ').trim();
}
export function moparUrl(vin) {
  return MOPAR_FLEET+'?'+new URLSearchParams({vins:vin.slice(-8),language:'E',task:' ',fan:'99999',user:'USER'});
}
export function parseMopar(html, vin) {
  if (typeof html !== 'string' || html.length > 2*1024*1024) throw new Error('Invalid fleet response');
  const headers = [...html.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th\s*>/gi)].map(x=>cellText(x[1]).toUpperCase());
  if (headers.join('|') !== 'VIN LAST 8|VIN FIRST 9|ITEM CODE|FAN|RECALL #|DESCRIPTION|RECALL DATE|DEALER CODE|NAME') throw new Error('Fleet table schema changed');
  const rows=[];
  for (const match of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
    if (!/\bclass\s*=\s*["']tableCell["']/i.test(match[1])) continue;
    const cells=[...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td\s*>/gi)].map(x=>cellText(x[1]));
    if (cells.length !== 9 || !/^[A-HJ-NPR-Z0-9]{8}$/.test(cells[0]) || !/^[A-HJ-NPR-Z0-9]{9}$/.test(cells[1]) || !['RC','RR'].includes(cells[2]) || !cells[4] || !cells[5]) throw new Error('Invalid fleet row');
    const fullVin=cells[1]+cells[0];
    if (!VIN.test(fullVin)) throw new Error('Invalid VIN in fleet row');
    if (fullVin === vin) rows.push(cells);
  }
  if (rows.length > 200) throw new Error('Too many fleet rows');
  // Empty results can also mean an unrecognized VIN, so never translate absence into zero.
  if (!rows.length) return null;
  const campaigns=[],service_campaigns=[],seen=new Set();
  for (const row of rows) {
    const key=row[2]+'|'+row[4];
    if (seen.has(key)) continue;
    seen.add(key);
    const record={campaign_number:row[4],manufacturer_status:'Open Mopar '+row[2]+' record',repair_status:'open',
      recall_date:/^\d{4}-\d{2}-\d{2}$/.test(row[6]) && row[6]>'1900-01-01' ? row[6] : null,
      repair_completed_at:null,summary:row[5],remedy:null,safety_risk:null,bulletin:null,document_url:null,
      stop_drive:/\bSTOP[ -]DRIVE\b/i.test(row[5]),source_item_code:row[2],record_kind:row[2]==='RR'?'rapid_response':'unclassified_recall_or_campaign'};
    campaigns.push(record);
    if(row[2]==='RR')service_campaigns.push(record);
  }
  return {recalls:[],campaigns,service_campaigns,open_count:null,open_record_count:campaigns.length,completed_count:null,unknown_count:0,
    coverage:{open_records:true,completed_history:false,zero_open_verifiable:false,recall_count_verified:false,record_types:'Mopar RC can include safety recalls and other campaigns; RR means Rapid Response'},
    note:'Official Mopar fleet open Recall/Rapid Response lookup. Every record is matched to the full 17-character VIN. RC includes safety recalls and other campaigns; this feed does not reliably distinguish them, so the safety-recall count remains unknown. Completed repairs are not supplied, and an empty lookup does not confirm zero open recalls. Recall date is not repair date.'};
}
