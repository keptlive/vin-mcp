/**
 * "Report a decode error" from the web report and the car sheet.
 *
 * A reader can say a decoded field is wrong for their vehicle (drive, engine, transmission, ...) and what it really
 * has. A report is validated, stored for review in vin.db, never shown to anyone else and never changes a shown
 * value. Stored: the field, the value and source given, an optional note, what the VIN decodes to (year, make,
 * model, trim), what the site showed for that field (official value, checked value, status), the VIN's first 11
 * characters only (no serial number), and the time. No IP address and no account.
 */
import { validateVin, normalizeVin } from './validate.mjs';

export const DECODE_REPORT_FIELDS = ['drive', 'engine_size', 'cylinders', 'powertrain', 'transmission', 'speeds', 'seats', 'body', 'trim', 'model', 'other'];
export const DECODE_REPORT_SOURCES = ['owner', 'window_sticker', 'manufacturer', 'other'];
export const DECODE_LIMITS = { value: 80, note: 500 };
export const DECODE_THANKS = 'Thanks. We review reports before using them.';
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

export class DecodeCorrectionError extends Error {}

function text(body, key, max, label) {
  const v = body[key];
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new DecodeCorrectionError(`${label} must be text.`);
  const t = v.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (t.length > max) throw new DecodeCorrectionError(`${label} is too long (at most ${max} characters).`);
  return t;
}

/** Validate a POST body; returns the clean input or throws DecodeCorrectionError with a reader-facing message. */
export function validateDecodeCorrection(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DecodeCorrectionError('Send the report as a JSON object.');
  const vin = typeof body.vin === 'string' ? normalizeVin(body.vin) : '';
  if (!validateVin(vin).valid) throw new DecodeCorrectionError('Provide a valid VIN (format and checksum).');
  if (!DECODE_REPORT_FIELDS.includes(body.field)) throw new DecodeCorrectionError(`Choose which field is wrong (${DECODE_REPORT_FIELDS.join(', ')}).`);
  const source = body.source === undefined || body.source === null || body.source === '' ? null : body.source;
  if (source !== null && !DECODE_REPORT_SOURCES.includes(source)) throw new DecodeCorrectionError(`How you know must be one of ${DECODE_REPORT_SOURCES.join(', ')}.`);
  const out = { vin, field: body.field, value: text(body, 'value', DECODE_LIMITS.value, 'Value'), source, note: text(body, 'note', DECODE_LIMITS.note, 'Note') };
  if (out.value === null && out.note === null) throw new DecodeCorrectionError('Say what your vehicle has, or add a note.');
  return out;
}

/** What the report showed for the field: official value, checked value and status. */
function shownFor(report, field) {
  const c = (report?.decode_checks?.fields || []).find(f => f.field === field);
  return c ? { status: c.status, original: c.original ?? null, shown: c.shown ?? null, basis: c.basis ?? null, rule: c.rule ?? null } : { status: null };
}

export function insertDecodeCorrection(db, input, report) {
  const v = report?.vehicle || {};
  const info = db.prepare(`INSERT INTO decode_corrections (vin_prefix, model_year, make, model, trim, field, reported_value, source, note, shown)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.vin.slice(0, 11), v.year ?? null, v.make ?? null, v.model ?? null, v.trim ?? null,
    input.field, input.value, input.source, input.note, JSON.stringify(shownFor(report, input.field)));
  return info.lastInsertRowid;
}

export function listDecodeCorrections(db, limit = 100) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 1000);
  const rows = db.prepare('SELECT * FROM decode_corrections ORDER BY id DESC LIMIT ?').all(n);
  return { count: db.prepare('SELECT COUNT(*) AS c FROM decode_corrections').get().c, returned: rows.length,
    corrections: rows.map(r => ({ ...r, shown: JSON.parse(r.shown) })) };
}
