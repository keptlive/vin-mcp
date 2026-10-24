import assert from 'node:assert/strict';
import {VinClient} from '../public/client.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const baseUrl=process.env.VIN_BASE_URL||'http://127.0.0.1:3298';
const api=new VinClient({baseUrl});
const options=await api.catalog('options',{year:2003,make:'Honda',model:'Accord'});assert.ok(options.data.some(x=>x.value==='18657'));
const vehicle=await api.vehicle('18657');assert.equal(Number(vehicle.data.comb08),22);
const dims=await api.dimensions({year:2003,make:'Honda',model:'Accord'});assert.ok(dims.data.length>0);
const em=await api.emissions('18657');assert.equal(em.available,true);
const prices=await api.fuelPrices();assert.ok(Number(prices.data.regular)>0);
const comms=await api.communications({year:2023,make:'Toyota',model:'RAV4'});assert.ok(comms.total>0);assert.equal(comms.archives.length,7);
const page2=await api.communications({year:2023,make:'Toyota',model:'RAV4',offset:comms.next_offset});assert.ok(!comms.data.some(x=>page2.data.some(y=>x.id===y.id)));
const calc=await api.scenario({price:20000,apr:0,months:40});assert.equal(calc.financing.monthly_payment,500);
const owner=await api.ownerMpg('18657');assert.ok(owner.data.record_count>0);assert.ok(owner.data.average_mpg>0);
const investigations=await api.investigations({year:2003,make:'Honda',model:'Accord',limit:1});assert.ok(investigations.total>1);assert.ok(investigations.data[0].reports.length>0);
const invPage2=await api.investigations({year:2003,make:'Honda',model:'Accord',limit:1,offset:investigations.next_offset});assert.notEqual(invPage2.data[0].id,investigations.data[0].id);
const rates=await api.rateBenchmarks();assert.equal(rates.source.observation_period,'2026-08');
const recallStatus=await api.recallStatus('5YJSA1DG9DFP14705');assert.equal(recallStatus.available,true);assert.ok(recallStatus.recalls.some(r=>r.repair_status==='completed'));
const comparison=await api.compare(['1HGCM82633A004352','5YJSA1DG9DFP14705']);assert.equal(comparison.results.length,2);assert.equal(comparison.results[1].report.recall_status.available,true);
const client=new Client({name:'research-live-smoke',version:'1'});const transport=new StreamableHTTPClientTransport(new URL(baseUrl+'/mcp'));
try{await client.connect(transport);assert.equal((await client.listTools()).tools.length,22);const result=await client.callTool({name:'manufacturer_communications',arguments:{year:2023,make:'Toyota',model:'RAV4',limit:1}});assert.equal(JSON.parse(result.content[0].text).total,comms.total);
 const recallTool=await client.callTool({name:'vin_recall_status',arguments:{vin:'5YJSA1DG9DFP14705'}});assert.equal(JSON.parse(recallTool.content[0].text).available,true);
 for(const [name,args,field,expected] of [['owner_reported_mpg',{id:'18657'},'data',owner.data],['defect_investigations',{year:2003,make:'Honda',model:'Accord',limit:1},'total',investigations.total],['auto_loan_benchmarks',{},'data',rates.data]]){const r=await client.callTool({name,arguments:args});assert.ok(!r.isError);assert.deepEqual(JSON.parse(r.content[0].text)[field],expected);}
}finally{await transport.terminateSession();await client.close();}
console.log(JSON.stringify({checked_at:new Date().toISOString(),baseUrl,vin_recall_status:{open:recallStatus.open_count,completed:recallStatus.completed_count,checked_at:recallStatus.source.retrieved_at},epa_options:options.data.length,epa_combined_mpg:vehicle.data.comb08,owner_mpg:owner.data,investigations:investigations.total,rate_snapshot:rates.source,dimension_variants:dims.data.length,communications:comms.total,archives:comms.archives.length,tools:22,passed:true},null,2));
