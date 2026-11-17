/*
 * Owner-stated details per VIN (owner rule 2026-11-17). Today: the transmission, when EPA lists the model with
 * both and the VIN does not say (report field fuel_economy.transmission_choice). The report always arrives with
 * an automatic assumed and the manual figures in fuel_economy.alternatives; this file swaps the view for the
 * owner's choice, in the browser, without asking the server again.
 *
 * Where a choice is kept:
 *  - signed in, vehicle saved: with the vehicle in the account (PUT /api/user/vins/{id}/details);
 *  - signed in, vehicle not saved: for this visit (sessionStorage), with an offer to save the vehicle with it;
 *  - signed out: in this browser only (localStorage, next to the recent-reports list); never sent to mcp.vin.
 * The swap follows lib/transmission-choice.mjs applyTransmission (tests/owner-details.test.mjs checks they agree).
 */
(function () {
  'use strict';
  const LOCAL_KEY = 'vin-owner-details';
  const SESSION_KEY = 'vin-owner-details-session';
  const TRANSMISSIONS = ['automatic', 'manual'];
  const account = new Map(); // VIN -> {id, details}
  let signedIn = false;

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
  const up = vin => String(vin || '').trim().toUpperCase();
  const clean = d => (d && TRANSMISSIONS.includes(d.transmission) ? {transmission: d.transmission} : null);
  function storage(kind) { try { return kind === 'local' ? window.localStorage : window.sessionStorage; } catch { return null; } }
  function readAll(kind) {
    try { const x = JSON.parse(storage(kind)?.getItem(kind === 'local' ? LOCAL_KEY : SESSION_KEY) || '{}'); return x && typeof x === 'object' && !Array.isArray(x) ? x : {}; }
    catch { return {}; }
  }
  function writeOne(kind, vin, details) {
    const all = readAll(kind);
    if (details) all[vin] = details; else delete all[vin];
    try { storage(kind)?.setItem(kind === 'local' ? LOCAL_KEY : SESSION_KEY, JSON.stringify(all)); return true; } catch { return false; }
  }

  /** The signed-in account's saved vehicles ([{id, vin, owner_details}]), or signed out (list empty, false). */
  function setAccount(list, isSignedIn) {
    account.clear();
    signedIn = Boolean(isSignedIn);
    for (const r of Array.isArray(list) ? list : []) if (r && r.vin) account.set(up(r.vin), {id: r.id, details: clean(r.owner_details)});
  }
  const saved = vin => account.has(up(vin));

  /** The stated details for a VIN, or null; and where they are kept ('account' | 'session' | 'browser' | null). */
  function get(vin) {
    vin = up(vin);
    if (signedIn && account.get(vin)?.details) return account.get(vin).details;
    return clean(readAll('session')[vin]) || clean(readAll('local')[vin]);
  }
  function where(vin) {
    vin = up(vin);
    if (signedIn && account.get(vin)?.details) return 'account';
    if (clean(readAll('session')[vin])) return 'session';
    if (clean(readAll('local')[vin])) return 'browser';
    return null;
  }

  /**
   * Keep a choice (details null clears it). request(url, options) is the page's authenticated fetch for account
   * storage. Returns where it was kept.
   */
  async function set(vin, details, {request} = {}) {
    vin = up(vin);
    const d = clean(details);
    if (signedIn && saved(vin)) {
      const a = account.get(vin);
      await request(`/api/user/vins/${encodeURIComponent(a.id)}/details`, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({owner_details: d || {transmission: null}})});
      a.details = d;
      writeOne('session', vin, null);
      return 'account';
    }
    if (signedIn) { writeOne('session', vin, d); return 'session'; }
    writeOne('local', vin, d);
    return 'browser';
  }

  const LABEL = {
    owner: t => `${t === 'manual' ? 'Manual' : 'Automatic'} transmission, as you said (the VIN does not say)`,
    request: t => `${t === 'manual' ? 'Manual' : 'Automatic'} transmission, as requested (the VIN does not say)`,
  };
  const MARK = /^(Assuming an automatic transmission \(the VIN does not say\)|(Manual|Automatic) transmission, as (you said|requested) \(the VIN does not say\)): /;
  const MARK_BASIS = /^(assuming an automatic transmission|(manual|automatic) transmission, as (you said|requested))/;
  const CHOICE_KEYS = ['transmission_choice', 'assumed', 'stated', 'alternatives'];

  /** Same rules as lib/transmission-choice.mjs applyTransmission; never changes its input. */
  function applyTransmission(fuel, choice, by = 'owner') {
    const t = String(choice || '').toLowerCase() === 'auto' ? 'automatic' : String(choice || '').toLowerCase();
    if (!TRANSMISSIONS.includes(t) || !fuel || !fuel.transmission_choice || !Array.isArray(fuel.alternatives)) return fuel;
    const current = {for_transmission: fuel.transmission_choice.chosen, ...Object.fromEntries(Object.entries(fuel).filter(([k]) => !CHOICE_KEYS.includes(k)))};
    const unmark = r => ({...r, summary: String(r.summary || '').replace(MARK, ''), match_basis: (r.match_basis || []).filter(b => !MARK_BASIS.test(b))});
    const all = [current, ...fuel.alternatives].map(unmark);
    const chosen = all.find(x => x.for_transmission === t);
    if (!chosen) return fuel;
    const label = (by === 'owner' ? LABEL.owner : LABEL.request)(t);
    const {for_transmission, ...rest} = chosen;
    return {
      ...rest, summary: rest.summary ? `${label}: ${rest.summary}` : label, match_basis: [...(rest.match_basis || []), label[0].toLowerCase() + label.slice(1)],
      transmission_choice: {...fuel.transmission_choice, chosen: t, basis: by === 'owner' ? 'owner_stated' : 'request', label},
      stated: {transmission: t, by},
      alternatives: all.filter(x => x !== chosen).map(x => ({...x})),
    };
  }

  /** The report as this owner sees it: their stated transmission applied to its fuel economy. */
  function applyToReport(report, details = report && get(report.vin)) {
    if (!report || !details || !report.fuel_economy?.transmission_choice) return report;
    return {...report, fuel_economy: applyTransmission(report.fuel_economy, details.transmission, 'owner')};
  }

  const figures = f => {
    if (!f) return null;
    const unit = f.unit || (f.is_ev ? 'MPGe' : 'mpg');
    if (f.available && f.combined_mpg) return `${f.combined_mpg} ${unit} combined${f.city_mpg && f.highway_mpg ? ` (${f.city_mpg} city, ${f.highway_mpg} highway)` : ''}`;
    const c = f.mpg_range?.combined;
    return c ? `${c.min === c.max ? c.min : `${c.min}-${c.max}`} ${f.mpg_range.unit || unit} combined across ${f.configuration_count || 'several'} EPA configurations` : null;
  };
  const KEPT = {
    account: 'Saved with this vehicle in your account.',
    session: 'Kept for this visit only.',
    browser: 'Saved in this browser only, next to your recent reports (clearing them clears this too). Not sent to mcp.vin.',
  };

  /** The fuel card's label and control: what is assumed or stated, the other figures, the switch and where it is kept. */
  function controlHtml(fuel, vin) {
    const tc = fuel?.transmission_choice;
    if (!tc) return '';
    const other = tc.chosen === 'manual' ? 'automatic' : 'manual';
    const alt = (fuel.alternatives || []).find(a => a.for_transmission === other);
    const kept = where(vin);
    const buttons = tc.basis === 'assumed'
      ? `<button type="button" class="secondary" data-owner-transmission="manual">Mine is a manual</button> <button type="button" class="text-button" data-owner-transmission="automatic">It is an automatic</button>`
      : `<button type="button" class="secondary" data-owner-transmission="${other}">Mine is ${other === 'manual' ? 'a manual' : 'an automatic'}</button>`;
    const offer = kept === 'session' && signedIn && !saved(vin) ? ` <button type="button" class="text-button" data-owner-save>Save this vehicle with this choice</button>` : '';
    return `<div class="owner-choice" data-owner-choice>`
      + `<p class="owner-choice-label"><strong>${esc(tc.label)}.</strong>${alt && figures(alt) ? ` With ${other === 'manual' ? 'a manual' : 'an automatic'}: ${esc(figures(alt))}.` : ''}</p>`
      + `<p class="owner-choice-actions">${buttons}</p>`
      + (kept ? `<p class="small owner-choice-kept">${esc(KEPT[kept])}${offer}</p>` : '')
      + `<p class="small owner-choice-how">${esc(tc.classified)}.</p></div>`;
  }

  /** A short mark after a figure in the comparison table: ' (automatic assumed)', ' (manual, as you said)', or ''. */
  function choiceMark(fuel) {
    const tc = fuel && fuel.transmission_choice;
    if (!tc) return '';
    return tc.basis === 'assumed' ? ' (automatic assumed; the VIN does not say)' : ` (${tc.chosen}, ${tc.basis === 'owner_stated' ? 'as you said' : 'as requested'})`;
  }

  /** Forget choices kept in this browser: 'session' (on sign-out) or 'browser' (with the recent reports). */
  function clear(kind) { try { storage(kind === 'browser' ? 'local' : 'session')?.removeItem(kind === 'browser' ? LOCAL_KEY : SESSION_KEY); } catch { /* storage blocked */ } }

  window.OwnerDetails = {get, where, set, setAccount, saved, clear, applyTransmission, applyToReport, controlHtml, choiceMark, LOCAL_KEY, SESSION_KEY};
})();
