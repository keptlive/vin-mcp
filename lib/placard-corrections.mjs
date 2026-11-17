/**
 * "Doesn't match your door placard?" corrections from the car sheet.
 *
 * A reader can send the tire sizes, cold pressures and fuel tank size from their own vehicle when the NHTSA
 * test-vehicle values shown differ. A correction is validated, stored for review in vin.db, never shown to
 * anyone else and never changes a shown value. Stored: the values, an optional note, what the VIN decodes to
 * (year, make, model, trim, body, drive, powertrain), which NHTSA test vehicles the sheet showed and their match
 * kind, the VIN's first 11 characters only (no serial number), and the time. No IP address and no account.
 */
import { validateVin, normalizeVin } from './validate.mjs';
import { powertrainClass, electrification } from './tire-placards.mjs';

export const CORRECTION_LIMITS = { tire: 40, note: 500, psi: [10, 120], gal: [1, 80], L: [4, 300] };
export const THANKS = 'Thanks. We review corrections before using them.';
const TIRE = /^[A-Za-z0-9][A-Za-z0-9 .\/\-()]*$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

export class CorrectionError extends Error {}

function text(body, key, max, label, pattern) {
  const v = body[key];
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new CorrectionError(`${label} must be text.`);
  const t = v.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (t.length > max) throw new CorrectionError(`${label} is too long (at most ${max} characters).`);
  if (pattern && (!pattern.test(t) || !/\d/.test(t))) throw new CorrectionError(`${label} should look like the placard, for example 225/55R18 98H.`);
  return t;
}

function number(body, key, [lo, hi], label) {
  const v = body[key];
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d{1,4}(\.\d{1,2})?\s*$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < lo || n > hi) throw new CorrectionError(`${label} must be a number from ${lo} to ${hi}.`);
  return Math.round(n * 10) / 10;
}

/** Validate a POST body; returns the clean input or throws CorrectionError with a reader-facing message. */
export function validateCorrection(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CorrectionError('Send the correction as a JSON object.');
  const vin = typeof body.vin === 'string' ? normalizeVin(body.vin) : '';
  if (!validateVin(vin).valid) throw new CorrectionError('Provide a valid VIN (format and checksum).');
  const unit = body.fuel_tank_unit === undefined || body.fuel_tank_unit === null || body.fuel_tank_unit === '' ? 'gal' : body.fuel_tank_unit;
  if (unit !== 'gal' && unit !== 'L') throw new CorrectionError('Fuel tank unit must be gal or L.');
  const out = {
    vin,
    tire_front: text(body, 'tire_front', CORRECTION_LIMITS.tire, 'Front tire size', TIRE),
    tire_rear: text(body, 'tire_rear', CORRECTION_LIMITS.tire, 'Rear tire size', TIRE),
    psi_front: number(body, 'psi_front', CORRECTION_LIMITS.psi, 'Front cold pressure (psi)'),
    psi_rear: number(body, 'psi_rear', CORRECTION_LIMITS.psi, 'Rear cold pressure (psi)'),
    fuel_tank: number(body, 'fuel_tank', CORRECTION_LIMITS[unit], `Fuel tank (${unit})`),
    note: text(body, 'note', CORRECTION_LIMITS.note, 'Note'),
  };
  out.fuel_tank_unit = out.fuel_tank === null ? null : unit;
  if (['tire_front', 'tire_rear', 'psi_front', 'psi_rear', 'fuel_tank', 'note'].every(k => out[k] === null)) {
    throw new CorrectionError('Enter at least one value from your placard or fuel tank, or a note.');
  }
  return out;
}

/** What the sheet showed for this VIN: test numbers and match kinds only. */
function shownFrom(report) {
  const tp = report?.tire_placard, sp = report?.test_vehicle_specs;
  const brief = v => ({ test_no: v.test_no, model_year: v.model_year, match_kind: v.match?.kind ?? null });
  return {
    tire_placard: tp?.available ? { match_kind: tp.match_kind ?? null, reason: tp.reason ?? null, vehicles: (tp.vehicles || []).map(brief) } : { available: false },
    test_vehicle_specs: sp?.available ? { match_kind: sp.match_kind ?? null, reason: sp.reason ?? null, vehicles: (sp.vehicles || []).map(brief),
      fuel_tank: sp.fuel_tank ? { shown: !!sp.fuel_tank.shown, best_guess: sp.fuel_tank.best_guess ?? null,
        values: (sp.fuel_tank.values || []).map(x => ({ litres: x.litres, test_no: x.test_no, match_kind: x.match_kind })) } : null } : { available: false },
  };
}

export function insertCorrection(db, input, report) {
  const v = report?.vehicle || {}, e = report?.engine || {}, t = report?.transmission || {};
  const pt = v.make ? powertrainClass(e.fuel_type, e.ev_type) : null;
  const info = db.prepare(`INSERT INTO placard_corrections (vin_prefix, model_year, make, model, trim, body_class, drive_type, powertrain,
    electrification, tire_front, tire_rear, psi_front, psi_rear, fuel_tank, fuel_tank_unit, note, shown) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    input.vin.slice(0, 11), v.year ?? null, v.make ?? null, v.model ?? null, v.trim ?? null, v.body_class ?? null, t.drive_type ?? null, pt,
    v.make ? electrification(e.fuel_type, e.ev_type) : null, input.tire_front, input.tire_rear, input.psi_front, input.psi_rear,
    input.fuel_tank, input.fuel_tank_unit, input.note, JSON.stringify(shownFrom(report)));
  return info.lastInsertRowid;
}

export function listCorrections(db, limit = 100) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 1000);
  const rows = db.prepare('SELECT * FROM placard_corrections ORDER BY id DESC LIMIT ?').all(n);
  return { count: db.prepare('SELECT COUNT(*) AS c FROM placard_corrections').get().c, returned: rows.length,
    corrections: rows.map(r => ({ ...r, shown: JSON.parse(r.shown) })) };
}
