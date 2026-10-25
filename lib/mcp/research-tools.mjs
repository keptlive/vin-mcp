import * as z from 'zod/v4';
import { catalog, epaRecord, emissions, fuelPrices, dimensions, ownerMpg, InputError } from '../research.mjs';
import { investigations } from '../investigations.mjs';
import { rateBenchmarks } from '../rate-benchmarks.mjs';
import { scenario } from '../scenario.mjs';
import { communications } from '../communications.mjs';
import { capabilities } from '../capabilities.mjs';
import { vinRecallStatus } from '../recall-status.mjs';
import { compareVehicles } from '../reports.mjs';

export function researchTools(add) {
  const researchTool=(name,description,schema,fn)=>add(name,description,schema,async args=>{
    try {const result=await fn(args);return {content:[{type:'text',text:JSON.stringify(result)}],...(result?.available===false?{isError:true}:{})};}
    catch(err){return {content:[{type:'text',text:err instanceof InputError?err.message:'Research request failed'}],isError:true};}
  });
  const vehicleQuery={year:z.number().int(),make:z.string().min(1).max(100),model:z.string().min(1).max(100)};
  researchTool('explore_capabilities','Discover supported features and explicit coverage gaps.',{},()=>capabilities);
  researchTool('vin_recall_status','VIN-specific manufacturer-reported open and completed recall status. Tesla and Ford open/completed states; GM completed/closed states with explicit repair dates where supplied; Honda active safety recalls; Nissan positive open safety recalls; Mopar positive open records matched to the full VIN. Service programs are separate. Toyota, Hyundai and Kia require interactive official verification. Unknowns are never zero. Not a complete service history.',{vin:z.string()},({vin})=>vinRecallStatus(vin));
  researchTool('vehicle_catalog','Browse EPA year, make, model and configuration menus. Not sale listings.',{level:z.enum(['year','make','model','options']),year:z.number().int().optional(),make:z.string().optional(),model:z.string().optional()},({level,...query})=>catalog(level,query));
  researchTool('epa_vehicle','Get an explicitly selected EPA test configuration; not an exact VIN match.',{id:z.string()},({id})=>epaRecord(id));
  researchTool('vehicle_emissions','Get EPA emissions for an explicit EPA vehicle ID.',{id:z.string()},({id})=>emissions(id));
  researchTool('fuel_price_assumptions','EPA fuel-price assumptions, not local station prices.',{},fuelPrices);
  researchTool('owner_reported_mpg','Voluntary owner-reported MPG for an EPA configuration, including sample size and limitations.',{id:z.string()},({id})=>ownerMpg(id));
  researchTool('defect_investigations','Search NHTSA model-year defect investigations with retained source variants and snapshot dates.',{...vehicleQuery,offset:z.number().int().min(0).optional(),limit:z.number().int().min(1).max(50).optional()},investigations);
  researchTool('auto_loan_benchmarks','Dated Federal Reserve new-car loan benchmark snapshot, not personalized or live loan rates.',{},rateBenchmarks);
  researchTool('vehicle_dimensions','Canadian model-variant dimensions in cm and kg. Not VIN-specific.',vehicleQuery,dimensions);
  researchTool('manufacturer_communications','Search indexed NHTSA communications, with source coverage. Bulletins are not recalls.',{...vehicleQuery,offset:z.number().int().min(0).optional(),limit:z.number().int().min(1).max(50).optional()},communications);
  researchTool('compare_vehicles','Compare 2–4 distinct VINs without treating missing data as zero or counts as safety rankings.',{vins:z.array(z.string()).min(2).max(4)},({vins})=>compareVehicles(vins));
  researchTool('ownership_scenario','Calculate fixed-rate payments and optional ownership costs from explicit assumptions; not lender or tax quotes.',{price:z.number(),apr:z.number(),months:z.number().int(),down_payment:z.number().optional(),tax_amount:z.number().optional(),fees:z.number().optional(),ownership:z.object({years:z.number().int(),annual_miles:z.number(),resale_value:z.number(),annual_insurance:z.number(),annual_maintenance:z.number(),annual_repairs:z.number(),energy_type:z.enum(['gas','electric']),energy_price:z.number(),efficiency:z.number()}).optional()},scenario);

}
