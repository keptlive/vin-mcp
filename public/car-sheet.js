/* Car information sheet: the one-page summary that opens a VIN report.
 *
 * Rules kept here (and tested in tests/car-sheet.test.mjs):
 * - Only facts from the report's public sources are printed. A missing value is
 *   left out or shown as "Unknown", never as zero.
 * - Fuse layout, oil and other owner's-manual facts have no public per-vehicle
 *   source. The sheet links to the maker's official manual library and leaves
 *   labelled spaces to copy the values from the door-pillar placard (FMVSS No. 110,
 *   49 CFR 571.110 S4.3) and the manual. Nothing is guessed.
 * - Tire size and cold pressures (report field tire_placard) and capacities and weights
 *   (test_vehicle_specs) are shown only as NHTSA printed them for a vehicle it tested (crash or compliance test):
 *   the closest match by model year and version, with the match stated in words (same
 *   model year, another model year, another version) and linked to the report. They are
 *   never this VIN's own values, never estimated or averaged; a fuel tank from another
 *   year or version is labelled a best guess. The write-in blanks stay for the owner's own
 *   placard, and "Doesn't match your door placard?" sends a correction for review.
 * - Model-year recall campaigns are not this car's repair status. VIN-specific
 *   status is labelled with the manufacturer source that reported it.
 */
const CarSheet = (() => {
  // Official owner's-manual libraries. Each URL is the maker's own page; deep links
  // per model are not built because the makers' pages choose the vehicle themselves.
  // basis: 'request' = a plain request returned the page (2026-11-16);
  //        'search'  = the maker's site refuses scripted requests, page confirmed in search results.
  const GM = brand => ({ url: `https://www.${brand}.com/support/vehicle/manuals-guides`, basis: 'request' });
  const MANUALS = {
    CHEVROLET: GM('chevrolet'), GMC: GM('gmc'), BUICK: GM('buick'), CADILLAC: GM('cadillac'),
    TOYOTA: { url: 'https://www.toyota.com/owners/warranty-owners-manuals', basis: 'request' },
    HONDA: { url: 'https://mygarage.honda.com/s/manuals-search?brand=honda', basis: 'request' },
    ACURA: { url: 'https://mygarage.honda.com/s/manuals-search?brand=acura', basis: 'request' },
    NISSAN: { url: 'https://www.nissanusa.com/owners/manuals-guides.html', basis: 'request' },
    FORD: { url: 'https://www.ford.com/support/how-tos/owner-resources/vehicle-documents/where-can-i-get-an-owners-manual/', basis: 'search', title: 'Ford: where to get your owner’s manual' },
  };

  const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const present = v => v !== null && v !== undefined && v !== '' && v !== 'Not Applicable';
  const num = v => (present(v) && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  const fmt = (v, digits = 0) => Number(v).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
  const fmtAuto = v => fmt(v, Number.isInteger(Number(v)) ? 0 : 1); // 51 kWh, 1.5 kWh, 7.2 kW
  const titleCase = v => String(v || '').toLowerCase().replace(/(^|[\s\-/(.,])([a-z])/g, (m, a, b) => a + b.toUpperCase())
    .replace(/\b(Llc|Usa|Ag|Gmna|Bmw|Gm)\b/g, w => w.toUpperCase()).replace(/(?!^)\b(Of|And|The)\b/g, w => w.toLowerCase());
  const sentence = v => { const s = String(v || '').toLowerCase().replace(/\(([a-z]{2,5})\)/g, (m, a) => `(${a.toUpperCase()})`); return s.charAt(0).toUpperCase() + s.slice(1); };
  const makeName = m => (/^[A-Z]{2,3}$/.test(m || '') ? m : titleCase(m));
  const host = url => String(url).replace(/^https?:\/\//, '').replace(/\/$/, '');
  const site = url => host(url).split(/[/?#]/)[0];

  /** "16 Nov 2026, 22:41 UTC" from an ISO time, or null. */
  function fmtDate(iso) {
    const d = new Date(iso);
    if (!iso || Number.isNaN(d.getTime())) return null;
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
    return `${d.getUTCDate()} ${mon} ${d.getUTCFullYear()}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
  }

  /** The maker's manual library for this vehicle, or null when no official page is known. */
  function manualFor(report) {
    const v = report.vehicle || {}, make = String(v.make || '').toUpperCase();
    if (make === 'TESLA' && /^model s$/i.test(v.model || '') && num(v.year)) {
      return { url: num(v.year) <= 2020 ? 'https://www.tesla.com/ownersmanual/2012_2020_models/en_us/' : 'https://www.tesla.com/ownersmanual/models/en_us/', basis: 'search', title: 'Tesla Model S owner’s manual' };
    }
    const entry = MANUALS[make];
    return entry ? { ...entry, title: entry.title || `${makeName(make)} owner’s manuals` } : null;
  }

  // Long slash lists from vPIC ("Hatchback/Liftback/Notchback") may wrap after each slash.
  const row = (label, value) => (present(value) ? `<div class="sheet-row"><dt>${esc(label)}</dt><dd>${esc(value).replace(/\//g, '/<wbr>')}</dd></div>` : '');
  const rowHtml = (label, html) => `<div class="sheet-row"><dt>${esc(label)}</dt><dd>${html}</dd></div>`;
  // Decode checks (public/decode-checks.js): a corrected, doubtful or filled value is marked; vPIC's stays visible.
  const DC = () => (typeof DecodeChecks !== 'undefined' ? DecodeChecks : null);
  const checked = (r, label, value, field) => {
    const dc = DC(), c = dc && dc.check(r, field);
    return c && ['corrected', 'doubtful', 'filled'].includes(c.status) ? rowHtml(label, dc.valueHtml(r, field, present(value) ? value : null)) : row(label, value);
  };
  // A row made of several fields: officialText from vPIC's values, checkedText from the checked ones.
  const marked = (r, label, officialText, checkedText, ...fields) => {
    const html = DC() ? DC().combinedHtml(r, fields, present(officialText) ? officialText : null, present(checkedText) ? checkedText : null) : null;
    return html ? rowHtml(label, html) : row(label, officialText);
  };
  // The engine and transmission blocks with corrected or filled values put in, for the checked row text.
  const checkedEngine = (r, e) => {
    const dc = DC(); if (!dc) return e;
    const size = dc.checkedValue(r, 'engine_size'), cyl = dc.checkedValue(r, 'cylinders');
    return { ...e, ...(size !== null ? { displacement_l: size || null } : {}), ...(cyl !== null ? { cylinders: cyl || null } : {}) };
  };
  const TRANS_WORD = { auto: 'Automatic', manual: 'Manual', cvt: 'CVT', am: 'Dual-clutch (DCT)', single: 'Single-speed' };
  const checkedTrans = (r, t) => {
    const dc = DC(); if (!dc) return t;
    const kind = dc.checkedValue(r, 'transmission'), speeds = dc.checkedValue(r, 'speeds');
    return { ...t, ...(kind !== null ? { type: TRANS_WORD[kind] || t.type } : {}), ...(speeds !== null ? { speeds } : {}) };
  };
  const transText = t => [num(t.speeds) && `${t.speeds}-speed`, present(t.type) && String(t.type).toLowerCase()].filter(Boolean).join(' ');
  const section = (id, title, inner, extra = '') => `<section class="sheet-section sheet-${id}" aria-labelledby="sheet-h-${id}"><h3 id="sheet-h-${id}">${esc(title)}</h3>${inner}${extra}</section>`;
  const list = rows => { const html = rows.join(''); return html ? `<dl class="sheet-list">${html}</dl>` : ''; };
  const unknownNote = '<p class="sheet-note">Not in the public records for this VIN.</p>';
  const writeIn = (label, unit = '') => `<label class="write-in"><span class="write-label">${esc(label)}</span><span class="write-field"><input type="text" autocomplete="off" spellcheck="false">${unit ? `<span class="write-unit">${esc(unit)}</span>` : ''}</span></label>`;

  function engineText(e, raw) {
    const cyl = num(e.cylinders), config = String(raw.EngineConfiguration || '');
    const layout = !cyl ? '' : /^v/i.test(config) ? `V${cyl}` : /in-line/i.test(config) ? `inline-${cyl}` : /opposed|boxer/i.test(config) ? `flat-${cyl}` : `${cyl}-cylinder`;
    const parts = [num(e.displacement_l) && `${fmt(e.displacement_l, 1)} L`, layout, /yes/i.test(e.turbo || '') && 'turbo'].filter(Boolean).join(' ');
    return [parts, num(e.hp) && `${fmt(e.hp)} hp`].filter(Boolean).join(', ');
  }

  function vehicleSection(r) {
    const v = r.vehicle || {}, raw = r.raw_nhtsa || {}, p = r.plant || {};
    const seats = num(raw.Seats) ? `${raw.Seats}${num(raw.SeatRows) ? ` in ${raw.SeatRows} rows` : ''}` : null;
    const bed = num(raw.BedLengthIN) ? `${fmt(raw.BedLengthIN, 1)} in${present(raw.BedType) ? ', ' + raw.BedType : ''}` : null;
    const rows = [
      row('Year', v.year), row('Make', makeName(v.make)), row('Model', v.model), row('Trim', v.trim),
      checked(r, 'Body', v.body_class, 'body'), row('Cab', raw.BodyCabType), row('Bed', bed), row('Doors', num(v.doors)), checked(r, 'Seats', seats, 'seats'),
      // The regulatory class repeats the body style: screen only on paper when the body is known (one-page print).
      row('Vehicle type', present(v.vehicle_type) ? sentence(v.vehicle_type) : null).replace('<div class="sheet-row">', present(v.body_class) ? '<div class="sheet-row sheet-screen-only">' : '<div class="sheet-row">'),
      row('Manufacturer', present(raw.Manufacturer) ? titleCase(raw.Manufacturer) : null),
      row('Assembly plant', [p.city, p.state, p.country].filter(present).map(titleCase).join(', ')),
    ];
    return section('vehicle', 'Vehicle', list(rows) || unknownNote);
  }


  /**
   * Print rules for the one-page sheet: what prints is a leading part of the screen text, and the explanation after it
   * is screen only (class sheet-screen-only), so screen and paper never say different things.
   * Rated power: "175 hp (maker’s EPA test vehicles)" on paper; a hybrid's "engine rating" caveat prints.
   */
  function ratedPower(hp, caveat) {
    const so = t => `<span class="sheet-screen-only">${t}</span>`;
    const cav = caveat ? (/^engine rating/.test(caveat) ? `engine rating${so(esc(caveat.slice('engine rating'.length)))}; ` : `${esc(caveat)}; `) : '';
    return `${esc(hp)} (${cav}maker’s EPA test vehicles${so(' for this engine family')})`;
  }
  /** A FuelEconomy.gov summary on paper: through "the VIN does not say which" / "the figure holds whichever it is"; what separates the configurations is screen only. */
  function paperSummary(summary) {
    const s = String(summary || '');
    for (const mark of ['the VIN does not say which', 'so the figure holds whichever it is']) {
      const i = s.indexOf(mark);
      if (i >= 0 && i + mark.length < s.length) return esc(s.slice(0, i + mark.length)) + `<span class="sheet-screen-only">${esc(s.slice(i + mark.length))}</span>`;
    }
    return esc(s);
  }
  function powerSection(r) {
    const e = r.engine || {}, t = r.transmission || {}, raw = r.raw_nhtsa || {}, f = r.fuel_economy || {};
    const engine = engineText(e, raw);
    const code = present(e.type) && !/battery/i.test(e.type) ? e.type : null;
    const fuel = [e.fuel_type, raw.FuelTypeSecondary].filter(present).join(' / ');
    const grade = f.available && present(f.fuel_type) && !f.is_ev ? ` (EPA: ${String(f.fuel_type).toLowerCase()})` : '';
    const trans = [num(t.speeds) && `${t.speeds}-speed`, present(t.type) && String(t.type).toLowerCase()].filter(Boolean).join(' ');
    const kwh = num(raw.BatteryKWh), kwhTo = num(raw.BatteryKWh_to);
    const battery = kwh ? `${fmtAuto(kwh)}${kwhTo && kwhTo !== kwh ? '–' + fmtAuto(kwhTo) : ''} kWh` : null;
    const charger = [present(raw.ChargerLevel) && String(raw.ChargerLevel).split(' (')[0], num(raw.ChargerPowerKW) && `${fmtAuto(raw.ChargerPowerKW)} kW`].filter(Boolean).join(', ');
    const unit = f.is_ev ? 'MPGe' : 'mpg';
    const range = typeof MoreSources !== 'undefined' ? MoreSources.fuelRangeText(f) : null; // several EPA configurations fit
    const mpg = f.available && num(f.combined_mpg) ? `${f.combined_mpg} ${unit} combined${num(f.city_mpg) && num(f.highway_mpg) ? ` (${f.city_mpg} city, ${f.highway_mpg} hwy)` : ''}` : range;
    const isEv = /BEV/i.test(e.ev_type || '') || /^electric$/i.test(e.fuel_type || '');
    // vPIC often has no horsepower: then the EPA test vehicles' rated figure, labelled (public/more-sources.js).
    const epaHp = !num(e.hp) && typeof MoreSources !== 'undefined' ? MoreSources.epaHp(r) : null;
    const rows = [
      marked(r, isEv ? 'Motor' : 'Engine', engine || null, engineText(checkedEngine(r, e), raw) || null, 'engine_size', 'cylinders'), row('Engine code', code), row('Fuel', fuel ? fuel + grade : null),
      epaHp ? rowHtml('Rated power', ratedPower(epaHp, MoreSources.epaHpCaveat(r))) : '',
      marked(r, 'Transmission', trans || null, transText(checkedTrans(r, t)) || null, 'transmission', 'speeds'), checked(r, 'Drive', t.drive_type, 'drive'), checked(r, 'Electrification', e.ev_type, 'powertrain'),
      row('Battery', battery), row('Charging', charger || null),
      row('EPA fuel economy', mpg), row(f.total_range ? 'EPA electric range' : 'EPA range', f.available && num(f.ev_range) ? `${f.ev_range} mi` : null),
    ];
    // On paper: the match kind and that the VIN does not say which; the configurations and what separates them are screen only.
    // The transmission assumption (or the owner's choice) prints as its own note, so its label is not repeated in the summary.
    const tc = f.transmission_choice, summary = tc && f.summary ? String(f.summary).replace(tc.label + ': ', '') : f.summary;
    const note = choiceNote(f) + (range ? `<p class="sheet-note">EPA range: ${paperSummary(summary || 'several EPA configurations fit this VIN')}.</p>`
      : mpg && f.match === 'same_rating' ? `<p class="sheet-note">${paperSummary(summary)}.</p>`
      : mpg && f.match === 'closest' ? `<p class="sheet-note">Closest EPA configuration, not an exact match<span class="sheet-screen-only">: ${esc(f.matched_variant || 'see full report')}</span>.</p>`
      : mpg ? `<p class="sheet-note sheet-screen-only">EPA figures are for the matched test configuration: ${esc(f.matched_variant || 'see full report')}.</p>` : '');
    return section('power', 'Engine and drive', (list(rows) || unknownNote) + note + decodeNote(r));
  }
  /** "Assuming an automatic transmission (the VIN does not say)" or the owner's choice; the other side's figure on screen. */
  function choiceNote(f) {
    const tc = f.transmission_choice;
    if (!tc || !tc.label) return '';
    const other = (f.alternatives || []).find(a => a.for_transmission && a.for_transmission !== tc.chosen);
    const unit = other && (other.unit || (other.is_ev ? 'MPGe' : 'mpg'));
    const c = other && other.mpg_range && other.mpg_range.combined;
    const figure = !other ? null : other.available && num(other.combined_mpg) ? `${other.combined_mpg} ${unit} combined`
      : c ? `${c.min === c.max ? c.min : `${c.min}–${c.max}`} ${other.mpg_range.unit || unit} combined` : null;
    return `<p class="sheet-note">${esc(tc.label)}${figure ? `<span class="sheet-screen-only">; with ${other.for_transmission === 'manual' ? 'a manual' : 'an automatic'}: ${esc(figure)}</span>` : ''}.</p>`;
  }

  function sizeSection(r) {
    const d = r.dimensions || {};
    const rows = [
      row('GVWR (max. loaded weight)', d.gvwr), row('Curb weight', num(d.curb_weight) ? `${fmt(d.curb_weight)} lb` : null),
      row('Wheelbase', num(d.wheel_base) ? `${fmt(d.wheel_base, 1)} in` : null), row('Track width', num(d.track_width) ? `${fmt(d.track_width, 1)} in` : null),
    ];
    return section('size', 'Size and weight', `${list(rows)}<div class="sheet-dims" data-dims><p class="sheet-note sheet-loading">Loading Transport Canada model dimensions…</p></div>${specsBlock(r)}`);
  }

  // Crash-test reports (nrd-static) and compliance test reports (static.nhtsa.gov/odi/ctr/).
  const REPORT_HOSTS = ['https://nrd-static.nhtsa.dot.gov/', 'https://static.nhtsa.gov/odi/ctr/'];
  const reportUrlOk = u => REPORT_HOSTS.some(h => String(u || '').startsWith(h));
  /** "11055" for a crash test, "639465" for a compliance test report; the link names which kind. */
  const reportId = x => Number.isInteger(x.test_no) ? x.test_no : present(x.report_number) ? x.report_number : 'link';
  const reportLink = (x, short) => `<a href="${esc(x.report_url)}" target="_blank" rel="noopener">${short ? '' : x.source === 'nhtsa_compliance_test' ? 'NHTSA compliance test report ' : 'NHTSA test report '}${esc(reportId(x))}</a>`;
  const ELEC = { battery_electric: 'battery-electric', plug_in_hybrid: 'plug-in hybrid', fuel_cell: 'fuel-cell', mild_hybrid: 'mild hybrid', hybrid: 'hybrid', none: 'not hybrid or electric' };
  const lb = v => `${fmt(v.lb)} lb (${fmt(v.kg)} kg)`;

  const DIFF_LABEL = { wheel_size: 'wheel size', gvwr_class: 'GVWR' };
  /** Visible differences other than the year, in words: "trim Limited (yours: SEL)". */
  function diffWords(m) {
    return ((m && m.differences) || []).filter(d => d && d.field !== 'model_year' && present(d.tested) && present(d.yours)).map(d => {
      const [a, b] = d.field === 'electrification' ? [ELEC[d.tested] || d.tested, ELEC[d.yours] || d.yours] : [d.tested, d.yours];
      return `${DIFF_LABEL[d.field] || d.field} ${a} (yours: ${b})`;
    });
  }

  /**
   * How tested vehicles relate to this VIN, in plain words, as escaped HTML (match objects from the report).
   * Several vehicles with the same values are described together ("the 2024 and 2026 models"). The
   * reassuring same-wheelbase sentence and the generic "can change between years" are screen only (the year and
   * every listed difference print).
   */
  function matchHtml(matches, subject) {
    const list = (Array.isArray(matches) ? matches : [matches]).filter(Boolean), m = list[0];
    if (!m || m.kind === 'exact') return 'Same model year.';
    const diffs = [...new Set(list.flatMap(diffWords))];
    if (m.kind === 'different_variant') return esc(`Same model year, different version: ${diffs.join('; ') || 'see the report'}.`) + `<span class="sheet-screen-only"> ${esc(subject)} can differ between versions.</span>`;
    const years = [...new Set(list.map(x => x.tested_model_year))].sort();
    // "can change between years" is screen only: the year is stated, and the sheet must print on one page
    let out = esc(years.length > 1 ? `NHTSA tested the ${years.join(' and ')} models (yours is ${m.vin_model_year}); both list the same values.`
      : `NHTSA tested the ${m.tested_model_year} model (yours is ${m.vin_model_year}).`) + `<span class="sheet-screen-only"> ${esc(subject)} can change between years.</span>`;
    if (diffs.length) out += esc(` Also different: ${diffs.join('; ')}.`);
    const other = list.filter(x => x.generation_check === 'different_wheelbase').map(x => x.tested_model_year);
    if (other.length) out += esc(` Transport Canada lists a different wheelbase for ${other.join(' and ')}, so it is likely another generation and these values may not apply.`);
    else if (list.every(x => x.generation_check === 'same_wheelbase')) out += `<span class="sheet-screen-only"> Transport Canada lists the same wheelbase for ${years.length > 1 ? 'these years' : 'both years'}.</span>`;
    return out;
  }
  const matchText = (m, subject) => matchHtml(m, subject).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  const psiOk = v => Number.isInteger(v) && v > 0;
  const kpaOk = v => typeof v === 'number' && Number.isFinite(v) && v > 0;

  /** NHTSA's tested vehicles closest to this VIN (match stated per vehicle): as printed in its reports, or []. */
  function testedPlacards(tp) {
    if (!tp || tp.available !== true || !Array.isArray(tp.vehicles)) return [];
    return tp.vehicles.filter(v => v && present(v.tested_as) && v.tires && present(v.tires.front) && present(v.tires.rear)
      && v.cold_pressure_psi && psiOk(v.cold_pressure_psi.front) && psiOk(v.cold_pressure_psi.rear)
      && v.cold_pressure_kpa && kpaOk(v.cold_pressure_kpa.front) && kpaOk(v.cold_pressure_kpa.rear)
      && reportUrlOk(v.report_url));
  }

  const PRINT_MAX = 2;

  /**
   * "In mcp.vin’s accuracy test, matches like this were right for tire size 92%, pressures 96%. " (report field
   * accuracy), or ''. Screen only: the one-page print keeps the match wording and caveats, not the percentages.
   */
  function accuracyText(a, fields) {
    if (!a) return '';
    const parts = fields.filter(([k]) => Number.isFinite(a[`${k}_right_pct`])).map(([k, label]) => `${label} ${a[`${k}_right_pct`]}%`);
    return parts.length ? `In mcp.vin’s accuracy test, matches like this were right for ${parts.join(', ')}. ` : '';
  }

  /**
   * A confirmed correction of a misprint in NHTSA's report (report field correction / corrections): on paper the fact
   * that a misprint was corrected; on screen also what the report printed, why the corrected value holds and links to the
   * reports that confirm it.
   */
  function correctionHtml(c, subject) {
    if (!c || !present(c.note)) return '';
    const links = (c.confirmed_by || []).filter(x => x && reportUrlOk(x.report_url) && present(x.report)).map(x => `<a href="${esc(x.report_url)}" target="_blank" rel="noopener">${esc(x.report)}</a>`);
    const uniq = [...new Set(links)];
    // a correction of one of several reports names it: "(test 10553): it prints 36/36 under a kPa heading; ..."
    const which = present(c.report) && reportUrlOk(c.report_url) ? ` <a href="${esc(c.report_url)}" target="_blank" rel="noopener">${esc(c.report)}</a>` : '';
    const note = esc(String(c.note).replace(/\.\s*$/, '')).replace(which ? /^NHTSA’s report (also )?prints/ : /^$/, (m, also) => `it ${also || ''}prints`);
    // subject: which of several shown values was corrected ("16.3 gal")
    return `<span class="sheet-correction"> ${subject ? `The ${esc(subject)} value is corrected` : 'Corrected'} from a misprint in NHTSA’s report<span class="sheet-screen-only">${which}: ${note}${uniq.length ? ` (confirmed by ${uniq.join(', ')})` : ''}</span>.</span>`;
  }

  /** One list item per distinct set of values; tested vehicles with identical values share it. */
  function placardItems(tested) {
    const groups = new Map();
    for (const v of tested) {
      const key = JSON.stringify([v.tires, v.cold_pressure_psi, v.cold_pressure_kpa]);
      groups.set(key, [...(groups.get(key) || []), v]);
    }
    return [...groups.values()].map(g => g.length === 1 ? placardItem(g[0]) : placardItem(g[0], g));
  }

  function placardItem(v, group = [v]) {
    const psi = v.cold_pressure_psi, kpa = v.cold_pressure_kpa;
    const tires = v.tires.front === v.tires.rear ? `${v.tires.front} front and rear` : `${v.tires.front} front, ${v.tires.rear} rear`;
    const cold = psi.front === psi.rear && kpa.front === kpa.rear
      ? `${psi.front} psi front and rear (${fmtAuto(kpa.front)} kPa)`
      : `${psi.front} psi front (${fmtAuto(kpa.front)} kPa), ${psi.rear} psi rear (${fmtAuto(kpa.rear)} kPa)`;
    const link = x => reportLink(x, group.length > 1);
    return `<li class="placard-test"><span class="placard-as">NHTSA test vehicle${group.length > 1 ? 's' : ''}: ${esc(group.map(x => x.tested_as).join('; '))}</span>`
      + `<span class="placard-match">${matchHtml(group.map(x => x.match), 'Tires and pressures')}</span>`
      + `<span class="placard-values">Tires ${esc(tires)}</span><span class="placard-values">Cold ${esc(cold)}</span>`
      + group.flatMap(x => x.corrections || []).map(correctionHtml).join('')
      + (group.length > 1 ? `<span class="placard-links">NHTSA test reports ${group.map(link).join(', ')}</span></li>` : `${link(v)}</li>`);
  }

  function tireSection(r) {
    const raw = r.raw_nhtsa || {}, tpms = (r.safety_equipment || {}).tpms, tp = r.tire_placard;
    const front = num(raw.WheelSizeFront), rear = num(raw.WheelSizeRear);
    const wheels = front && rear && front !== rear ? `${fmtAuto(front)} in front, ${fmtAuto(rear)} in rear` : (front || rear) ? `${fmtAuto(front || rear)} in` : null;
    const tpmsText = !present(tpms) ? null : /^direct$/i.test(tpms) ? 'Direct (a pressure sensor in each wheel)' : /^indirect$/i.test(tpms) ? 'Indirect (reads wheel speed, no pressure sensors)' : tpms;
    const rows = [row('Wheel diameter', wheels), row('Pressure monitor (TPMS)', tpmsText)];
    const tested = testedPlacards(tp);
    // On paper at most PRINT_MAX tested vehicles (closest first) keep the sheet to one page; the rest stay on screen.
    const items = placardItems(tested), more = items.length - PRINT_MAX;
    const listed = items.map((h, i) => i < PRINT_MAX ? h : h.replace('<li class="placard-test"', '<li class="placard-test sheet-screen-only"')).join('');
    const tests = tested.length
      ? `<ul class="placard-tests">${listed}</ul>${more > 0 ? `<p class="sheet-note sheet-print-only">${more} more NHTSA test vehicle${more > 1 ? 's' : ''} with other values: see the live report.</p>` : ''}<p class="sheet-note placard-governs"><span class="sheet-screen-only">${esc(accuracyText(tp.accuracy, [['tire_size', 'tire size'], ['cold_pressure', 'pressures']]))}</span>Your own door placard governs (driver’s door pillar)<span class="sheet-screen-only">; it can differ by trim and tire size</span>.</p>`
      : '';
    const placard = 'The recommended cold pressures and original tire sizes are printed on the Tire and Loading Information placard, normally on the driver’s door pillar (FMVSS No. 110).';
    const reach = tp && Number.isInteger(tp.max_year_gap) ? tp.max_year_gap : 2;
    const note = tested.length ? `Copy your car’s own values from its Tire and Loading Information placard (driver’s door pillar).`
      : tp && tp.available === true && tp.reason === 'other_powertrain_only' ? `${placard} NHTSA tested this make and model nearby only with a different powertrain (battery-electric or not), so mcp.vin shows no values.`
      : tp && tp.available === true && tp.reason === 'other_generation_only' ? `${placard} NHTSA tested this make and model nearby only in years Transport Canada lists with a different wheelbase (likely another generation), so mcp.vin shows no values.`
      : tp && tp.available === true ? `${placard} NHTSA’s test reports list them only for the vehicles it tested; none of this make and model within ${reach} model years is indexed (not tested, or not indexed yet), so mcp.vin shows no values.`
      : `${placard} NHTSA’s test-vehicle index was not checked for this report, so mcp.vin shows no values.`;
    const fields = [writeIn('Tire size, front'), writeIn('Tire size, rear'), writeIn('Cold pressure, front', 'psi'), writeIn('Cold pressure, rear', 'psi'), writeIn('Spare', 'psi')].join('');
    return section('tires', 'Tires and wheels', list(rows) + tests,
      `<fieldset class="write-ins"><legend>Copy from the tire placard</legend>${fields}</fieldset><p class="sheet-note${tested.length ? ' sheet-screen-only' : ''}">${esc(note)}</p>${correctionControl(r)}`);
  }

  const goodMass = v => v && num(v.kg) && num(v.lb);
  /** The NHTSA test vehicle shown for capacities and weights, or null (report field test_vehicle_specs). */
  function testedSpecs(sp) {
    if (!sp || sp.available !== true || !Array.isArray(sp.vehicles) || !sp.vehicles.length) return null;
    const v = sp.vehicles[0];
    return v && present(v.tested_as) && reportUrlOk(v.report_url) ? v : null;
  }

  /** "14.3 gal (54.09 L)": US gallons converted from the litres as printed (both kept); a gallon print stays as printed. */
  function tankText(t) {
    const printed = String(t.printed || '');
    if (/^\d+(\.\d+)? gal$/.test(printed)) return `${printed} (${fmt(t.litres, 1)} L)`;
    return `${fmt(t.gallons, 1)} gal (${/^\d+(\.\d+)? L$/.test(printed) ? printed.slice(0, -2) : fmtAuto(t.litres)} L)`;
  }

  const TANK_CAVEAT = '<span class="sheet-screen-only">; tank size can differ by year, trim and options</span>'; // paper: the "best guess" label says it
  /** Fuel tank row: one tested vehicle's printed usable standard tank; labelled a best guess unless exact. */
  function fuelTankRow(sp, v, r) {
    const ft = sp.fuel_tank || {}, isEv = /BEV/i.test((r.engine || {}).ev_type || '') || /^electric$/i.test((r.engine || {}).fuel_type || '');
    if (isEv || v.electrification === 'battery_electric') return '';
    const others = Array.isArray(ft.model_tank_sizes) && ft.model_tank_sizes.length > 1
      ? `<span class="sheet-screen-only"> NHTSA’s tested ${esc(v.model)} vehicles list more than one tank: ${ft.model_tank_sizes.map(s => `${fmt(s.gallons, 1)} gal (${s.model_years.join(', ')}${s.electrification && s.electrification !== 'none' ? ', ' + (ELEC[s.electrification] || s.electrification) : ''})`).join('; ')}.</span>` : '';  // screen only: the list can be long, and the sheet must print on one page
    if (!ft.shown) {
      const why = ft.reason === 'different_electrification' ? esc(ft.note || 'The tested vehicle’s electrification differs from this VIN’s, so no tank size is shown.')
        : ft.reason === 'other_generation_only' ? 'NHTSA’s nearby tested vehicles that list a tank are from years with a different wheelbase (likely another generation).'
        : 'The test report does not list the tank size.';
      return rowHtml('Fuel tank', `Not shown<span class="sheet-source">${why}${others}</span>`);
    }
    const vals = (ft.values || []).filter(x => num(x.gallons) && num(x.litres));
    if (!vals.length) return '';
    const value = vals.map(tankText).join(' or ');
    const several = vals.length > 1 ? ' NHTSA tested vehicles with different tanks; yours depends on options.' : '';
    const optional = ft.optional_tank_listed && num(ft.optional_tank_listed.gallons) ? ` The report also lists an optional ${tankText(ft.optional_tank_listed)} tank.` : '';
    // The tank comes from the closest tested vehicle that lists one; it can be another report than the capacities.
    const m = vals[0].match || v.match || {};
    const own = reportUrlOk(vals[0].report_url) && vals[0].report_url !== v.report_url ? ` ${vals[0].tested_as ? esc(vals[0].tested_as) + ', ' : ''}${reportLink(vals[0])}.` : '';
    const from = (!ft.best_guess ? 'NHTSA test vehicle, same model year.'
      : m.kind === 'different_variant' ? `From NHTSA’s ${esc(m.tested_model_year)} test vehicle, a different version (${esc(diffWords(m).join('; '))})${TANK_CAVEAT}.`
      : `From NHTSA’s ${esc(vals.map(x => x.model_year).filter((y, i, a) => a.indexOf(y) === i).join(' and '))} test vehicle${vals.length > 1 ? 's' : ''} (yours is ${esc(m.vin_model_year)})${TANK_CAVEAT}.`) + own;
    const acc = ft.accuracy && Number.isFinite(ft.accuracy.right_pct) ? `<span class="sheet-screen-only"> In mcp.vin’s accuracy test, matches like this were right for ${ft.accuracy.right_pct}%.</span>` : '';
    return rowHtml(ft.best_guess ? 'Fuel tank (best guess)' : 'Fuel tank', `${esc(value)}<span class="sheet-source">${from}${acc}${several}${optional}${others}${vals.map(x => correctionHtml(x.correction, vals.length > 1 ? tankText(x) : null)).join('')}</span>`);
  }

  /**
   * One capacity row. When NHTSA's equally close tested vehicles print different values and no matching rule
   * separates them (report field test_vehicle_specs.values_differ), all values are shown, never one picked.
   */
  function capacityRow(sp, field, label, own) {
    const set = ((sp.values_differ || {})[field] || []).filter(x => x && x.value);
    const text = x => field === 'seating' ? (num(x.total) ? String(x.total) : null) : goodMass(x) ? lb(x) : null;
    const vals = set.map(x => ({...x, text: text(x.value)})).filter(x => x.text);
    if (vals.length < 2) return row(label, own);
    return rowHtml(label, `${esc(vals.map(x => x.text).join(' or '))}<span class="sheet-source sheet-screen-only">NHTSA’s equally close test vehicles differ: ${esc(vals.map(x => `${x.tested_as}, ${x.text}`).join('; '))}; yours depends on version and options.</span>`);
  }

  /** Capacities and weights of NHTSA's test vehicle (closest match), inside "Size and weight". */
  function specsBlock(r) {
    const sp = r.test_vehicle_specs, v = testedSpecs(sp);
    const reach = sp && Number.isInteger(sp.max_year_gap) ? sp.max_year_gap : 2;
    if (!v) {
      const why = !sp || sp.available !== true ? 'NHTSA’s test-vehicle index was not checked for this report, so no tested fuel tank, payload or axle ratings are shown.'
        : sp.reason === 'other_powertrain_only' ? 'NHTSA tested this make and model nearby only with a different powertrain, so its fuel tank, payload and axle ratings are not shown.'
        : sp.reason === 'other_generation_only' ? 'NHTSA tested this make and model nearby only in years Transport Canada lists with a different wheelbase (likely another generation), so its fuel tank, payload and axle ratings are not shown.'
        : `NHTSA has no tested vehicle of this make and model within ${reach} model years in mcp.vin’s index (not tested, or not indexed yet), so no tested fuel tank, payload or axle ratings are shown.`;
      return `<p class="sheet-note tested-none">${why} They are on the door-pillar label and in the owner’s manual.</p>`;
    }
    const s = v.seating, c = v.curb_weight_as_delivered;
    const rowsOf = s ? [num(s.front) && `${s.front} front`, num(s.rear) && `${s.rear} rear`, num(s.third) && `${s.third} third row`].filter(Boolean) : [];
    const seats = s && num(s.total) ? `${s.total}${rowsOf.length ? ` (${rowsOf.join(', ')})` : ''}` : null; // compliance reports print the total only
    const gawr = goodMass(v.gawr_front) && goodMass(v.gawr_rear) ? `Front ${lb(v.gawr_front)}; rear ${lb(v.gawr_rear)}` : null;
    const curb = c && goodMass(c.total) && goodMass(c.front) && goodMass(c.rear)
      ? `${lb(c.total)}<span class="sheet-screen-only">; front ${fmt(c.front.lb)} lb, rear ${fmt(c.rear.lb)} lb (${fmt(c.front_percent)}% front)</span>` : null; // axle split: screen only (one-page print)
    const rows = [
      fuelTankRow(sp, v, r),
      capacityRow(sp, 'payload', 'Payload (vehicle capacity weight)', goodMass(v.payload_vehicle_capacity_weight) ? lb(v.payload_vehicle_capacity_weight) : null),
      capacityRow(sp, 'seating', 'Seating capacity', seats),
      v.gvwr && v.gvwr.correction && goodMass(v.gvwr) && !((sp.values_differ || {}).gvwr || []).length
        ? rowHtml('GVWR (label)', `${esc(lb(v.gvwr))}<span class="sheet-source">${correctionHtml(v.gvwr.correction)}</span>`)
        : capacityRow(sp, 'gvwr', 'GVWR (label)', goodMass(v.gvwr) ? lb(v.gvwr) : null),
      gawr && ((v.gawr_front || {}).correction || (v.gawr_rear || {}).correction)
        ? rowHtml('GAWR (label)', `${esc(gawr)}<span class="sheet-source">${[(v.gawr_front || {}).correction, (v.gawr_rear || {}).correction].map(correctionHtml).join('')}</span>`)
        : row('GAWR (label)', gawr),
      curb ? rowHtml('Curb weight, as delivered', curb) : '',
    ];
    // one test vehicle can have several compliance reports (FMVSS 110, 138, 537): each is linked
    const links = [v, ...(Array.isArray(v.other_reports) ? v.other_reports : []).filter(o => o && reportUrlOk(o.report_url))];
    return `<div class="tested-specs"><p class="tested-specs-head">NHTSA test vehicle: ${esc(v.tested_as)}</p>`
      + `<p class="sheet-note tested-match">${matchHtml(v.match, 'Capacities and weights')} Values printed in NHTSA’s test report${links.length > 1 ? 's' : ''}, not this VIN’s. <span class="sheet-screen-only">${esc(accuracyText(sp.accuracy, [['payload', 'payload'], ['seating', 'seating'], ...(goodMass(v.gvwr) ? [['gvwr', 'GVWR']] : [])]))}</span>${links.length > 1 ? `NHTSA ${v.source === 'nhtsa_compliance_test' ? 'compliance ' : ''}test reports ${links.map(x => reportLink(x, true)).join(', ')}` : reportLink(v)}</p>`
      + `${list(rows) || '<p class="sheet-note">The test report lists none of these values.</p>'}`
      + `${v.withheld && present(v.withheld.note) ? `<p class="sheet-note tested-withheld sheet-screen-only">${esc(v.withheld.note)}</p>` : ''}</div>`;
  }

  /** One line under Engine and drive when a decoded value was corrected, doubted or filled; then the report control. */
  function decodeNote(r) {
    const dc = DC(), fields = dc ? dc.fields(r) : [];
    if (!dc) return '';
    const n = s => fields.filter(f => f.status === s).length;
    const parts = [n('corrected') && `${n('corrected')} corrected`, n('doubtful') && `${n('doubtful')} doubtful`, n('filled') && `${n('filled')} filled in`].filter(Boolean);
    const line = parts.length ? `<p class="sheet-note dc-sheet-note sheet-screen-only">Decode checks: ${esc(parts.join(', '))}, official decode kept; details in the full report.</p>` : '';
    return line + dc.formHtml(r);
  }

  /** "Doesn't match your door placard?": a correction for review; screen only, never printed or shown to others. */
  function correctionControl(r) {
    const vin = String(r.vin || '');
    if (vin.length !== 17) return '';
    const shown = testedPlacards(r.tire_placard).length || testedSpecs(r.test_vehicle_specs);
    const input = (name, label, attrs = '') => `<label class="fix-field"><span>${esc(label)}</span><input name="${name}" autocomplete="off" spellcheck="false" ${attrs}></label>`;
    return `<details class="placard-fix sheet-screen-only"><summary>${shown ? 'Doesn’t match your door placard?' : 'Tell us what your door placard says'}</summary>`
      + `<form class="placard-fix-form" data-vin="${esc(vin)}" novalidate><p class="sheet-note">Send the values from your own door placard and fuel tank. We review corrections before using them; they are never shown to other readers. Please leave personal details out of the note. <a href="/privacy/#corrections">Privacy</a></p>`
      + `<div class="fix-grid">${input('tire_front', 'Tire size, front', 'maxlength="40" placeholder="225/55R18 98H"')}${input('tire_rear', 'Tire size, rear', 'maxlength="40"')}`
      + `${input('psi_front', 'Cold pressure, front (psi)', 'inputmode="decimal" maxlength="5"')}${input('psi_rear', 'Cold pressure, rear (psi)', 'inputmode="decimal" maxlength="5"')}`
      + `<label class="fix-field"><span>Fuel tank</span><span class="fix-tank"><input name="fuel_tank" autocomplete="off" inputmode="decimal" maxlength="6"><select name="fuel_tank_unit" aria-label="Fuel tank unit"><option value="gal">gal</option><option value="L">L</option></select></span></label>`
      + `<label class="fix-field fix-note"><span>Note (optional)</span><textarea name="note" maxlength="500" rows="2"></textarea></label></div>`
      + `<button type="submit" class="secondary">Send correction</button><p class="placard-fix-status" role="status" aria-live="polite"></p></form></details>`;
  }

  function manualSection(r) {
    const m = manualFor(r), isEv = /BEV/i.test((r.engine || {}).ev_type || '') || /^electric$/i.test((r.engine || {}).fuel_type || '');
    const link = m
      ? `<p class="sheet-manual"><a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.title)}</a><span class="sheet-url">${esc(host(m.url))}</span></p>`
      : `<p class="sheet-manual">No official online manual library is listed here for ${esc(makeName((r.vehicle || {}).make) || 'this make')}. Use the printed manual in the glovebox or the maker’s owner website.</p>`;
    const fields = [!isEv && writeIn('Engine oil grade and capacity'), writeIn('Fuse box locations'), writeIn('Wiper blade sizes'), writeIn('12-volt battery'), writeIn('Notes')].filter(Boolean).join('');
    return section('manual', 'Owner’s manual and service', link + `<p class="sheet-note">The manual shows the fuse box diagrams, fluid types and capacities.<span class="sheet-screen-only"> mcp.vin links to it and does not copy it.</span></p><fieldset class="write-ins"><legend>Copy from the manual</legend>${fields}</fieldset>`);
  }

  function recallSection(r) {
    const v = r.vehicle || {}, s = r.recall_status, rec = r.recalls, c = r.complaints, rat = r.safety_ratings || {};
    const name = [v.year, makeName(v.make), v.model].filter(present).join(' ');
    let status;
    if (s && s.available) {
      const provider = (s.source && s.source.provider) || 'the manufacturer';
      const checked = fmtDate(s.source && s.source.retrieved_at);
      const unk = x => (x === null || x === undefined ? 'unknown' : fmt(x));
      const open = s.open_record_count !== undefined
        ? `${unk(s.open_record_count)} open recall or campaign records`
        : `${unk(s.open_count)} open`;
      const completed = s.coverage && s.coverage.completed_history === false && (s.completed_count === null || s.completed_count === undefined)
        ? 'completed history not supplied by this source' : `${unk(s.completed_count)} completed or closed`;
      const parts = [open, completed, s.unknown_count ? `${fmt(s.unknown_count)} with unknown status` : '', s.service_campaign_count ? `${fmt(s.service_campaign_count)} other maker program${s.service_campaign_count === 1 ? '' : 's'}` : ''].filter(Boolean);
      const alert = Number(s.open_count) > 0 || Number(s.open_record_count) > 0;
      status = `<span class="${alert ? 'sheet-alert' : ''}">${esc(parts.join(' · '))}</span><span class="sheet-source">Reported by ${esc(provider)}${checked ? `, checked ${esc(checked)}` : ''}.</span>`;
    } else {
      const why = s && s.reason === 'interactive_verification_required' ? 'The maker’s check needs a person to verify.' : 'Not available for this vehicle here.';
      status = `Unknown. ${esc(why)}`;
    }
    const verify = (s && s.verification_url) || 'https://www.nhtsa.gov/recalls' + (/^[A-HJ-NPR-Z0-9]{17}$/i.test(r.vin || '') ? '?vin=' + String(r.vin).toUpperCase() : '');
    status += ` <a href="${esc(verify)}" target="_blank" rel="noopener">Check this VIN with the official source</a><span class="sheet-url">${esc(site(verify))}</span>`;
    const campaigns = !rec || rec.available === false || typeof rec.count !== 'number' ? 'Unknown (lookup unavailable)'
      : `${fmt(rec.count)} for the ${name}`;
    const related = rec && rec.related_models && rec.related_models.available && rec.related_models.count > 0 ? ` (plus ${fmt(rec.related_models.count)} filed under related model names; they may not apply)` : '';
    const otherName = rec && rec.count === 0 && !related && (rec.related_campaigns_found === null || (rec.related_models && rec.related_models.decoded_name_in_recall_data === false))
      ? ' (NHTSA may file campaigns for this vehicle under another model name)' : '';
    const complaints = !c || c.available === false || typeof c.count !== 'number' ? 'Unknown (lookup unavailable)' : `${fmt(c.count)} for this model year`;
    const stars = rat.rated && num(rat.overall) ? `${rat.overall} of 5 stars overall` : rat.rated ? 'Rated, but no overall score published' : 'No NHTSA rating found';
    const rows = [
      rowHtml('This VIN’s recall status', status),
      rowHtml('Model-year recall campaigns', `${esc(campaigns + related + otherName)}<span class="sheet-source">NHTSA campaigns for the make, model and year. Not this car’s repair status.</span>`),
      rowHtml('Owner complaints to NHTSA', `${esc(complaints)}<span class="sheet-source">Reports, not confirmed defects.</span>`),
      row('NHTSA crash rating', stars),
    ];
    return section('recalls', 'Recalls and safety', list(rows));
  }

  function vinSection(r) {
    const vin = String(r.vin || ''), val = r.validation || {}, v = r.vehicle || {}, p = r.plant || {}, w = val.wmi || {}, raw = r.raw_nhtsa || {};
    if (vin.length !== 17) return '';
    const check = val.checksum ? (val.checksum.valid ? 'Valid' : `Invalid (expected ${val.checksum.expected})`) : null;
    // The local WMI table does not know every maker code; vPIC's manufacturer for this VIN is the fallback.
    const maker = present(w.manufacturer) && w.manufacturer !== 'Unknown' ? w.manufacturer : present(raw.Manufacturer) ? titleCase(raw.Manufacturer) : null;
    const rows = [
      ['1–3', vin.slice(0, 3), [maker, w.country].filter(present).join(', ') || 'Manufacturer code'],
      ['4–8', vin.slice(3, 8), 'Model, body and engine codes (set by the maker)'],
      ['9', vin[8], check ? `Check digit: ${check.toLowerCase()}` : 'Check digit'],
      ['10', vin[9], present(v.year) ? `Model year ${v.year}` : 'Model year'],
      ['11', vin[10], present(p.city) ? `Plant: ${titleCase(p.city)}` : 'Assembly plant'],
      ['12–17', vin.slice(11), 'Serial number'],
    ];
    return section('vin', 'VIN decoded, position by position', `<ol class="vin-strip">${rows.map(([a, b, c]) => `<li><span class="vin-pos">Position ${esc(a)}</span><code>${esc(b)}</code><span class="vin-meaning">${esc(c)}</span></li>`).join('')}</ol>`);
  }

  function footer(r) {
    const vin = esc(r.vin), url = `https://mcp.vin/${vin}`, assembled = fmtDate(r.provenance && r.provenance.assembled_at);
    const maker = r.recall_status && r.recall_status.available && r.recall_status.source && r.recall_status.source.provider;
    const crash = [testedPlacards(r.tire_placard).length && 'tire placard', testedSpecs(r.test_vehicle_specs) && 'capacities and weights'].filter(Boolean);
    const sources = ['NHTSA vPIC (maker-submitted VIN data)', 'NHTSA recalls, complaints and crash ratings', crash.length && `NHTSA test reports (test-vehicle ${crash.join(', ')})`, r.fuel_economy && r.fuel_economy.available && 'EPA FuelEconomy.gov', 'Transport Canada via NHTSA vPIC (dimensions)', maker].filter(Boolean);
    const qr = typeof VinQr !== 'undefined' ? VinQr.svg(url, `QR code linking to ${url}`) : '';
    // On paper a value filled where the official decode is blank carries a dagger instead of a "Filled in" tag.
    const filled = typeof DecodeChecks !== 'undefined' && DecodeChecks.fields(r).some(f => f.status === 'filled');
    const dagger = filled ? '<span class="dc-print-only"> · † filled in where the official decode is blank (NHTSA test vehicles, EPA)</span>' : '';
    return `<div class="sheet-foot-text"><p><strong>Sources:</strong> ${esc(sources.join('; '))}.${assembled ? ` Data gathered ${esc(assembled)}.` : ''}</p><p>Decoded from the VIN and public records; options, repairs and later changes are not shown. Check the placard, the manual and the official recall links.</p><p class="sheet-live">Live report: <a href="${url}">${url}</a>${dagger}</p></div>${qr ? `<div class="sheet-qr">${qr}</div>` : ''}`;
  }

  /** Sheet HTML for a report: {body, foot}. Pure; used by render() and the tests. */
  function html(r) {
    return {
      body: [vehicleSection(r), powerSection(r), recallSection(r), sizeSection(r), tireSection(r), manualSection(r), vinSection(r)].join(''),
      foot: footer(r),
    };
  }

  /** Summarize Transport Canada variants (metric). Values all variants agree on are single; others are ranges. */
  function dimensionSummary(results) {
    const variants = (Array.isArray(results) ? results : []).map(x => Object.fromEntries((x.Specs || []).map(s => [s.Name, s.Value])));
    if (!variants.length) return null;
    const pick = (key, toUs, unit, metricUnit, digits) => {
      const vals = variants.map(v => num(v[key])).filter(x => x !== null);
      if (!vals.length) return null;
      const lo = Math.min(...vals), hi = Math.max(...vals);
      const us = x => fmt(toUs(x), digits), metric = x => fmt(x, 0);
      return Math.abs(toUs(hi) - toUs(lo)) < (digits ? 0.05 : 0.5)
        ? `${us(lo)} ${unit} (${metric(lo)} ${metricUnit})`
        : `${us(lo)}–${us(hi)} ${unit} (${metric(lo)}–${metric(hi)} ${metricUnit})`;
    };
    const cm = x => x / 2.54, kg = x => x * 2.20462;
    return {
      count: variants.length,
      names: variants.map(v => v.Model).filter(present),
      length: pick('OL', cm, 'in', 'cm', 1), width: pick('OW', cm, 'in', 'cm', 1), height: pick('OH', cm, 'in', 'cm', 1),
      wheelbase: pick('WB', cm, 'in', 'cm', 1), curb: pick('CW', kg, 'lb', 'kg', 0),
    };
  }

  function dimensionsHtml(summary, r) {
    if (!summary) return '<p class="sheet-note sheet-screen-only">No Transport Canada dimension record matched this model name.</p>';
    const d = r.dimensions || {};
    const rows = [row('Length', summary.length), row('Width', summary.width), row('Height', summary.height),
      num(d.wheel_base) ? '' : row('Wheelbase', summary.wheelbase), num(d.curb_weight) ? '' : row('Curb weight', summary.curb)];
    const which = summary.count === 1 ? `the record “${summary.names[0] || 'unnamed'}”` : summary.count <= 3 ? `${summary.count} records (${summary.names.join('; ')})` : `${summary.count} model variants; ranges cover all of them`;
    return `${list(rows)}<p class="sheet-note">Transport Canada model data<span class="sheet-screen-only">, ${esc(which)}</span>. Not specific to this VIN.</p>`;
  }

  let current = null;
  async function loadDimensions(r) {
    const target = typeof document !== 'undefined' && document.querySelector('#sheet-body [data-dims]');
    const v = r.vehicle || {};
    if (!target || !present(v.year) || !present(v.make) || !present(v.model)) { if (target) target.innerHTML = ''; return; }
    const ask = async model => {
      const res = await fetch(`/api/research/dimensions?${new URLSearchParams({ year: v.year, make: v.make, model })}`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    };
    try {
      let data = await ask(v.model);
      // vPIC and Transport Canada name some models differently ("Bolt EV" / "BOLT 4DR HATCHBACK").
      // Retry with the first word only; the matched record names are printed so the reader can judge.
      if (data.available && !data.data.length && /\s/.test(String(v.model).trim())) data = await ask(String(v.model).trim().split(/\s+/)[0]);
      if (current !== r) return;
      target.innerHTML = data.available ? dimensionsHtml(dimensionSummary(data.data), r) : '<p class="sheet-note sheet-screen-only">Transport Canada dimensions are unavailable right now.</p>';
    } catch {
      if (current === r) target.innerHTML = '<p class="sheet-note sheet-screen-only">Transport Canada dimensions are unavailable right now.</p>';
    }
  }

  function render(r) {
    current = r;
    const body = document.querySelector('#sheet-body'), foot = document.querySelector('#sheet-foot');
    if (!body || !r || !r.vehicle) return;
    const out = html(r), v = r.vehicle, title = document.querySelector('#vehicle-title');
    // Same name as the server-rendered page title: "2017 Chevrolet Bolt EV LT", not the vPIC capitals.
    if (title) title.textContent = [v.year, makeName(v.make), v.model, v.trim].filter(present).join(' ');
    body.innerHTML = out.body;
    if (foot) foot.innerHTML = out.foot;
    const assembled = fmtDate(r.provenance && r.provenance.assembled_at), prepared = document.querySelector('#sheet-prepared');
    if (prepared) prepared.textContent = assembled ? `Data gathered ${assembled} from public NHTSA, EPA, Transport Canada and maker records.` : 'From public NHTSA, EPA, Transport Canada and maker records.';
    loadDimensions(r);
  }

  // "Print this sheet" prints one page; the toolbar's "Print view" prints the sheet followed by the full report.
  if (typeof document !== 'undefined' && document.addEventListener) {
    const root = document.documentElement;
    const clear = () => root.classList.remove('print-sheet-only');
    document.querySelector('#print-sheet')?.addEventListener('click', () => {
      if (window.VinWorkspace?.canPrint('report') === false) return;
      root.classList.add('print-sheet-only');
      addEventListener('afterprint', clear, { once: true });
      window.print();
    });
    document.querySelector('#print-view')?.addEventListener('click', clear);
    // "Doesn't match your door placard?" sends the reader's own values for review (POST /api/placard-corrections).
    document.addEventListener('submit', async event => {
      const form = event.target;
      if (!form || !form.matches || !form.matches('form.placard-fix-form')) return;
      event.preventDefault();
      const status = form.querySelector('.placard-fix-status'), button = form.querySelector('button[type=submit]');
      const data = Object.fromEntries(new FormData(form));
      data.vin = form.dataset.vin;
      if (!String(data.fuel_tank || '').trim()) delete data.fuel_tank_unit;
      button.disabled = true;
      status.textContent = 'Sending…';
      try {
        const res = await fetch('/api/placard-corrections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        const out = await res.json().catch(() => ({}));
        if (res.ok) {
          status.textContent = out.message || 'Thanks. We review corrections before using them.';
          form.querySelectorAll('input, select, textarea').forEach(el => { el.disabled = true; });
          return;
        }
        status.textContent = res.status === 429 ? 'Too many corrections from this network. Try again in a minute.' : out.error || 'The correction could not be sent. Try again later.';
      } catch {
        status.textContent = 'The correction could not be sent. Check the connection and try again.';
      }
      button.disabled = false;
    });
    // Jump to the full report without changing the URL hash, which names the workspace view.
    document.querySelector('#full-report-link')?.addEventListener('click', event => {
      if (window.ReportTabs) { event.preventDefault(); window.ReportTabs.select('all', { scroll: true }); return; }
      const heading = document.querySelector('#full-report');
      if (!heading) return;
      event.preventDefault();
      heading.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      heading.focus({ preventScroll: true });
    });
  }

  return { manualFor, html, dimensionSummary, dimensionsHtml, fmtDate, render, testedPlacards, testedSpecs, matchText };
})();
if (typeof window !== 'undefined') window.CarSheet = CarSheet;
