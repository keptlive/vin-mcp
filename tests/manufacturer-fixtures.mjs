export const fordVin='1FTEX1EP4FFD06976',gmVin='1G1FW6S06H4188545',hondaVin='5J6RS6H82RL008945';
export const guestContext={mode:'PROD',app:'siteforce:communityApp',fwuid:'public-framework-version',loaded:{'APPLICATION@markup://siteforce:communityApp':'public-app-version'}};
export const hondaPage=()=>'<script src="/s/sfsites/l/'+encodeURIComponent(JSON.stringify(guestContext))+'/bootstrap.js"></script>';
export function fordState(vin=fordVin){return {isVinInvalid:false,serverUserVin:vin,serverRecallsData:{successfulResponse:true,vehicleDetails:{vin},recallsCount:2,cspCount:1,totalFsaCount:3,
 nhtsa:[{manufacturerRecallNumber:'TEST-S',nhtsaRecallNumber:'TEST-V',recallStatus:'C',recallDate:'2024-01-02',description:'Safety recall',recallDescription:'Original safety issue',remedyDescription:'Dealer inspection',remedyAvailable:true}],
 recalls:[{fsaNumber:'TEST-E',recallStatus:'O',launchDate:'2025-01-02',description:'Emissions recall',remedyAvailable:false}],
 fsa:[{fsaNumber:'TEST-N',recallStatus:'O',launchDate:'2025-02-01',description:'Customer satisfaction program'}]}};}
export function fordPage(state=fordState(),split=false){const line='1:'+JSON.stringify(['$',{},state])+'\n';const parts=split?[line.slice(0,60),line.slice(60)]:[line];return parts.map(s=>'<script>self.__next_f.push('+JSON.stringify([1,s])+')</script>').join('');}
export function gmFixture(vin=gmVin){return {messages:[],serverErrorMsgs:[],data:{vin,gfas:[
 {gfaNumber:'GM-S1',type:'ZPSR',gfaTexts:[{langCode:'EN',subject:'Safety recall',description:'Safety issue',remedy:'Dealer repair'}],governmentAgencies:[{govtAgencyId:'NHTSA',govtAgencyNum:'TEST-V',notificationDate:'2024-01-01'}],vinStatusInfo:{vinStatus:'complete',vinStatusDetailDescription:'Dealer Repaired',repairDate:'2024-02-01',closingDate:'2024-02-03'}},
 {gfaNumber:'GM-S2',type:'ZNCR',gfaTexts:[],vinStatusInfo:{vinStatus:'incomplete',closingDate:'2025-02-01'}},
 {gfaNumber:'GM-S3',type:'ZPSR',gfaTexts:[],vinStatusInfo:{vinStatus:'complete',closingDate:'2025-03-01',vinStatusDetailDescription:'Manual Complete - OTHER'}},
 {gfaNumber:'GM-C1',type:'ZCSP',gfaTexts:[],vinStatusInfo:{vinStatus:'incomplete'}},
 {gfaNumber:'GM-W1',type:'ZSPP',gfaTexts:[],vinStatusInfo:{vinStatus:'incomplete'}}]}};}
export function hondaFixture(vin=hondaVin){return {actions:[{id:'1;a',state:'SUCCESS',error:[],returnValue:{returnValue:{response:{recalls_response:{response:{error:'false',recall:{VIN:vin,division_cd:'A',campaignType:{campaign:[{campaignID:'H-S1',campaignBulletinID:'TEST-B',campaignDescription:'Safety recall',mfrRecallStatus:{value:'Recall INCOMPLETE'},recallDate:'06/04/2026',refreshDate:'10/24/2026',recallDescription:'Safety issue',remedyDescription:'Dealer repair',safetyRiskDescription:'Injury risk',recallNumber:'TEST-V'}]}}}}}}}}]};}
export const nissanVin='1N4AL3APXFN868842';
export const nissanPage='<div class="c_021-0B" data-json-url="/content/nissan_prod/en_US/index/owners/recalls-vin/jcr:content/lookup.recallinfo.json"></div>';
export const nissanFixture=(vin=nissanVin)=>({recalls:[{vin,brand:'NISSAN',typeCode:'Recall Campaign',nissanRecallId:'R21A6',govtRecallId:'20V-315',secondaryDescription:'HOOD LATCH',primaryDescription:'Hood may open while driving.',riskIfNotRepaired:'May obscure driver vision.',remedyDescription:'Inspect and repair hood latch.',defectInfoRptDate:'2020-05-28 00:00:00.0',effectiveDate:'2021-06-23 00:00:00.0'}]});
