/**
 * NHTSA (National Highway Traffic Safety Administration) API integration.
 * All endpoints are free and require no API key.
 * Docs: https://vpic.nhtsa.dot.gov/api/
 */

const VPIC_BASE = 'https://vpic.nhtsa.dot.gov/api/vehicles';
const RECALLS_BASE = 'https://api.nhtsa.gov/recalls/recallsByVehicle';
const COMPLAINTS_BASE = 'https://api.nhtsa.gov/complaints/complaintsByVehicle';
const SAFETY_BASE = 'https://api.nhtsa.gov/SafetyRatings';

const FETCH_TIMEOUT = 10_000;

/**
 * Create an AbortSignal that times out after the specified ms.
 */
function timeoutSignal(ms = FETCH_TIMEOUT) {
  return AbortSignal.timeout(ms);
}

/**
 * Convert empty strings and "Not Applicable" to null, trim whitespace.
 */
function clean(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === 'Not Applicable') return null;
    return trimmed;
  }
  return value;
}

/**
 * Parse a numeric string, returning null if not a valid number.
 */
function num(value) {
  const cleaned = clean(value);
  if (cleaned === null) return null;
  const n = Number(cleaned);
  return Number.isNaN(n) ? null : n;
}

/**
 * Parse a NHTSA decoded result into categorized fields.
 */
function parseDecodedResult(r) {
  return {
    vehicle: {
      year: num(r.ModelYear),
      make: clean(r.Make),
      make_id: num(r.MakeID),
      model: clean(r.Model),
      model_id: num(r.ModelID),
      trim: clean(r.Trim),
      body_class: clean(r.BodyClass),
      doors: num(r.Doors),
      vehicle_type: clean(r.VehicleType),
    },
    engine: {
      type: clean(r.EngineModel),
      cylinders: num(r.EngineCylinders),
      displacement_cc: num(r.DisplacementCC),
      displacement_l: num(r.DisplacementL),
      hp: num(r.EngineHP),
      fuel_type: clean(r.FuelTypePrimary),
      fuel_injection: clean(r.FuelInjectionType),
      turbo: clean(r.Turbo),
      ev_type: clean(r.ElectrificationLevel),
      battery_kwh: num(r.BatteryKWh),
    },
    transmission: {
      type: clean(r.TransmissionStyle),
      speeds: num(r.TransmissionSpeeds),
      drive_type: clean(r.DriveType),
    },
    dimensions: {
      gvwr: clean(r.GVWR),
      gvwr_to: clean(r.GVWR_to),
      curb_weight: num(r.CurbWeightLB),
      wheel_base: num(r.WheelBaseShort),
      track_width: num(r.TrackWidth),
    },
    plant: {
      city: clean(r.PlantCity),
      state: clean(r.PlantState),
      country: clean(r.PlantCountry),
      company: clean(r.PlantCompanyName),
    },
    safety: {
      abs: clean(r.ABS),
      esc: clean(r.ESC),
      traction_control: clean(r.TractionControl),
      tpms: clean(r.TPMS),
      airbags_front: clean(r.AirBagLocFront),
      airbags_side: clean(r.AirBagLocSide),
      airbags_curtain: clean(r.AirBagLocCurtain),
      airbags_knee: clean(r.AirBagLocKnee),
      forward_collision_warning: clean(r.ForwardCollisionWarning),
      lane_departure_warning: clean(r.LaneDepartureWarning),
      lane_keeping: clean(r.LaneKeepSystem),
      adaptive_cruise: clean(r.AdaptiveCruiseControl),
      backup_camera: clean(r.BackupCamera),
      parking_assist: clean(r.ParkAssist),
      blind_spot: clean(r.BlindSpotMon),
      auto_emergency_braking: clean(r.AutomaticEmergencyBraking),
      pedestrian_detection: clean(r.PedestrianAutomaticEmergencyBraking),
      daytime_running_lights: clean(r.DaytimeRunningLight),
      headlamp_type: clean(r.AdaptiveHeadlights),
      pretensioner: clean(r.Pretensioner),
      seat_belt_type: clean(r.SeatBeltsAll),
    },
    raw: { ...r },
  };
}

/**
 * Decode a single VIN using the NHTSA vPIC API.
 * @param {string} vin - 17-character VIN
 * @returns {object|null} Parsed vehicle data or null on error
 */
export async function decodeVin(vin) {
  try {
    const url = `${VPIC_BASE}/DecodeVinValues/${encodeURIComponent(vin)}?format=json`;
    const res = await fetch(url, { signal: timeoutSignal() });

    if (!res.ok) {
      console.error(`[nhtsa] decodeVin HTTP ${res.status} for ${vin}`);
      return null;
    }

    const data = await res.json();
    const results = data?.Results;
    if (!results || results.length === 0) {
      console.error(`[nhtsa] decodeVin no results for ${vin}`);
      return null;
    }

    return parseDecodedResult(results[0]);
  } catch (err) {
    console.error(`[nhtsa] decodeVin error for ${vin}:`, err.message);
    return null;
  }
}

/**
 * Batch decode up to 50 VINs in a single request.
 * @param {string[]} vins - Array of VINs (max 50)
 * @returns {object[]} Array of parsed results (null entries for failures)
 */
export async function batchDecode(vins) {
  if (!Array.isArray(vins) || vins.length === 0) return [];

  const batch = vins.slice(0, 50);

  try {
    const url = `${VPIC_BASE}/DecodeVINValuesBatch/`;
    // Format: "vin1,;vin2,;vin3,"
    const body = `DATA=${batch.map(v => `${v},`).join(';')}&format=json`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: timeoutSignal(),
    });

    if (!res.ok) {
      console.error(`[nhtsa] batchDecode HTTP ${res.status}`);
      return batch.map(() => null);
    }

    const data = await res.json();
    const results = data?.Results;
    if (!results || results.length === 0) {
      console.error(`[nhtsa] batchDecode no results`);
      return batch.map(() => null);
    }

    return results.map(r => {
      try {
        return parseDecodedResult(r);
      } catch {
        return null;
      }
    });
  } catch (err) {
    console.error(`[nhtsa] batchDecode error:`, err.message);
    return batch.map(() => null);
  }
}

/**
 * Get recall data for a specific vehicle.
 * @param {string} make
 * @param {string} model
 * @param {number|string} year
 * @returns {object} { count, recalls }
 */
export async function getRecalls(make, model, year) {
  try {
    const params = new URLSearchParams({
      make: String(make),
      model: String(model),
      modelYear: String(year),
    });
    const url = `${RECALLS_BASE}?${params}`;
    const res = await fetch(url, { signal: timeoutSignal() });

    if (!res.ok) {
      console.error(`[nhtsa] getRecalls HTTP ${res.status}`);
      return { count: 0, recalls: [] };
    }

    const data = await res.json();
    const results = data?.results || [];

    const recalls = results.map(r => ({
      campaign_number: clean(r.NHTSACampaignNumber),
      component: clean(r.Component),
      summary: clean(r.Summary),
      consequence: clean(r.Consequence),
      remedy: clean(r.Remedy),
      report_date: clean(r.ReportReceivedDate),
      manufacturer: clean(r.Manufacturer),
    }));

    return { count: recalls.length, recalls };
  } catch (err) {
    console.error(`[nhtsa] getRecalls error:`, err.message);
    return { count: 0, recalls: [] };
  }
}

/**
 * Get complaint data for a specific vehicle.
 * @param {string} make
 * @param {string} model
 * @param {number|string} year
 * @returns {object} { count, complaints, summary }
 */
export async function getComplaints(make, model, year) {
  try {
    const params = new URLSearchParams({
      make: String(make),
      model: String(model),
      modelYear: String(year),
    });
    const url = `${COMPLAINTS_BASE}?${params}`;
    const res = await fetch(url, { signal: timeoutSignal() });

    if (!res.ok) {
      console.error(`[nhtsa] getComplaints HTTP ${res.status}`);
      return { count: 0, complaints: [], summary: { crashes: 0, fires: 0, injuries: 0, deaths: 0 } };
    }

    const data = await res.json();
    const results = data?.results || [];

    let crashes = 0;
    let fires = 0;
    let injuries = 0;
    let deaths = 0;

    const complaints = results.map(r => {
      const crash = r.crash === 'YES' || r.crash === true;
      const fire = r.fire === 'YES' || r.fire === true;
      const injuryCount = num(r.numberOfInjuries) || 0;
      const deathCount = num(r.numberOfDeaths) || 0;

      if (crash) crashes++;
      if (fire) fires++;
      injuries += injuryCount;
      deaths += deathCount;

      return {
        odi_number: clean(r.odiNumber),
        date_of_incident: clean(r.dateOfIncident),
        date_complaint_filed: clean(r.dateComplaintFiled),
        component: clean(r.components),
        summary: clean(r.summary),
        crash,
        fire,
        injuries: injuryCount,
        deaths: deathCount,
      };
    });

    return {
      count: complaints.length,
      complaints,
      summary: { crashes, fires, injuries, deaths },
    };
  } catch (err) {
    console.error(`[nhtsa] getComplaints error:`, err.message);
    return { count: 0, complaints: [], summary: { crashes: 0, fires: 0, injuries: 0, deaths: 0 } };
  }
}

/**
 * Get NCAP safety ratings for a specific vehicle.
 * Two-step: first find vehicle variants, then fetch details.
 * @param {string} make
 * @param {string} model
 * @param {number|string} year
 * @returns {object} Safety ratings
 */
export async function getSafetyRatings(make, model, year) {
  const empty = {
    rated: false,
    overall: null,
    frontal_driver: null,
    frontal_passenger: null,
    side_driver: null,
    side_passenger: null,
    rollover: null,
    side_pole: null,
    variants: [],
  };

  try {
    // Step 1: Find vehicle variants
    const listUrl = `${SAFETY_BASE}/modelyear/${encodeURIComponent(year)}/make/${encodeURIComponent(make)}/model/${encodeURIComponent(model)}?format=json`;
    const listRes = await fetch(listUrl, { signal: timeoutSignal() });

    if (!listRes.ok) {
      console.error(`[nhtsa] getSafetyRatings list HTTP ${listRes.status}`);
      return empty;
    }

    const listData = await listRes.json();
    const variants = listData?.Results || [];

    if (variants.length === 0) {
      return empty;
    }

    // Step 2: Fetch details for each variant
    const detailedVariants = [];
    for (const variant of variants) {
      const vehicleId = variant.VehicleId;
      if (!vehicleId) continue;

      try {
        const detailUrl = `${SAFETY_BASE}/VehicleId/${vehicleId}?format=json`;
        const detailRes = await fetch(detailUrl, { signal: timeoutSignal() });

        if (!detailRes.ok) continue;

        const detailData = await detailRes.json();
        const r = detailData?.Results?.[0];
        if (!r) continue;

        detailedVariants.push({
          vehicle_id: vehicleId,
          description: clean(r.VehicleDescription),
          overall: num(r.OverallRating),
          frontal_driver: num(r.FrontCrashDriversideRating),
          frontal_passenger: num(r.FrontCrashPassengersideRating),
          side_driver: num(r.SideCrashDriversideRating),
          side_passenger: num(r.SideCrashPassengersideRating),
          rollover: num(r.RolloverRating),
          side_pole: num(r.SidePoleCrashRating),
        });
      } catch (innerErr) {
        console.error(`[nhtsa] getSafetyRatings detail error for ${vehicleId}:`, innerErr.message);
      }
    }

    if (detailedVariants.length === 0) {
      return empty;
    }

    // Use the first variant's ratings as the primary result
    const primary = detailedVariants[0];

    return {
      rated: true,
      overall: primary.overall,
      frontal_driver: primary.frontal_driver,
      frontal_passenger: primary.frontal_passenger,
      side_driver: primary.side_driver,
      side_passenger: primary.side_passenger,
      rollover: primary.rollover,
      side_pole: primary.side_pole,
      variants: detailedVariants,
    };
  } catch (err) {
    console.error(`[nhtsa] getSafetyRatings error:`, err.message);
    return empty;
  }
}
