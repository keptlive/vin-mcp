import * as z from 'zod/v4';
import { validateVin, normalizeVin } from '../validate.mjs';
import { decodeVin as nhtsaDecode, batchDecode, getRecalls } from '../nhtsa.mjs';
import { fullReport, mcpReport } from '../reports.mjs';

export function vehicleTools(add) {
  add('decode_vin',
    'Decode a VIN and return a vehicle report: specs, recalls, a complaint summary with the most recent complaints, safety ratings, fuel economy, and photo URLs.',
    { vin: z.string().describe('17-character Vehicle Identification Number') },
    async ({ vin }) => {
      const report = mcpReport(await fullReport(vin));
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
      const recalls = await getRecalls(make, model, year);
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
