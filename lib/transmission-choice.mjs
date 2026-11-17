/**
 * Owner-stated transmission for fuel economy (owner rule 2026-11-17).
 *
 * When the EPA configurations a VIN fits differ by transmission and the VIN decode does not say which, the figures
 * are given for an automatic, labelled as an assumption, with the manual configuration(s) as the alternative. The
 * owner (or an API caller) can state the transmission; the label then says so. The assumption is never presented
 * as fact: it stays marked until the owner states the transmission or the VIN decode gives it.
 *
 * Classification: EPA's continuously variable (AV), automated-manual and dual-clutch (AM) and conventional automatic
 * (A, S) listings all count as automatic: an owner sees two pedals and a selector in each, and EPA lists them as
 * automatic transmissions. Only EPA's "Manual" listings (three pedals) count as manual. A configuration set with
 * no manual listing, or with only manual ones, is unchanged.
 *
 * The report cache always holds the default (automatic assumed, manual in `alternatives`): applyTransmission()
 * swaps the view for one owner or request and never changes the cached object.
 */
import {rowTransmission, describeDifferences, severalSummary} from './fueleconomy-match.mjs';

export const TRANSMISSIONS = Object.freeze(['automatic', 'manual']);
export const CLASSIFIED = 'Continuously variable (CVT), dual-clutch and automated-manual transmissions count as automatic; only a manual (clutch pedal) counts as manual';
const LABEL = {
  assumed: 'Assuming an automatic transmission (the VIN does not say)',
  owner: t => `${t === 'manual' ? 'Manual' : 'Automatic'} transmission, as you said (the VIN does not say)`,
  request: t => `${t === 'manual' ? 'Manual' : 'Automatic'} transmission, as requested (the VIN does not say)`,
};

/** 'automatic' | 'manual' | null (nothing given); throws a TypeError for any other value. */
export function normalizeTransmission(value) {
  if (value === undefined || value === null || value === '') return null;
  const v = String(value).trim().toLowerCase();
  if (v === 'automatic' || v === 'auto') return 'automatic';
  if (v === 'manual') return 'manual';
  throw new TypeError('transmission must be "automatic" or "manual"');
}

/** The owner-visible side of one EPA listing: 'manual', 'automatic' or null (EPA gives no transmission). */
export function transmissionSide(row) {
  const kind = rowTransmission(row).kind;
  return kind === 'manual' ? 'manual' : kind ? 'automatic' : null;
}

function side(m, idx) {
  const cands = idx.map(i => m.cands ? m.cands[i] : {row: m.rows[i]});
  if (cands.length === 1) return {status: 'one', row: cands[0].row, match: m.match, basis: [...m.basis], differs: m.differs, efids: m.efidsOf(cands[0].row)};
  const {labels, separators} = describeDifferences(cands);
  return {status: 'several', rows: cands.map(c => c.row), labels, match: m.match, basis: [...m.basis], differs: m.differs, differs_in: separators, efidsOf: m.efidsOf, cands};
}

/**
 * Split a 'several' match by transmission side: {automatic, manual} sub-matches, or null when the choice does not
 * apply (the decode states a transmission, one side only, a listing without a transmission, or one rating for all).
 */
export function splitByTransmission(m, {decodeStatesTransmission = false} = {}) {
  if (!m || m.status !== 'several' || decodeStatesTransmission) return null;
  const sides = m.rows.map(transmissionSide);
  if (sides.some(s => !s)) return null;
  const auto = sides.flatMap((s, i) => (s === 'automatic' ? [i] : [])), man = sides.flatMap((s, i) => (s === 'manual' ? [i] : []));
  if (!auto.length || !man.length) return null;
  if (severalSummary(m.rows, {differs_in: m.differs_in, match: m.match}).same_rating) return null; // the figure holds either way
  return {automatic: side(m, auto), manual: side(m, man)};
}

const CHOICE_KEYS = ['transmission_choice', 'assumed', 'stated', 'alternatives'];
const strip = f => Object.fromEntries(Object.entries(f).filter(([k]) => !CHOICE_KEYS.includes(k)));

function marked(result, label) {
  return {...result, summary: result.summary ? `${label}: ${result.summary}` : label, match_basis: [...(result.match_basis || []), label[0].toLowerCase() + label.slice(1)]};
}

/**
 * The fuel economy response for a split: the automatic side's figures (one configuration, or several with the same
 * rating or a range: the usual rules), marked as assumed, with the manual side in `alternatives`.
 * build(sub) turns a sub-match into a response (lib/epa.mjs). allEfids: test groups every configuration shares.
 */
export function transmissionResult(split, build, {allEfids = [], counts} = {}) {
  const automatic = build(split.automatic), manual = build(split.manual);
  const n = s => (s.status === 'one' ? 1 : s.rows.length);
  const base = marked(automatic, LABEL.assumed);
  return {
    ...base,
    transmission_choice: {chosen: 'automatic', basis: 'assumed', label: LABEL.assumed, options: [...TRANSMISSIONS], classified: CLASSIFIED,
      configuration_counts: counts || {automatic: n(split.automatic), manual: n(split.manual)}, efids_all: allEfids},
    assumed: {transmission: 'automatic'},
    alternatives: [{for_transmission: 'manual', ...manual}],
  };
}

/**
 * The view for a stated transmission: by 'owner' (the site's saved choice) or 'request' (API or MCP argument).
 * Returns the response unchanged when the choice does not apply to it or no choice is given; never mutates it.
 */
export function applyTransmission(fuel, choice, {by = 'request'} = {}) {
  const t = normalizeTransmission(choice);
  if (!t || !fuel || !fuel.transmission_choice || !Array.isArray(fuel.alternatives)) return fuel;
  const chosenNow = fuel.transmission_choice.chosen;
  const current = {for_transmission: chosenNow, ...strip(fuel)};
  // the default carries the assumption marker in summary and basis; a stated choice carries its own
  const unmark = r => ({...r, summary: String(r.summary || '').replace(/^(Assuming an automatic transmission \(the VIN does not say\)|(Manual|Automatic) transmission, as (you said|requested) \(the VIN does not say\)): /, ''),
    match_basis: (r.match_basis || []).filter(b => !/^(assuming an automatic transmission|(manual|automatic) transmission, as (you said|requested))/.test(b))});
  const all = [current, ...fuel.alternatives].map(unmark);
  const chosen = all.find(x => x.for_transmission === t);
  if (!chosen) return fuel;
  const label = (by === 'owner' ? LABEL.owner : LABEL.request)(t);
  const {for_transmission, ...rest} = chosen;
  return {
    ...marked(rest, label),
    transmission_choice: {...fuel.transmission_choice, chosen: t, basis: by === 'owner' ? 'owner_stated' : 'request', label},
    stated: {transmission: t, by},
    alternatives: all.filter(x => x !== chosen).map(x => ({...x})),
  };
}

/** A report with the stated transmission applied to its fuel economy (other blocks unchanged). */
export function applyOwnerDetails(report, details = {}, opts = {}) {
  if (!report || !details || !details.transmission || !report.fuel_economy?.transmission_choice) return report;
  return {...report, fuel_economy: applyTransmission(report.fuel_economy, details.transmission, opts)};
}

/**
 * The fuel economy as other report blocks see it (EPA test vehicles use its test groups): the assumption is not
 * carried there, so a split response counts as the set of configurations, with the test groups all of them share.
 */
export function fuelForOtherBlocks(fuel) {
  if (!fuel?.transmission_choice) return fuel;
  return {...fuel, available: false, match: 'multiple_configurations', efids: fuel.transmission_choice.efids_all || []};
}
