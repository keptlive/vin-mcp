export class VinClient {
 constructor({baseUrl='http://127.0.0.1:3200',fetchImpl=globalThis.fetch,timeout=45000}={}){this.baseUrl=baseUrl.replace(/\/$/,'');this.fetch=(...args)=>fetchImpl(...args);this.timeout=timeout;}
 async request(path,body){const r=await this.fetch(this.baseUrl+path,{cache:'no-store',method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(this.timeout)});const data=await r.json();if(!r.ok){const e=new Error(data.error||data.reason||`HTTP ${r.status}`);e.status=r.status;e.data=data;throw e;}return data;}
 decode(vin){return this.request('/api/vin/'+encodeURIComponent(vin));}
 recallStatus(vin){return this.request('/api/vin/'+encodeURIComponent(vin)+'/recall-status');}
 validate(vin){return this.request('/api/vin/'+encodeURIComponent(vin)+'/validate');}
 batch(vins){return this.request('/api/batch',{vins});}
 capabilities(){return this.request('/api/research/capabilities');}
 tools(){return this.request('/api/tools');}
 catalog(level,query={}){return this.request('/api/research/catalog/'+encodeURIComponent(level)+'?'+new URLSearchParams(query));}
 vehicle(id){return this.request('/api/research/epa/'+encodeURIComponent(id));}
 emissions(id){return this.request('/api/research/epa/'+encodeURIComponent(id)+'/emissions');}
 dimensions(query){return this.request('/api/research/dimensions?'+new URLSearchParams(query));}
 communications(query){return this.request('/api/research/communications?'+new URLSearchParams(query));}
 fuelPrices(){return this.request('/api/research/fuel-prices');}
 ownerMpg(id){return this.request('/api/research/epa/'+encodeURIComponent(id)+'/owner-mpg');}
 investigations(query){return this.request('/api/research/investigations?'+new URLSearchParams(query));}
 rateBenchmarks(){return this.request('/api/research/rate-benchmarks');}
 compare(vins){return this.request('/api/research/compare',{vins});}
 scenario(input){return this.request('/api/research/scenario',input);}
}
