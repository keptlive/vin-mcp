/**
 * Server-rendered head and summary for /{VIN} pages.
 *
 * The workspace is a client-side app, so without this every VIN URL returned
 * the same generic HTML. Crawlers and link previews now get the vehicle's own
 * title, description, canonical URL, structured data and a short summary. The
 * app removes the summary block when it starts and draws the full report.
 */
const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const titleCase = v => String(v || '').toLowerCase().replace(/(^|[\s-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
const num = v => Number(v).toLocaleString('en-US');

/** Plain facts from a report; every entry is omitted when the source has no value. */
export function vinFacts(report) {
  const v = report.vehicle || {}, e = report.engine || {}, t = report.transmission || {}, p = report.plant || {};
  const make = /^[A-Z]{2,4}$/.test(v.make || '') && (v.make || '').length <= 3 ? v.make : titleCase(v.make);
  const name = [v.year, make, v.model, v.trim].filter(Boolean).join(' ');
  const engine = [e.displacement_l && Number(e.displacement_l).toFixed(1) + ' L', e.cylinders && e.cylinders + '-cylinder', e.fuel_type && String(e.fuel_type).toLowerCase()].filter(Boolean).join(' ');
  const facts = [];
  const add = (label, value) => { if (value !== null && value !== undefined && value !== '') facts.push([label, String(value)]); };
  add('VIN', report.vin);
  add('Year, make and model', name);
  add('Body', v.body_class);
  add('Engine', engine + (e.hp ? `${engine ? ', ' : ''}${e.hp} hp` : ''));
  add('Transmission', [t.type, t.speeds && t.speeds + '-speed'].filter(Boolean).join(', '));
  add('Assembly plant', [titleCase(p.city), titleCase(p.state)].filter(Boolean).join(', '));
  const f = report.fuel_economy;
  if (f?.available && f.combined_mpg) add('EPA fuel economy', `${f.combined_mpg} mpg combined (${f.city_mpg} city, ${f.highway_mpg} highway)`);
  const r = report.recalls;
  if (r?.available !== false && typeof r?.count === 'number') add('Recall campaigns for this model year', !zeroMayMislead(r) ? num(r.count)
    : r.related_campaigns_found === true ? '0 under this exact model name; NHTSA lists campaigns under related model names that may or may not apply'
    : '0 under this exact model name; NHTSA has never filed a campaign under this name, so campaigns may be listed under another name');
  const c = report.complaints;
  if (c?.available !== false && typeof c?.count === 'number') add('NHTSA complaints for this model year', num(c.count));
  const s = report.safety_ratings;
  if (s?.rated && s.overall) add('NHTSA overall safety rating', `${s.overall} of 5 stars`);
  return { name, make, engine, facts };
}

/** Counts stay exact-name only; a bare zero is not stated when related names carry campaigns or NHTSA never uses this name. */
function zeroMayMislead(r) {
  return r?.count === 0 && (r.related_campaigns_found === true || r.related_models?.decoded_name_in_recall_data === false);
}

const setTag = (html, pattern, replacement) => {
  if (!pattern.test(html)) throw new Error('vin page: template tag missing ' + pattern);
  return html.replace(pattern, () => replacement);
};

/** The generic page for a VIN that cannot be decoded: same app, kept out of search indexes. */
export function renderUnknownVinPage(html) {
  return setTag(html, /<link rel="canonical"[^>]*>/, '<meta name="robots" content="noindex">');
}

export function renderVinPage(html, report) {
  const vin = report.vin, url = `https://mcp.vin/${vin}`;
  const { name, make, engine, facts } = vinFacts(report);
  const v = report.vehicle, r = report.recalls, c = report.complaints, f = report.fuel_economy;
  const title = `${name} VIN ${vin}: specs, recalls and safety | mcp.vin`;
  const parts = [`${name}${v.body_class ? ' ' + String(v.body_class).toLowerCase() : ''}${engine ? ', ' + engine : ''}.`];
  if (r?.available !== false && typeof r?.count === 'number' && !zeroMayMislead(r)) parts.push(`${num(r.count)} recall campaign${r.count === 1 ? '' : 's'}${c?.available !== false && typeof c?.count === 'number' ? ` and ${num(c.count)} NHTSA complaint${c.count === 1 ? '' : 's'}` : ''} for this model year.`);
  else if (c?.available !== false && typeof c?.count === 'number') parts.push(`${num(c.count)} NHTSA complaint${c.count === 1 ? '' : 's'} for this model year.`);
  if (f?.available && f.combined_mpg) parts.push(`${f.combined_mpg} mpg combined.`);
  parts.push('Free VIN report from NHTSA and EPA data.');
  const description = parts.join(' ');

  const car = {
    '@context': 'https://schema.org', '@type': 'Car', name, url,
    vehicleIdentificationNumber: vin,
    ...(make && { brand: { '@type': 'Brand', name: make } }),
    ...(v.model && { model: v.model }),
    ...(v.year && { vehicleModelDate: String(v.year) }),
    ...(v.body_class && { bodyType: v.body_class }),
    ...(v.doors && { numberOfDoors: v.doors }),
    ...(report.engine?.fuel_type && { fuelType: report.engine.fuel_type }),
    ...(report.transmission?.type && { vehicleTransmission: report.transmission.type }),
  };
  const summary = `<div id="ssr-summary" class="ssr-summary"><h2>${esc(name)}</h2><p>Vehicle report for VIN ${esc(vin)}, from public NHTSA and EPA data.</p><dl>${facts.map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`).join('')}</dl><p>Recall campaigns and complaints are counted for the make, model and year. They do not show whether this vehicle is affected or repaired. JSON: <a href="/api/vin/${esc(vin)}">/api/vin/${esc(vin)}</a></p></div>`;

  html = setTag(html, /<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`);
  html = setTag(html, /<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(description)}">`);
  html = setTag(html, /<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${url}">`);
  html = setTag(html, /<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${esc(title)}">`);
  html = setTag(html, /<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${esc(description)}">`);
  html = setTag(html, /<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${url}">`);
  html = setTag(html, /<meta name="twitter:title" content="[^"]*">/, `<meta name="twitter:title" content="${esc(title)}">`);
  html = setTag(html, /<meta name="twitter:description" content="[^"]*">/, `<meta name="twitter:description" content="${esc(description)}">`);
  html = setTag(html, /<\/head>/, `  <script type="application/ld+json">${JSON.stringify(car).replace(/</g, '\\u003c')}</script>\n</head>`);
  html = setTag(html, /<section id="report" class="workspace-panel">/, `<section id="report" class="workspace-panel">${summary}`);
  return html;
}
