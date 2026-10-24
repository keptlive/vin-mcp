#!/usr/bin/env node
import { VinClient } from './public/client.mjs';
const client=new VinClient({baseUrl:process.env.VIN_BASE_URL||'http://127.0.0.1:3200'});
const [command,arg,extra]=process.argv.slice(2);
const parse=s=>JSON.parse(s||'{}');
const commands={investigations:()=>client.investigations(parse(arg)),rates:()=>client.rateBenchmarks(),'owner-mpg':()=>client.ownerMpg(arg),capabilities:()=>client.capabilities(),decode:()=>client.decode(arg),validate:()=>client.validate(arg),catalog:()=>client.catalog(arg,parse(extra)),vehicle:()=>client.vehicle(arg),emissions:()=>client.emissions(arg),dimensions:()=>client.dimensions(parse(arg)),communications:()=>client.communications(parse(arg)),prices:()=>client.fuelPrices(),compare:()=>client.compare(parse(arg)),batch:()=>client.batch(parse(arg)),scenario:()=>client.scenario(parse(arg))};
if(!command||command==='help'){console.log('vin-tools <'+Object.keys(commands).join('|')+'> [argument] [JSON]\nDefault server: http://127.0.0.1:3200; override VIN_BASE_URL. Start the source build before use.');}
else if(!commands[command]){console.error('Unknown command. Run vin-tools help.');process.exitCode=1;}
else{try{console.log(JSON.stringify(await commands[command](),null,2));}catch(e){console.error(e.message);process.exitCode=1;}}
