/* Car information sheet: the one-page summary that opens a VIN report.
 *
 * Rules kept here (and tested in tests/car-sheet.test.mjs):
 * - Only facts from the report's public sources are printed. A missing value is
 *   left out or shown as "Unknown", never as zero.
 * - Fuse layout, oil and other owner's-manual facts have no public per-vehicle
 *   source. The sheet links to the maker's official manual library and leaves
 *   labelled spaces to copy the values from the door-pillar placard (FMVSS No. 110,
 *   49 CFR 571.110 S4.3) and the manual. Nothing is guessed.
 * - Tire size and cold pressures are shown only as NHTSA printed them for its own
 *   crash-test vehicle of the exact same make, model and model year (report field
 *   tire_placard), labelled as that test vehicle and linked to the report. They are
 *   never this VIN's placard values, never another model year's, never estimated;
 *   the write-in blanks stay for the owner's own placard.
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
      row('Body', v.body_class), row('Cab', raw.BodyCabType), row('Bed', bed), row('Doors', num(v.doors)), row('Seats', seats),
      row('Vehicle type', present(v.vehicle_type) ? sentence(v.vehicle_type) : null),
      row('Manufacturer', present(raw.Manufacturer) ? titleCase(raw.Manufacturer) : null),
      row('Assembly plant', [p.city, p.state, p.country].filter(present).map(titleCase).join(', ')),
    ];
    return section('vehicle', 'Vehicle', list(rows) || unknownNote);
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
    const mpg = f.available && num(f.combined_mpg) ? `${f.combined_mpg} ${unit} combined${num(f.city_mpg) && num(f.highway_mpg) ? ` (${f.city_mpg} city, ${f.highway_mpg} hwy)` : ''}` : null;
    const isEv = /BEV/i.test(e.ev_type || '') || /^electric$/i.test(e.fuel_type || '');
    const rows = [
      row(isEv ? 'Motor' : 'Engine', engine || null), row('Engine code', code), row('Fuel', fuel ? fuel + grade : null),
      row('Transmission', trans || null), row('Drive', t.drive_type), row('Electrification', e.ev_type),
      row('Battery', battery), row('Charging', charger || null),
      row('EPA fuel economy', mpg), row('EPA range', f.available && num(f.ev_range) ? `${f.ev_range} mi` : null),
    ];
    const note = mpg ? `<p class="sheet-note">EPA figures are for the matched test configuration: ${esc(f.matched_variant || 'see full report')}.</p>` : '';
    return section('power', 'Engine and drive', (list(rows) || unknownNote) + note);
  }

  function sizeSection(r) {
    const d = r.dimensions || {};
    const rows = [
      row('GVWR (max. loaded weight)', d.gvwr), row('Curb weight', num(d.curb_weight) ? `${fmt(d.curb_weight)} lb` : null),
      row('Wheelbase', num(d.wheel_base) ? `${fmt(d.wheel_base, 1)} in` : null), row('Track width', num(d.track_width) ? `${fmt(d.track_width, 1)} in` : null),
    ];
    return section('size', 'Size and weight', `${list(rows)}<div class="sheet-dims" data-dims><p class="sheet-note sheet-loading">Loading Transport Canada model dimensions…</p></div>`);
  }

  const REPORT_HOST = 'https://nrd-static.nhtsa.dot.gov/';
  const psiOk = v => Number.isInteger(v) && v > 0;
  const kpaOk = v => typeof v === 'number' && Number.isFinite(v) && v > 0;

  /** NHTSA's crash-test vehicles of this exact make, model and year: as printed in its reports, or []. */
  function testedPlacards(tp) {
    if (!tp || tp.available !== true || !Array.isArray(tp.vehicles)) return [];
    return tp.vehicles.filter(v => v && present(v.tested_as) && v.tires && present(v.tires.front) && present(v.tires.rear)
      && v.cold_pressure_psi && psiOk(v.cold_pressure_psi.front) && psiOk(v.cold_pressure_psi.rear)
      && v.cold_pressure_kpa && kpaOk(v.cold_pressure_kpa.front) && kpaOk(v.cold_pressure_kpa.rear)
      && String(v.report_url || '').startsWith(REPORT_HOST));
  }

  function placardItem(v) {
    const psi = v.cold_pressure_psi, kpa = v.cold_pressure_kpa;
    const tires = v.tires.front === v.tires.rear ? `${v.tires.front} front and rear` : `${v.tires.front} front, ${v.tires.rear} rear`;
    const cold = psi.front === psi.rear && kpa.front === kpa.rear
      ? `${psi.front} psi front and rear (${fmtAuto(kpa.front)} kPa)`
      : `${psi.front} psi front (${fmtAuto(kpa.front)} kPa), ${psi.rear} psi rear (${fmtAuto(kpa.rear)} kPa)`;
    const test = Number.isInteger(v.test_no) ? ` ${v.test_no}` : '';
    return `<li class="placard-test"><span class="placard-as">NHTSA test vehicle: ${esc(v.tested_as)}</span>`
      + `<span class="placard-values">Tires ${esc(tires)}</span><span class="placard-values">Cold ${esc(cold)}</span>`
      + `<a href="${esc(v.report_url)}" target="_blank" rel="noopener">NHTSA test report${esc(test)}</a></li>`;
  }

  function tireSection(r) {
    const raw = r.raw_nhtsa || {}, tpms = (r.safety_equipment || {}).tpms, tp = r.tire_placard;
    const front = num(raw.WheelSizeFront), rear = num(raw.WheelSizeRear);
    const wheels = front && rear && front !== rear ? `${fmtAuto(front)} in front, ${fmtAuto(rear)} in rear` : (front || rear) ? `${fmtAuto(front || rear)} in` : null;
    const tpmsText = !present(tpms) ? null : /^direct$/i.test(tpms) ? 'Direct (a pressure sensor in each wheel)' : /^indirect$/i.test(tpms) ? 'Indirect (reads wheel speed, no pressure sensors)' : tpms;
    const rows = [row('Wheel diameter', wheels), row('Pressure monitor (TPMS)', tpmsText)];
    const tested = testedPlacards(tp);
    const tests = tested.length
      ? `<ul class="placard-tests">${tested.map(placardItem).join('')}</ul><p class="sheet-note placard-governs">Your own door placard governs; it can differ by trim and tire size.</p>`
      : '';
    const placard = 'The recommended cold pressures and original tire sizes are printed on the Tire and Loading Information placard, normally on the driver’s door pillar (FMVSS No. 110).';
    const note = tested.length ? `Copy your car’s own values from its Tire and Loading Information placard, normally on the driver’s door pillar (FMVSS No. 110).`
      : tp && tp.available === true && tp.reason === 'other_powertrain_only' ? `${placard} NHTSA tested this make, model and year only with a different powertrain (battery-electric or not), so mcp.vin shows no values.`
      : tp && tp.available === true ? `${placard} NHTSA’s crash-test reports list them only for the vehicles it tested; none with this exact make, model and year is indexed, so mcp.vin shows no values.`
      : `${placard} NHTSA’s test-vehicle index was not checked for this report, so mcp.vin shows no values.`;
    const fields = [writeIn('Tire size, front'), writeIn('Tire size, rear'), writeIn('Cold pressure, front', 'psi'), writeIn('Cold pressure, rear', 'psi'), writeIn('Spare', 'psi')].join('');
    return section('tires', 'Tires and wheels', list(rows) + tests,
      `<fieldset class="write-ins"><legend>Copy from the tire placard</legend>${fields}</fieldset><p class="sheet-note">${esc(note)}</p>`);
  }

  function manualSection(r) {
    const m = manualFor(r), isEv = /BEV/i.test((r.engine || {}).ev_type || '') || /^electric$/i.test((r.engine || {}).fuel_type || '');
    const link = m
      ? `<p class="sheet-manual"><a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.title)}</a><span class="sheet-url">${esc(host(m.url))}</span></p>`
      : `<p class="sheet-manual">No official online manual library is listed here for ${esc(makeName((r.vehicle || {}).make) || 'this make')}. Use the printed manual in the glovebox or the maker’s owner website.</p>`;
    const fields = [!isEv && writeIn('Engine oil grade and capacity'), writeIn('Fuse box locations'), writeIn('Wiper blade sizes'), writeIn('12-volt battery'), writeIn('Notes')].filter(Boolean).join('');
    return section('manual', 'Owner’s manual and service', link + `<p class="sheet-note">The manual shows the fuse box diagrams, fluid types and capacities. mcp.vin links to it and does not copy it.</p><fieldset class="write-ins"><legend>Copy from the manual</legend>${fields}</fieldset>`);
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
    const verify = (s && s.verification_url) || 'https://www.nhtsa.gov/recalls';
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
    const sources = ['NHTSA vPIC (maker-submitted VIN data)', 'NHTSA recalls, complaints and crash ratings', testedPlacards(r.tire_placard).length && 'NHTSA crash-test reports (test-vehicle tire placard)', r.fuel_economy && r.fuel_economy.available && 'EPA FuelEconomy.gov', 'Transport Canada via NHTSA vPIC (dimensions)', maker].filter(Boolean);
    const qr = typeof VinQr !== 'undefined' ? VinQr.svg(url, `QR code linking to ${url}`) : '';
    return `<div class="sheet-foot-text"><p><strong>Sources:</strong> ${esc(sources.join('; '))}.${assembled ? ` Data gathered ${esc(assembled)}.` : ''}</p><p>Decoded from the VIN and public records; options, repairs and later changes are not shown. Check the placard, the manual and the official recall links.</p><p class="sheet-live">Live report: <a href="${url}">${url}</a></p></div>${qr ? `<div class="sheet-qr">${qr}</div>` : ''}`;
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
    return `${list(rows)}<p class="sheet-note">Transport Canada model data, ${esc(which)}. Not specific to this VIN.</p>`;
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
    // Jump to the full report without changing the URL hash, which names the workspace view.
    document.querySelector('#full-report-link')?.addEventListener('click', event => {
      const heading = document.querySelector('#full-report');
      if (!heading) return;
      event.preventDefault();
      heading.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      heading.focus({ preventScroll: true });
    });
  }

  return { manualFor, html, dimensionSummary, dimensionsHtml, fmtDate, render, testedPlacards };
})();
if (typeof window !== 'undefined') window.CarSheet = CarSheet;
