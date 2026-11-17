/**
 * Owner-stated details about a saved vehicle (owner rule 2026-11-17): facts the VIN does not give, stated by the
 * owner and stored with the vehicle in their account (saved_vins.owner_details, JSON). Today only the transmission
 * (automatic or manual), used to pick the EPA fuel economy configuration (lib/transmission-choice.mjs). Built to take
 * more keys later (drive type, wheel size, cab; tire and tank value sets), each with its own validator here.
 *
 * Signed-out visitors keep the same object in their browser only (public/owner-details.js); it is never sent.
 */
import {normalizeTransmission} from './transmission-choice.mjs';

export class OwnerDetailsError extends Error {}

/** key -> validator returning the clean value or null (cleared); throws for a bad value. */
const FIELDS = {
  transmission: v => { try { return normalizeTransmission(v); } catch (err) { throw new OwnerDetailsError(err.message); } },
};
export const OWNER_DETAIL_KEYS = Object.freeze(Object.keys(FIELDS));

/** Validate input from a request: a plain object with known keys only. Returns the clean object, or null when empty. */
export function validateOwnerDetails(input) {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new OwnerDetailsError('owner_details must be an object');
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (!FIELDS[k]) throw new OwnerDetailsError(`Unknown owner detail: ${String(k).slice(0, 40)}`);
    const clean = FIELDS[k](v);
    if (clean !== null) out[k] = clean;
  }
  return Object.keys(out).length ? out : null;
}

/** Stored JSON -> object (unknown keys and bad values dropped), or null. */
export function parseOwnerDetails(text) {
  if (!text) return null;
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!FIELDS[k]) continue;
    try { const clean = FIELDS[k](v); if (clean !== null) out[k] = clean; } catch { /* dropped */ }
  }
  return Object.keys(out).length ? out : null;
}

export const serializeOwnerDetails = details => (details ? JSON.stringify(details) : null);

/** Add saved_vins.owner_details to an existing database (idempotent; rows keep their data). */
export function migrateSavedVins(db) {
  const cols = db.prepare('PRAGMA table_info(saved_vins)').all().map(c => c.name);
  if (cols.length && !cols.includes('owner_details')) db.exec('ALTER TABLE saved_vins ADD COLUMN owner_details TEXT');
}
