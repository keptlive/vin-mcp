/**
 * The manufacturer's own description of one VIN, read from the reply its U.S. recall lookup already returns
 * (lib/recall-status.mjs): no extra request is made. It outranks the pattern-level vPIC decode because it is the
 * manufacturer speaking about this exact vehicle (lib/decode-checks.mjs, tier "manufacturer_vin_record").
 *
 * What the replies carry (real replies saved 2026-11-16 and 2026-11-17):
 *   Volkswagen  `model`: "ATLAS S 3.6 LAUNCH FWD", "JETTA SPORT 1.8L AUTO PZ", "PASSAT TDI SE W/SUNROOF & NAV 2.0L AUTO"
 *   Audi        `model`: "A4 Sedan 2.0T FWD Multitronic", "Q5 2.0T QUATTRO TIPTRONIC", "A3 Sedan 1.8T FWD S tronic"
 *   Land Rover  `vehicle` / `vehicleName`, cut at 40 characters when no recall is open:
 *   and Jaguar  "Range Rover Evoque 2.0L Si4 Petrol 4WD A", "F-PACE 2.0L i4D 180PS Diesel AWD 5 Door",
 *               "Defender 2.0L T/C Petrol AWD 5 Door Auto"
 *   Subaru      `modelName` and `trimName`: "Outback", "2.5i Limited"
 *   Honda/Acura `model_group_name`: "MDX", "CR-V", "Accord Coupe"
 * Ford, GM, Tesla, Nissan and Mopar replies carry no description of the vehicle in what the site reads.
 *
 * Parse, do not guess: a value is set only when a word states it outright (2.0L, V6, Diesel, quattro, FWD,
 * Tiptronic, Multitronic, S tronic, AUTO, 5 Door); two words that disagree leave the value unset; words that are
 * not understood stay in `not_parsed`. Nothing is inferred from a model name (an Audi e-tron can be electric or a
 * plug-in hybrid, so "e-tron" is not parsed), and a missing word is not a negative (no "Diesel" does not mean
 * gasoline unless the text says "Petrol").
 */

const NOTE = 'The manufacturer\'s own description of this VIN, as its U.S. recall lookup returns it. Only what the text states outright is parsed; the rest is kept as written.';
// JLR's "no open recall" reply cuts the vehicle name at 40 characters ("... 4WD A" = "Auto", "5 D" = "5 Door").
const JLR_CUT = 40;

const str = v => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim() : null);
const year = v => { const n = Number(v); return Number.isInteger(n) && n >= 1981 && n <= 2100 ? n : null; };

/** The description text in a raw recall-lookup reply, or null. Pure. */
export function descriptionOf(provider, body) {
  if (!body || typeof body !== 'object') return null;
  if (provider === 'vw') {
    const t = str(body.model);
    return t ? {text: t, reply_field: 'model', model_year: year(body.year)} : null;
  }
  if (provider === 'audi') {
    const v = body.data?.vehicleRecalls;
    const t = str(v?.model);
    return t ? {text: t, reply_field: 'model', model_year: year(v.modelYear)} : null;
  }
  if (provider === 'landrover' || provider === 'jaguar') {
    if (body.error === 204) {
      const raw = typeof body.vehicle === 'string' ? body.vehicle : null;
      const t = str(raw);
      return t ? {text: t, reply_field: 'vehicle', model_year: year(body.model), truncated: raw.length >= JLR_CUT} : null;
    }
    const t = str(body.vehicleName);
    return t ? {text: t, reply_field: 'vehicleName', model_year: year(body.year), truncated: body.vehicleName.length >= JLR_CUT} : null;
  }
  if (provider === 'subaru') {
    const m = str(body.modelName), tr = str(body.trimName);
    return m ? {text: [m, tr].filter(Boolean).join(' '), reply_field: tr ? 'modelName + trimName' : 'modelName', model_year: year(body.modelYear), model: m, trim: tr} : null;
  }
  if (provider === 'honda') {
    const r = body.actions?.[0]?.returnValue?.returnValue?.response?.recalls_response?.response?.recall;
    const t = str(r?.model_group_name);
    return t ? {text: t, reply_field: 'model_group_name', model_year: null, division: r.division_cd === 'B' ? 'Acura' : r.division_cd === 'A' ? 'Honda' : null} : null;
  }
  return null;
}

// Word rules: [field, value, pattern on one word (upper case)]; a few rules span two words (S tronic) and are
// handled on the joined text first.
const DRIVE = [['all', /^(QUATTRO|4MOTION|AWD|4WD|4X4|ALL4|XDRIVE|SH-AWD)$/], ['front', /^FWD$/], ['rear', /^RWD$/], ['two', /^(2WD|4X2)$/]];
const TRANS = [['auto', /^(AUTO|AUTOMATIC|TIPTRONIC|A\/T)$/], ['cvt', /^(MULTITRONIC|CVT)$/], ['am', /^(DSG|STRONIC|S-TRONIC)$/], ['manual', /^(MANUAL|M\/T|MT)$/]];
const FUEL = [['diesel', /^(TDI|DIESEL|I4D)$/], ['gas', /^PETROL$/], ['phev', /^(PHEV|PLUG-IN)$/], ['mhev', /^MHEV$/], ['hev', /^HYBRID$/], ['ev', /^(BEV|E-GOLF|EV\d{3})$/]];
const BODY = [['sedan', /^SEDAN$/], ['coupe', /^COUPE$/], ['convertible', /^(CABRIOLET|CONVERTIBLE|ROADSTER|SPYDER)$/], ['wagon', /^(AVANT|WAGON|SPORTWAGEN|ALLTRACK)$/], ['hatchback', /^(HATCHBACK|SPORTBACK)$/]];
const IGNORE = /^(&|W\/|-)$/;

/**
 * Parse a description into what it states. Returns {parsed, parsed_from, not_parsed, conflicts}. Pure.
 * `truncated`: the text was cut at a fixed width, so a final "A"/"Au" can be read as the start of "Auto" and a
 * final "5 D" as "5 Door".
 */
export function parseDescription(text, {truncated = false} = {}) {
  const parsed = {}, from = {}, conflicts = new Set(), used = new Set();
  const set = (field, value, word, i) => {
    if (conflicts.has(field)) return;
    if (field in parsed && parsed[field] !== value) { conflicts.add(field); delete parsed[field]; delete from[field]; return; }
    parsed[field] = value; from[field] = from[field] && from[field] !== word ? `${from[field]} ${word}` : word;
    for (const k of [].concat(i)) used.add(k);
  };
  const words = String(text || '').split(' ').filter(Boolean);
  const up = words.map(w => w.toUpperCase());
  for (let i = 0; i < up.length; i++) {
    const w = up[i], two = i + 1 < up.length ? `${w} ${up[i + 1]}` : null;
    if (two === 'S TRONIC') { set('transmission', 'am', `${words[i]} ${words[i + 1]}`, [i, i + 1]); i++; continue; }
    let m;
    // Engine size: 2.0L, 1.8T, 2.0TFSI, a bare 3.6 (Volkswagen), Subaru trim 2.5i / 3.6R / 2.0XT.
    if ((m = w.match(/^(\d{1,2}\.\d)(L|T|TSI|TFSI|TDI|I|R|XT|X)?$/))) {
      const l = Number(m[1]);
      if (l >= 0.6 && l <= 8.5) { set('engine_size_l', l, words[i], i); if (m[2] === 'TDI') set('powertrain', 'diesel', words[i], i); continue; }
    }
    // Cylinders: V6, V8, VR6, W12, Si4, i4, I6, i4D (JLR diesel four).
    if ((m = w.match(/^(?:V|VR|W|SI|I)(3|4|5|6|8|10|12)(D?)$/))) { set('cylinders', Number(m[1]), words[i], i); if (m[2]) set('powertrain', 'diesel', words[i], i); continue; }
    if ((m = w.match(/^(\d{1,2})(?:-?SPEED|SPD)$/)) && Number(m[1]) <= 10) { set('speeds', Number(m[1]), words[i], i); continue; }
    if ((m = w.match(/^([5-9]|10)MT$/))) { set('transmission', 'manual', words[i], i); set('speeds', Number(m[1]), words[i], i); continue; }
    const rule = list => list.find(([, re]) => re.test(w));
    let r;
    if ((r = rule(DRIVE))) { set('drive', r[0], words[i], i); continue; }
    if ((r = rule(TRANS))) { set('transmission', r[0], words[i], i); continue; }
    if ((r = rule(FUEL))) { set('powertrain', r[0], words[i], i); continue; }
    if ((r = rule(BODY))) { set('body', r[0], words[i], i); continue; }
    // Doors: "5 Door", "4DR", "3-Door"; a final "5 D" only in a cut-off text.
    if (/^[2-5]$/.test(w) && /^(DOOR|DOORS|DR)$/.test(up[i + 1] || '')) { set('doors', Number(w), `${words[i]} ${words[i + 1]}`, [i, i + 1]); i++; continue; }
    if ((m = w.match(/^([2-5])-?(DOOR|DR)$/))) { set('doors', Number(m[1]), words[i], i); continue; }
    if (truncated && i === up.length - 2 && /^[2-5]$/.test(w) && up[i + 1] === 'D') { set('doors', Number(w), `${words[i]} ${words[i + 1]}`, [i, i + 1]); i++; continue; }
    // A cut-off final "A", "Au", "Aut" is the start of "Auto" (JLR writes the gearbox last).
    if (truncated && i === up.length - 1 && /^(A|AU|AUT)$/.test(w) && 'drive' in parsed) { set('transmission', 'auto', words[i], i); continue; }
  }
  const not_parsed = words.filter((w, i) => !used.has(i) && !IGNORE.test(w));
  return {parsed, parsed_from: from, not_parsed, conflicts: [...conflicts]};
}

/**
 * The `manufacturer_description` block for a recall-status result. `source` is the recall lookup's source
 * (provider, url, retrieved_at). Pure.
 */
export function manufacturerDescription(provider, body, source = null) {
  const d = descriptionOf(provider, body);
  if (!d) return {available: false, reason: ['vw', 'audi', 'landrover', 'jaguar', 'subaru', 'honda'].includes(provider) ? 'not_in_reply' : 'not_supplied_by_manufacturer'};
  const p = parseDescription(d.text, {truncated: !!d.truncated});
  // Subaru's trim is its own field; its engine size is stated in the trim ("2.5i Limited").
  if (provider === 'subaru' && d.trim) p.parsed.trim = d.trim;
  if (provider === 'honda' && d.division) p.parsed.division = d.division;
  return {available: true, text: d.text, reply_field: d.reply_field, model_year: d.model_year, truncated: !!d.truncated,
    parsed: p.parsed, parsed_from: p.parsed_from, not_parsed: p.not_parsed, ...(p.conflicts.length ? {conflicting_words: p.conflicts} : {}),
    source: source ? {provider: source.provider ?? null, url: source.url ?? null, retrieved_at: source.retrieved_at ?? null} : null, note: NOTE};
}
