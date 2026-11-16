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
      backup_camera: clean(r.RearVisibilitySystem) || clean(r.BackupCamera),
      parking_assist: clean(r.ParkAssist),
      blind_spot: clean(r.BlindSpotMon),
      auto_emergency_braking: clean(r.CIB) || clean(r.AutomaticEmergencyBraking),
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
    const body = new URLSearchParams({ DATA: batch.map(v => `${v},`).join(';'), format: 'json' }).toString();

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
 * recallsByVehicle returns ReportReceivedDate day-first (DD/MM/YYYY), e.g.
 * "15/10/2024" and "29/03/2018" (checked against NHTSA's flat-file RCDATE
 * 2026-11-16). Return ISO YYYY-MM-DD, or null for anything else.
 */
export function nhtsaDayFirstDate(value) {
  const m = typeof value === 'string' && value.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const iso = `${m[3]}-${m[2]}-${m[1]}`, d = new Date(iso + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === iso && iso > '1966-01-01' ? iso : null;
}

/** NHTSA consumer advisories. Absent or non-boolean values stay unknown (null), never false. */
function flag(value) {
  return typeof value === 'boolean' ? value : null;
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

    // Live 2026-11-16: a make/model/year with no campaigns returns HTTP 400 with
    // {"Count":0,"Message":"Results returned successfully","results":[]}.
    // Accept exactly that body as zero campaigns; any other non-200 stays unavailable.
    let data = null;
    if (!res.ok) {
      if (res.status === 400) { try { data = await res.json(); } catch { data = null; } }
      const emptySuccess = data && data.Count === 0 && Array.isArray(data.results) && data.results.length === 0 && data.Message === 'Results returned successfully';
      if (!emptySuccess) {
        console.error(`[nhtsa] getRecalls HTTP ${res.status}`);
        return { available: false, count: null, recalls: [], error: 'Recall lookup unavailable' };
      }
    } else {
      data = await res.json();
    }
    const results = data?.results;
    if (!Array.isArray(results)) throw new Error('Invalid recalls response');

    const recalls = results.map(r => ({
      campaign_number: clean(r.NHTSACampaignNumber),
      component: clean(r.Component),
      summary: clean(r.Summary),
      consequence: clean(r.Consequence),
      remedy: clean(r.Remedy),
      report_date: clean(r.ReportReceivedDate),
      // Same date as report_date, unambiguous. report_date keeps NHTSA's original day-first text.
      report_received_date: nhtsaDayFirstDate(r.ReportReceivedDate),
      manufacturer: clean(r.Manufacturer),
      // NHTSA consumer advisories for the whole campaign, not this VIN's repair status.
      park_it: flag(r.parkIt),
      park_outside: flag(r.parkOutSide),
      over_the_air_update: flag(r.overTheAirUpdate),
    }));

    return { available: true, count: recalls.length, recalls,
      scope: 'make_model_year', vin_specific: false,
      note: 'Campaigns for this make, model and year; applicability and repair status for this VIN are not determined.',
      verification_url: 'https://www.nhtsa.gov/recalls' };
  } catch (err) {
    console.error(`[nhtsa] getRecalls error:`, err.message);
    return { available: false, count: null, recalls: [], error: 'Recall lookup unavailable' };
  }
}

const RECALL_MODELS_BASE = 'https://api.nhtsa.gov/products/vehicle/models';
const MAX_RELATED_LABELS = 6;

/**
 * NHTSA files some campaigns under a longer model label than vPIC decodes:
 * live 2026-11-16, a 2024 CR-V hybrid VIN decodes as "CR-V", while 24V763,
 * 26V366 and 26V663 are filed only under "CR-V HYBRID". Return the longer
 * labels that start with the decoded model name plus a space.
 */
export function relatedModelLabels(model, labels) {
  const base = String(model ?? '').trim().toUpperCase();
  if (!base || !Array.isArray(labels)) return [];
  const found = new Set();
  for (const label of labels) {
    const u = typeof label === 'string' ? label.trim().toUpperCase() : '';
    if (u !== base && u.startsWith(base + ' ') && u.length <= 80) found.add(u);
  }
  return [...found].sort().slice(0, MAX_RELATED_LABELS);
}

/**
 * Campaigns filed under related NHTSA model labels for the same make and year,
 * minus campaigns already in the exact-label list. These may or may not apply.
 */
export async function getRelatedModelRecalls(make, model, year, exactRecalls = []) {
  const unavailable = { available: false, scope: 'make_related_model_year', vin_specific: false, count: null, models: [] };
  try {
    const params = new URLSearchParams({ modelYear: String(year), make: String(make), issueType: 'r' });
    const res = await fetch(`${RECALL_MODELS_BASE}?${params}`, { signal: timeoutSignal() });
    if (!res.ok) return unavailable;
    const data = await res.json();
    if (!Array.isArray(data?.results)) return unavailable;
    const labels = relatedModelLabels(model, data.results.map(r => r?.model));
    const known = new Set(exactRecalls.map(r => r?.campaign_number).filter(Boolean));
    const models = [], seen = new Set();
    for (const label of labels) {
      const r = await getRecalls(make, label, year);
      if (r.available === false) return unavailable;
      const extra = r.recalls.filter(c => c.campaign_number && !known.has(c.campaign_number));
      extra.forEach(c => seen.add(c.campaign_number));
      models.push({ nhtsa_model: label, count: extra.length, recalls: extra });
    }
    return { available: true, scope: 'make_related_model_year', vin_specific: false, count: seen.size,
      models: models.filter(m => m.count > 0), checked_labels: labels,
      note: 'Campaigns NHTSA files under a longer model name for the same make and year, such as a hybrid or body-style label. They may or may not apply to this vehicle; check the VIN with the manufacturer. Not VIN repair status.' };
  } catch (err) {
    console.error(`[nhtsa] getRelatedModelRecalls error:`, err.message);
    return unavailable;
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
      return { available: false, count: null, complaints: [], summary: null, error: 'Complaint lookup unavailable' };
    }

    const data = await res.json();
    const results = data?.results;
    if (!Array.isArray(results)) throw new Error('Invalid complaints response');

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
      available: true,
      scope: 'make_model_year',
      count: complaints.length,
      complaints,
      summary: { crashes, fires, injuries, deaths },
    };
  } catch (err) {
    console.error(`[nhtsa] getComplaints error:`, err.message);
    return { available: false, count: null, complaints: [], summary: null, error: 'Complaint lookup unavailable' };
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
