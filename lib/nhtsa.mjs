/**
 * NHTSA (National Highway Traffic Safety Administration) API integration.
 * All endpoints are free and require no API key.
 * Docs: https://vpic.nhtsa.dot.gov/api/
 */

import { compactName, lookupRecallLabels } from './recall-labels.mjs';

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
// Related labels looked up per report (one recallsByVehicle call each). Labels past the cap are
// listed in unchecked_labels, never dropped silently.
export const MAX_RELATED_LABELS = 8;

const upperWords = v => String(v ?? '').toUpperCase().split(/\s+/).filter(Boolean).join(' ');
const nameTokens = v => upperWords(v).match(/[A-Z0-9]+/g) || [];
/** Compact forms of each proper leading run of tokens: [F,150,X] -> F, F150. */
const leadingJoins = t => new Set(t.slice(0, -1).map((_, k) => t.slice(0, k + 1).join('')));
const startsWithTokens = (t, prefix) => prefix.length > 0 && prefix.every((p, i) => t[i] === p);
// Words vPIC adds to a model family name that NHTSA labels leave out (Mercedes-Benz "C-Class", "EQS-Class Sedan").
const FAMILY_WORDS = new Set(['CLASS', 'SERIES', 'SEDAN', 'COUPE', 'CABRIOLET', 'CONVERTIBLE', 'WAGON', 'ROADSTER', 'HATCHBACK']);
const parentheticalParts = model => {
  const m = String(model ?? '').match(/^(.*?)\s*\(([^()]*)\)\s*(.*)$/);
  return m ? [m[1] + ' ' + m[3], m[2]].filter(p => compactName(p)) : [];
};
/** Compact forms of the decoded name that count as "NHTSA files under this name". */
export function decodedNameForms(model) {
  return [...new Set([compactName(model), ...parentheticalParts(model).map(compactName)].filter(Boolean))];
}
const MATCH_ORDER = ['longer_name', 'spelling', 'parenthetical', 'family_name', 'make_name', 'shorter_name', 'trailing_name'];

/**
 * How an NHTSA recall model label relates to the vPIC model name, or null. Measured 2026-11-16
 * against NHTSA's recall flat files (30 makes, model years 2012-2025):
 *  longer_name   label adds words or a model number: CR-V -> CR-V HYBRID, ES -> ES350
 *  spelling      same letters and digits: Mustang Mach-E -> MUSTANG MACH E, F 800 GS -> F800 GS
 *  parenthetical vPIC adds a parenthetical: Prius Prime (PHEV) -> PRIUS PRIME
 *  family_name   vPIC family name: C-Class -> C 300, AMG C63; EQS-Class Sedan -> EQS 450
 *  make_name     label adds or drops the make: Nissan Z -> Z
 *  shorter_name / trailing_name  label is the start or end of the vPIC name (Expedition MAX -> EXPEDITION,
 *                Golf GTI -> GTI); used only when NHTSA has never filed under the decoded name itself
 *                (decodedNameUsed false), because otherwise the shorter label is usually another vehicle
 *                (Transit Connect -> TRANSIT).
 * Every match only means "may or may not apply".
 */
export function modelLabelMatch(model, label, { make = '', decodedNameUsed = true } = {}) {
  const uv = upperWords(model), ul = upperWords(label), tv = nameTokens(model), tl = nameTokens(label);
  const cv = tv.join(''), cl = tl.join('');
  if (!cv || !cl || ul.length > 80) return null;
  if (uv === ul) return 'exact';
  if (ul.startsWith(uv + ' ') || leadingJoins(tl).has(cv)
    || (tl[0].startsWith(cv) && cl.length > cv.length && /\d/.test(cl[cv.length]) && !/\d$/.test(cv))) return 'longer_name';
  if (cv === cl) return 'spelling';
  if (parentheticalParts(model).some(p => { const cp = compactName(p); return cp === cl || leadingJoins(tl).has(cp) || ul.startsWith(upperWords(p) + ' '); })) return 'parenthetical';
  const family = tv.filter(t => !FAMILY_WORDS.has(t));
  if (family.length && family.length !== tv.length) {
    const g = family.join(''), ta = tl.filter(t => t !== 'AMG').length ? tl.filter(t => t !== 'AMG') : tl;
    if (g === cl || leadingJoins(tl).has(g) || leadingJoins(family).has(cl) || g === ta.join('') || leadingJoins(ta).has(g)
      || (ta[0].startsWith(g) && ta[0].length > g.length && /\d/.test(ta[0][g.length]))) return 'family_name';
  }
  const mw = nameTokens(make);
  if ((startsWithTokens(tl, mw) && tl.length > mw.length && tl.slice(mw.length).join('') === cv)
    || (startsWithTokens(tv, mw) && tv.length > mw.length && tv.slice(mw.length).join('') === cl)) return 'make_name';
  if (!decodedNameUsed) {
    if (leadingJoins(tv).has(cl)) return 'shorter_name';
    if (tv.length > tl.length && cl.length >= 3 && !/^\d+$/.test(cl) && tv.slice(tv.length - tl.length).join(' ') === tl.join(' ')) return 'trailing_name';
  }
  return null;
}

/** Related labels (not the exact one), strongest kinds first, each as {label, match}. */
export function relatedModelMatches(model, labels, options = {}) {
  if (!String(model ?? '').trim() || !Array.isArray(labels)) return [];
  const found = new Map();
  for (const label of labels) {
    if (typeof label !== 'string') continue;
    const u = upperWords(label), match = modelLabelMatch(model, u, options);
    if (match && match !== 'exact' && !found.has(u)) found.set(u, match);
  }
  return [...found].map(([label, match]) => ({ label, match }))
    .sort((a, b) => MATCH_ORDER.indexOf(a.match) - MATCH_ORDER.indexOf(b.match) || a.label.localeCompare(b.label));
}

/**
 * NHTSA files some campaigns under another model label than vPIC decodes:
 * live 2026-11-16, a 2024 CR-V hybrid VIN decodes as "CR-V", while 24V763,
 * 26V366 and 26V663 are filed only under "CR-V HYBRID". Returns the related labels.
 */
export function relatedModelLabels(model, labels, options = {}) {
  return relatedModelMatches(model, labels, options).map(m => m.label);
}

const RELATED_NOTE = 'Campaigns NHTSA files for the same make and year under another model name that matches the decoded model (a longer name such as a hybrid or body-style label, a different spelling, or a family name). They may or may not apply to this vehicle; check the VIN with the manufacturer. Not VIN repair status.';

/**
 * Campaigns filed under related NHTSA model labels for the same make and year,
 * minus campaigns already in the exact-label list. These may or may not apply.
 * Labels come from NHTSA's /products/vehicle/models reply, which lists only part of a make's
 * labels (checked 2026-11-16), and from the local flat-file label index when it is installed.
 */
export async function getRelatedModelRecalls(make, model, year, exactRecalls = [], { labelIndex = lookupRecallLabels } = {}) {
  const unavailable = { available: false, scope: 'make_related_model_year', vin_specific: false, count: null, models: [] };
  try {
    const params = new URLSearchParams({ modelYear: String(year), make: String(make), issueType: 'r' });
    const [products, index] = await Promise.all([
      fetch(`${RECALL_MODELS_BASE}?${params}`, { signal: timeoutSignal() })
        .then(async res => { const data = res.ok ? await res.json() : null; return Array.isArray(data?.results) ? data.results.map(r => r?.model) : null; })
        .catch(() => null),
      Promise.resolve().then(() => labelIndex({ makes: [make], year, names: decodedNameForms(model) })).catch(() => ({ available: false })),
    ]);
    if (!products && !index?.available) return unavailable;
    const labels = [...(products || []), ...(index?.available ? index.labels.map(l => l.model) : [])];
    // Without the index it is unknown whether NHTSA ever files under the decoded name, so the
    // shorter/trailing rules stay off rather than guessing.
    const decodedNameUsed = index?.available ? decodedNameForms(model).some(n => index.used_names.has(n)) : true;
    const matches = relatedModelMatches(model, labels, { make, decodedNameUsed });
    const checked = matches.slice(0, MAX_RELATED_LABELS), unchecked = matches.slice(MAX_RELATED_LABELS);
    const known = new Set(exactRecalls.map(r => r?.campaign_number).filter(Boolean));
    const results = await Promise.all(checked.map(m => getRecalls(make, m.label, year)));
    if (results.some(r => r.available === false)) return unavailable;
    const models = [], seen = new Set();
    checked.forEach((m, i) => {
      const extra = results[i].recalls.filter(c => c.campaign_number && !known.has(c.campaign_number) && !seen.has(c.campaign_number));
      extra.forEach(c => seen.add(c.campaign_number));
      models.push({ nhtsa_model: m.label, match: m.match, count: extra.length, recalls: extra });
    });
    return { available: true, scope: 'make_related_model_year', vin_specific: false, count: seen.size,
      models: models.filter(m => m.count > 0), checked_labels: checked.map(m => m.label),
      unchecked_labels: unchecked.map(m => m.label),
      label_sources: { products_api: products ? 'partial_list' : 'unavailable',
        flat_file_index: index?.available ? { latest_report_date: index.source?.latest_report_date ?? null } : 'not_installed' },
      note: RELATED_NOTE + (unchecked.length ? ` ${unchecked.length} more related model name${unchecked.length === 1 ? ' was' : 's were'} not checked (unchecked_labels).` : '')
        + (index?.available ? '' : ' The related-name list is partial: NHTSA\'s model list for this make and year is incomplete and the local label index is not installed.') };
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
