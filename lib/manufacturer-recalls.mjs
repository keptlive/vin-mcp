/** Public manufacturer records. Parse data only; never execute upstream scripts. */
export const FORD_LOOKUP='https://www.ford.com/support/recalls-details/';
export const GM_LOOKUP='https://experience.gm.com/ownercenter/recalls';
export const HONDA_LOOKUP='https://mygarage.honda.com/s/recall-search?brand=honda';
export const GM_API='https://experience.gm.com/ownercenter/api/';
export const HONDA_API='https://mygarage.honda.com/s/sfsites/aura';
const text=v=>typeof v==='string' && v.trim() && !v.startsWith('$') ? v.trim() : null;
export function isoDate(v){
 if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||v<='1900-01-01')return null;
 const d=new Date(v+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===v?v:null;
}
function records(value){if(!Array.isArray(value)||value.length>200)throw Error('Invalid campaign array');return value;}
function unique(rows){
 const found=new Map();
 for(const row of rows){const key=row.record_kind+'|'+row.campaign_number,old=found.get(key);if(old&&JSON.stringify(old)!==JSON.stringify(row))throw Error('Conflicting campaign records');found.set(key,row);}
 return [...found.values()];
}
function summary(rows,service,note,coverage={}){
 const recalls=unique(rows),service_campaigns=unique(service),unknown_count=recalls.filter(r=>r.repair_status==='unknown').length;
 return {recalls,service_campaigns,open_count:unknown_count?null:recalls.filter(r=>r.repair_status==='open').length,
  completed_count:unknown_count?null:recalls.filter(r=>r.repair_status==='completed').length,unknown_count,
  service_campaign_count:service_campaigns.length,
  coverage:{completed_history:true,zero_open_verifiable:true,record_count_scope:'Returned manufacturer campaign records, not distinct NHTSA defects or a complete service history',...coverage},note};
}
function baseRecord(id,status,repairStatus,kind){if(!text(id))throw Error('Missing campaign identifier');return {campaign_number:id,manufacturer_status:status,repair_status:repairStatus,record_kind:kind,repair_completed_at:null,recall_date:null,summary:null,remedy:null,safety_risk:null,bulletin:null,document_url:null};}

export function parseFord(html,vin){
 if(typeof html!=='string'||html.length>2*1024*1024)throw Error('Invalid Ford page');
 const chunks=[...html.matchAll(/self\.__next_f\.push\((\[1,"(?:\\.|[^"\\])*"\])\)/g)].map(m=>JSON.parse(m[1])[1]);
 const candidates=[];
 const walk=(v,depth=0)=>{if(depth>50)throw Error('Invalid page depth');if(!v||typeof v!=='object')return;if(Object.hasOwn(v,'serverRecallsData'))candidates.push(v);for(const x of Object.values(v))walk(x,depth+1);};
 for(const line of chunks.join('').split('\n')){let value;try{value=JSON.parse(line.slice(line.indexOf(':')+1));}catch{continue;}walk(value);}
 if(candidates.length!==1)throw Error('Ford page schema changed');
 const p=candidates[0],d=p.serverRecallsData;
 if(p.isVinInvalid!==false||p.serverUserVin!==vin||d?.successfulResponse!==true||d?.vehicleDetails?.vin!==vin)return null;
 const recalls=[],service=[];
 for(const [key,kind,target] of [['nhtsa','safety_recall',recalls],['recalls','manufacturer_recall',recalls],['fsa','customer_satisfaction',service]]){
  for(const r of records(d[key])){
   if(!r||typeof r!=='object')throw Error('Invalid Ford record');
   const raw=text(r.recallStatus),state=raw==='C'?'completed':raw==='O'?'open':'unknown';
   const x=baseRecord(text(r.manufacturerRecallNumber)||text(r.fsaNumber)||text(r.nhtsaRecallNumber),raw==='C'?'Recall complete (C)':raw==='O'?'Recall incomplete (O)':raw||'Unknown',state,kind);
   Object.assign(x,{nhtsa_campaign_number:text(r.nhtsaRecallNumber)||text(r.govtRecallNumber),source_status_code:raw,
    recall_date:isoDate(r.recallDate)||isoDate(r.launchDate),summary:text(r.recallDescription)||text(r.description),title:text(r.description),
    remedy:text(r.remedyDescription),safety_risk:text(r.safetyRiskDescription),remedy_available:typeof r.remedyAvailable==='boolean'?r.remedyAvailable:null,
    stop_drive:/\bDO NOT DRIVE\b/i.test([x.summary,r.description,r.safetyRiskDescription].join(' '))});
   target.push(x);
  }
 }
 if(d.recallsCount!==recalls.length||d.cspCount!==service.length||d.totalFsaCount!==recalls.length+service.length)throw Error('Incomplete Ford records');
 return summary(recalls,service,'Official Ford VIN page: safety and environmental recalls since January 1, 2004. Customer-satisfaction programs are separate. Counts refer to the returned records. Completed status is manufacturer-reported; no repair date is supplied. Reporting delays and coverage limits apply.',{since:'2004-01-01',market:'United States'});
}

export function parseGm(body,vin){
 const d=body?.data;
 if(!Array.isArray(body?.messages)||!Array.isArray(body?.serverErrorMsgs)||body.messages.length||body.serverErrorMsgs.length)throw Error('GM upstream error');
 if(d?.vin!==vin)return null;
 const recalls=[],service=[];
 const kinds={ZPSR:'safety_recall',ZNCR:'noncompliance_recall',ZPER:'emissions_recall',ZCSP:'customer_satisfaction',ZSPP:'special_coverage'};
 for(const r of records(d.gfas)){
  if(!r||!Object.hasOwn(kinds,r.type)||!Array.isArray(r.gfaTexts))throw Error('Unknown GM record type');
  const status=text(r.vinStatusInfo?.vinStatus),state=status==='complete'?'completed':status==='incomplete'?'open':'unknown';
  const x=baseRecord(r.gfaNumber,status||'Unknown',state,kinds[r.type]),details=r.gfaTexts.find(t=>t.langCode==='EN')||{};
  const agencies=Array.isArray(r.governmentAgencies)?r.governmentAgencies:[];
  Object.assign(x,{source_item_code:r.type,completion_description:text(r.vinStatusInfo?.vinStatusDetailDescription),
   manufacturer_closed_at:state==='completed'?isoDate(r.vinStatusInfo?.closingDate):null,
   repair_completed_at:state==='completed'?isoDate(r.vinStatusInfo?.repairDate):null,
   recall_date:isoDate(agencies.find(a=>a.govtAgencyId==='NHTSA')?.notificationDate)||isoDate(r.validStartDate),
   nhtsa_campaign_number:text(agencies.find(a=>a.govtAgencyId==='NHTSA')?.govtAgencyNum),
   title:text(details.subject)||text(r.title),summary:text(details.description)||text(r.title),remedy:text(details.remedy),safety_risk:text(details.safetyRisk)});
  (['ZPSR','ZNCR','ZPER'].includes(r.type)?recalls:service).push(x);
 }
 return summary(recalls,service,'Official GM VIN lookup: safety, noncompliance and emissions recall records; customer-satisfaction and special-coverage programs are separate. GM complete status can mean an administrative closure, not a physical repair. A repair date is shown only when explicitly supplied; closing date is separate. Multiple records may refer to the same NHTSA campaign. Coverage begins August 20, 1999; reporting delays apply.',{since:'1999-08-20',market:'United States',completion_is_not_always_repair:true});
}

export function hondaContext(html){
 const m=typeof html==='string'&&html.match(/\/s\/sfsites\/l\/(%7B[^/]+%7D)\/bootstrap/);
 if(!m)throw Error('Honda guest page changed');
 const c=JSON.parse(decodeURIComponent(m[1]));
 if(c.mode!=='PROD'||c.app!=='siteforce:communityApp'||typeof c.fwuid!=='string'||c.fwuid.length>300||typeof c.loaded?.['APPLICATION@markup://siteforce:communityApp']!=='string')throw Error('Honda guest context changed');
 return {mode:c.mode,fwuid:c.fwuid,app:c.app,loaded:{'APPLICATION@markup://siteforce:communityApp':c.loaded['APPLICATION@markup://siteforce:communityApp']},dn:[],globals:{},uad:false};
}
export function hondaRequest(vin,context){
 const actions=[{id:'1;a',descriptor:'aura://ApexActionController/ACTION$execute',callingDescriptor:'UNKNOWN',params:{namespace:'',classname:'OwnAPIController',method:'getRecallsByProductIdentifier',params:{productIdentifier:vin,divisionId:'A'},cacheable:true,isContinuation:false}}];
 return {method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'},body:new URLSearchParams({message:JSON.stringify({actions}),'aura.context':JSON.stringify(context),'aura.pageURI':'/s/recall-search?brand=honda','aura.token':'null'}).toString()};
}
export function parseHonda(body,vin){
 const actions=body?.actions;
 if(!Array.isArray(actions)||actions.length!==1||actions[0].id!=='1;a'||actions[0].state!=='SUCCESS'||!Array.isArray(actions[0].error)||actions[0].error.length)throw Error('Honda upstream error');
 const response=actions[0]?.returnValue?.returnValue?.response?.recalls_response?.response;
 if(![false,'false'].includes(response?.error))throw Error('Honda lookup error');
 const r=response.recall;
 if(r?.VIN!==vin||r.division_cd!=='A')return null;
 const rows=records(r.campaignType?.campaign).map(c=>{
  if(!c||typeof c!=='object')throw Error('Invalid Honda record');
  const status=text(c.mfrRecallStatus?.value),state=status?.toUpperCase()==='RECALL INCOMPLETE'?'open':status?.toUpperCase()==='RECALL COMPLETED'?'completed':'unknown';
  const x=baseRecord(c.campaignID,status||'Unknown',state,'safety_recall');
  let date=null;if(typeof c.recallDate==='string'){const m=c.recallDate.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);if(m)date=isoDate(m[3]+'-'+m[1]+'-'+m[2]);}
  return {...x,nhtsa_campaign_number:text(c.recallNumber),recall_date:date,title:text(c.campaignDescription),summary:text(c.recallDescription),remedy:text(c.remedyDescription),safety_risk:text(c.safetyRiskDescription),bulletin:text(c.campaignBulletinID),source_updated_at:text(c.refreshDate)};
 });
 const result=summary(rows,[],'Official Honda MyGarage guest VIN lookup: active safety recalls announced in the past 15 calendar years for U.S. Honda automobiles. Completed repair history is not supplied; absence does not establish a completed repair. Recall date is not repair date. Reporting delays apply.',{completed_history:false,lookback_calendar_years:15,market:'United States'});
 // This public search is an active-recall feed, not a completed-history endpoint.
 result.completed_count=null;return result;
}
