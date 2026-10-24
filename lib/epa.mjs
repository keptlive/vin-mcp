/**
 * EPA Fuel Economy API integration.
 * Free, no API key required.
 * Docs: https://www.fueleconomy.gov/feg/ws/
 */

const BASE = 'https://fueleconomy.gov/ws/rest/vehicle';
const FETCH_TIMEOUT = 10_000;

/**
 * Create an AbortSignal that times out after the specified ms.
 */
function timeoutSignal(ms = FETCH_TIMEOUT) {
  return AbortSignal.timeout(ms);
}

/**
 * Parse a numeric string, returning null if not valid.
 */
function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

/**
 * Clean a string value, returning null for empty/missing.
 */
function clean(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  return value;
}

/**
 * Build the empty/unavailable response object.
 */
function unavailable(reason = "not_found") {
  return {
    available: false,
    reason,
    city_mpg: null,
    highway_mpg: null,
    combined_mpg: null,
    annual_fuel_cost: null,
    co2_grams_per_mile: null,
    fuel_type: null,
    fuel_type2: null,
    is_ev: false,
    ev_range: null,
    ev_charge_time_240v: null,
    phev_combined: null,
    cylinders: null,
    displacement: null,
    drive: null,
    transmission: null,
    vehicle_class: null,
  };
}

/**
 * Get fuel economy data for a vehicle.
 * Two-step: first get menu options for the year/make/model, then fetch full data.
 *
 * @param {number|string} year - Model year
 * @param {string} make - Make (e.g., "Toyota")
 * @param {string} model - Model (e.g., "Camry")
 * @returns {object} Fuel economy data
 */
export async function getFuelEconomy(year, make, model, decoded = {}) {
  if (!year || !make || !model) return unavailable('missing_vehicle');
  try {
    // Step 1: Get available options (trims/variants) for this vehicle
    const menuParams = new URLSearchParams({
      year: String(year),
      make: String(make),
      model: String(model),
    });
    const menuUrl = `${BASE}/menu/options?${menuParams}`;

    const menuRes = await fetch(menuUrl, {
      headers: { Accept: 'application/json' },
      signal: timeoutSignal(),
    });

    if (!menuRes.ok) {
      console.error(`[epa] getFuelEconomy menu HTTP ${menuRes.status}`);
      return unavailable('upstream_error');
    }

    const menuData = await menuRes.json();

    // The API returns { menuItem: { value, text } } for single result
    // or { menuItem: [{ value, text }, ...] } for multiple results
    let items = menuData?.menuItem;
    if (!items) {
      return unavailable();
    }

    // Normalize to array
    if (!Array.isArray(items)) {
      items = [items];
    }

    if (items.length === 0) {
      return unavailable();
    }

    // EPA menus describe the engine and transmission. Match every known
    // attribute before fetching details, then verify the actual record too.
    const engine = decoded.engine || {};
    const transmission = decoded.transmission || {};
    const cylinders = num(engine.cylinders);
    const displacement = num(engine.displacement_l);
    const kind = /automatic|cvt|continuously variable/i.test(transmission.type || '') ? 'auto'
      : /manual/i.test(transmission.type || '') ? 'man' : null;
    const speeds = num(transmission.speeds);
    items = items.filter(item => {
      const text = String(item.text || '');
      const cyl = text.match(/(\d+)\s*cyl/i);
      const liters = text.match(/([\d.]+)\s*L\b/i);
      const gears = text.match(/(\d+)\s*-?spd/i);
      if (cylinders && (!cyl || Number(cyl[1]) !== cylinders)) return false;
      if (displacement && (!liters || Math.abs(Number(liters[1]) - displacement) > 0.11)) return false;
      if (kind === 'auto' && !/auto|cvt|variable/i.test(text)) return false;
      if (kind === 'man' && !/^man/i.test(text)) return false;
      if (speeds && gears && Number(gears[1]) !== speeds) return false;
      if (engine.fuel_type === 'Electric' && !/electric/i.test(text)) return false;
      return true;
    });
    if (items.length !== 1) return unavailable(items.length ? 'ambiguous_variant' : 'no_matching_variant');
    const vehicleId = items[0].value;
    if (!vehicleId) {
      return unavailable();
    }

    const detailUrl = `${BASE}/${vehicleId}`;
    const detailRes = await fetch(detailUrl, {
      headers: { Accept: 'application/json' },
      signal: timeoutSignal(),
    });

    if (!detailRes.ok) {
      console.error(`[epa] getFuelEconomy detail HTTP ${detailRes.status}`);
      return unavailable('upstream_error');
    }

    const v = await detailRes.json();
    if (!v || !v.id || Number(v.year) !== Number(year)
        || String(v.make).toLowerCase() !== String(make).toLowerCase()
        || String(v.model).toLowerCase() !== String(model).toLowerCase()) return unavailable('invalid_response');
    if ((cylinders && num(v.cylinders) !== cylinders)
        || (displacement && (num(v.displ) === null || Math.abs(num(v.displ) - displacement) > 0.11))) {
      return unavailable('no_matching_variant');
    }

    // Determine if this is an EV
    const fuelType1 = clean(v.fuelType) || clean(v.fuelType1);
    const fuelType2 = clean(v.fuelType2);
    const isEv = fuelType1 === 'Electricity' && !fuelType2;

    return {
      available: true,
      vehicle_id: String(vehicleId),
      matched_variant: String(items[0].text),
      source_url: `https://www.fueleconomy.gov/feg/Find.do?action=sbs&id=${vehicleId}`,
      city_mpg: num(v.city08) || num(v.cityA08),
      highway_mpg: num(v.highway08) || num(v.highwayA08),
      combined_mpg: num(v.comb08) || num(v.combA08),
      annual_fuel_cost: num(v.fuelCost08) || num(v.fuelCostA08),
      co2_grams_per_mile: num(v.co2TailpipeGpm) ?? num(v.co2TailpipeAGpm),
      fuel_type: fuelType1,
      fuel_type2: fuelType2,
      is_ev: isEv,
      ev_range: num(v.range) || num(v.rangeCity),
      ev_charge_time_240v: num(v.charge240),
      phev_combined: num(v.combE),
      cylinders: num(v.cylinders),
      displacement: num(v.displ),
      drive: clean(v.drive),
      transmission: clean(v.trany),
      vehicle_class: clean(v.VClass),
    };
  } catch (err) {
    console.error(`[epa] getFuelEconomy error:`, err.message);
    return unavailable('upstream_error');
  }
}
