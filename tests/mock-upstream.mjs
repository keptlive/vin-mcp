const json = data => new Response(JSON.stringify(data), {headers:{'content-type':'application/json'}});
const nativeFetch = globalThis.fetch;
globalThis.fetch=async (input,opts)=>{
 const u=String(input);
 if(u.includes('vpic.nhtsa.dot.gov')){
  const vin=u.includes('DecodeVINValuesBatch')?'1HGCM82633A004352':decodeURIComponent(u.split('/').at(-1).split('?')[0]);
  const four=vin.endsWith('353');
  return json({Results:[{VIN:vin,ModelYear:'2003',Make:'HONDA',Model:'Accord',EngineCylinders:four?'4':'6',DisplacementL:four?'2.4':'2.998832712',TransmissionStyle:'Automatic',TransmissionSpeeds:'5',RearVisibilitySystem:'Standard',CIB:'Standard'}]});
 }
 if(u.includes('api.nhtsa.gov/recalls'))return json({results:[]});
 if(u.includes('api.nhtsa.gov/complaints'))return json({results:[]});
 if(u.includes('api.nhtsa.gov/SafetyRatings'))return json({Results:[]});
 if(u.includes('fueleconomy.gov'))return json(u.includes('menu/options')?{menuItem:[{text:'Auto 5-spd, 4 cyl, 2.4 L',value:'18655'},{text:'Auto 5-spd, 6 cyl, 3.0 L',value:'18657'}]}:{id:u.endsWith('18655')?18655:18657,year:2003,make:'Honda',model:'Accord',cylinders:u.endsWith('18655')?4:6,displ:u.endsWith('18655')?2.4:3.0,trany:'Automatic 5-spd',comb08:u.endsWith('18655')?25:22});
 return nativeFetch(input,opts);
};
