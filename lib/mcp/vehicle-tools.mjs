import * as z from 'zod/v4';
import { validateVin, normalizeVin } from '../validate.mjs';
import { decodeVin as nhtsaDecode, batchDecode } from '../nhtsa.mjs';
import { fullReport, mcpReport, modelYearRecalls, COMPLAINTS_WAIT_MS } from '../reports.mjs';
import { applyOwnerDetails } from '../transmission-choice.mjs';

export function vehicleTools(add) {
  add('decode_vin',
    'Decode a VIN and return a vehicle report: specs, recalls (with manufacturer build-date ranges), a complaint summary with the most recent complaints, safety ratings, fuel economy, EPA test-vehicle data, parts content and origin (MY2020+), historical production and theft (MY1998-2012), and photos of NHTSA\'s own test vehicle (photos: null when none of the same make, model, body style and generation was tested; never the decoded vehicle, no stock photos; each item names its test car, NHTSA test and phase, before or after the crash test). decode_checks checks the official decode field by field (drive, engine, electrification, transmission, speeds, seats, GVWR) against mcp.vin\'s reviewed fixes of NHTSA\'s vPIC rules, NHTSA test vehicles with the same VIN pattern and EPA\'s configurations: confirmed, corrected, doubtful or filled, with vPIC\'s original value kept. recalls are NHTSA\'s campaigns for the make, model and year, not this vehicle\'s repair status. mcp.vin does not check a VIN\'s recall repairs with the manufacturer or NHTSA: recall_status gives links to check them (manufacturer_lookup_url, VIN filled in where vin_prefilled is true; nhtsa_lookup_url), with open_count and completed_count null (unknown, never zero). NHTSA\'s complaint list for a common model can take 15 s or more: complaints.pending true is unknown, not zero; call decode_vin again in a minute (cached once it arrives).',
    { vin: z.string().describe('17-character Vehicle Identification Number'),
      transmission: z.optional(z.enum(['automatic', 'manual'])).describe('Transmission, when the owner knows it and the VIN does not say. Applies to fuel economy only when EPA lists the model with both; without it an automatic is assumed and marked (fuel_economy.assumed, alternatives).') },
    // A recall_wait argument from older clients is dropped by the schema (there is no maker lookup to wait for).
    async ({ vin, transmission }) => {
      const report = mcpReport(applyOwnerDetails(await fullReport(vin, { complaintsWaitMs: COMPLAINTS_WAIT_MS.mcp }), { transmission }, { by: 'request' }));
      return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
    }
  );

  add('validate_vin',
    'Quickly validate a VIN without calling any external APIs.',
    { vin: z.string().describe('VIN to validate') },
    async ({ vin }) => {
      const result = validateVin(vin);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  add('lookup_recalls',
    'Look up recalls for a vehicle. Provide either a VIN or make/model/year.',
    {
      vin: z.optional(z.string()).describe('VIN to look up recalls for'),
      make: z.optional(z.string()).describe('Vehicle make (e.g. Honda)'),
      model: z.optional(z.string()).describe('Vehicle model (e.g. Civic)'),
      year: z.optional(z.number()).describe('Model year (e.g. 2020)'),
    },
    async ({ vin, make, model, year }) => {
      if (vin) {
        if (!validateVin(vin).valid) return { content: [{ type: 'text', text: 'Provide a valid VIN (format and checksum)' }], isError: true };
        const decoded = await nhtsaDecode(normalizeVin(vin));
        if (!decoded) return { content: [{ type: 'text', text: 'Failed to decode VIN' }] };
        make = decoded.vehicle.make; model = decoded.vehicle.model; year = decoded.vehicle.year;
      }
      if (!make || !model || !year) return { content: [{ type: 'text', text: 'Provide a VIN or make + model + year' }] };
      const recalls = await modelYearRecalls(make, model, year);
      return { content: [{ type: 'text', text: JSON.stringify(recalls, null, 2) }] };
    }
  );

  add('batch_decode',
    'Decode multiple VINs at once (up to 50).',
    { vins: z.array(z.string()).min(1).max(50).describe('Array of VINs to decode (max 50)') },
    async ({ vins }) => {
      if (vins.length > 50) return { content: [{ type: 'text', text: 'Maximum 50 VINs per batch' }], isError: true };
      if (!vins.length || vins.some(v => !validateVin(v).valid)) return { content: [{ type: 'text', text: 'Provide 1–50 valid VINs (format and checksum)' }], isError: true };
      const results = (await batchDecode(vins.map(normalizeVin))).map(r => {
        if (!r) return r;
        const { raw, ...rest } = r;
        return rest;
      });
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

}
