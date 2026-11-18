/**
 * Local asking prices and cars for sale, from mcp.vin's own index of dealer websites.
 *
 * The index lives on a second server of ours; this module asks its private price service (lib has no copy of the
 * data). The report must never wait on it: one short timeout, and any failure is an explicit "unavailable".
 * Prices are dealer ASKING prices. Trade-in and private-party figures are rules of thumb applied to them
 * (82% and 91%), not measurements; the page says so.
 */
import { InputError } from './research.mjs';

const BASE = process.env.MARKET_API_URL ?? 'http://10.77.0.1:8791';
const TIMEOUT_MS = 3500;
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Validate what the browser sent. ZIP and mileage are optional; a bad optional value is an error, not ignored. */
export function marketQuery(body = {}) {
  const year = Number(body.year);
  const make = text(body.make, 60), model = text(body.model, 80);
  if (!Number.isInteger(year) || year < 1981 || year > 2100) throw new InputError('year must be a model year');
  if (!make || !model) throw new InputError('make and model are required');
  const query = { year, make, model };
  const trim = text(body.trim, 60);
  if (trim) query.trim = trim;
  if (body.vin != null && body.vin !== '') {
    const vin = String(body.vin).toUpperCase();
    if (!VIN_RE.test(vin)) throw new InputError('vin must be a 17-character VIN');
    query.vin = vin;
  }
  if (body.zip != null && body.zip !== '') {
    const zip = String(body.zip).trim();
    if (!/^\d{5}$/.test(zip)) throw new InputError('zip must be a 5-digit US ZIP code');
    query.zip = zip;
  }
  if (body.miles != null && body.miles !== '') {
    const miles = Number(body.miles);
    if (!Number.isInteger(miles) || miles < 0 || miles > 500000) throw new InputError('miles must be between 0 and 500,000');
    query.miles = miles;
  }
  return query;
}

/** Ask the price service. Returns its answer, or {ok:false, reason:'unavailable'}: never throws for an outage. */
export async function market(body, { fetchImpl = fetch, base = BASE, timeoutMs = TIMEOUT_MS } = {}) {
  const query = marketQuery(body);
  if (!base || base === 'off') return { ok: false, reason: 'unavailable' };
  const url = `${base}/market?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) return { ok: false, reason: 'unavailable' };
    const data = await res.json();
    return data && typeof data === 'object' ? data : { ok: false, reason: 'unavailable' };
  } catch {
    return { ok: false, reason: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}
