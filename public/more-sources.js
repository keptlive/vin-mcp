/* Extra official sources in the full report (loaded before app.js):
 * - recall build-date ranges (NHTSA recall flat file, BGMAN/ENDMAN)
 * - EPA test vehicles (EPA Test Car List): rated horsepower and tested axle ratios in the engine card
 * - parts content and origin for the carline, MY2020-2027 (NHTSA Part 583 / AALA): a card after Manufacturing
 * - production and theft for the vehicle line, MY1998-2012 (NHTSA final theft data): a card after that
 * - FuelEconomy.gov match disclosure: the range and every configuration when the VIN fits several,
 *   and the closest-match note when no configuration fits every detail
 *
 * Rules: only report facts are shown; missing values are left out, never zero; every value
 * that is not specific to this VIN says so; a closest match says it is one.
 */
const MoreSources = (() => {
  const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const present = v => v !== null && v !== undefined && v !== '';

  /** One line for a recall campaign: the manufacturer's build-date range, or '' when none was filed. */
  function builtHtml(recall) {
    const from = recall && recall.manufactured_from, to = recall && recall.manufactured_to;
    if (!present(from) && !present(to)) return '';
    const range = present(from) && present(to) ? `${esc(from)} to ${esc(to)}`
      : present(from) ? `from ${esc(from)} (no end date filed)` : `up to ${esc(to)} (no start date filed)`;
    const note = recall.manufactured_range_note ? ` ${esc(recall.manufactured_range_note)}` : '';
    return `<div class="recall-built"><span class="recall-detail-label">Build dates:</span> Manufacturer says affected vehicles were built ${range}.${note} Your build month is on the door-jamb label.</div>`;
  }

  const num = v => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  const fmt = v => Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const span = r => (r ? (r.min === r.max ? fmt(r.min) : `${fmt(r.min)}–${fmt(r.max)}`) : null);
  const dataRow = (label, value) => (present(value) ? `<div class="data-row"><span class="data-label">${esc(label)}</span><span class="data-value">${esc(value)}</span></div>` : '');

  /** "325 hp" or "240–255 hp" from the EPA test vehicles, or null. */
  function epaHp(r) {
    const t = r && r.epa_test_vehicles;
    return t && t.available && t.rated_hp ? `${span(t.rated_hp)} hp` : null;
  }
  /** For hybrids and plug-ins: EPA's figure is the engine alone (hp_note from the server), else ''. */
  function epaHpCaveat(r) {
    const t = r && r.epa_test_vehicles;
    return t && t.available && t.rated_hp && t.hp_note ? 'engine rating, not the combined hybrid system output' : '';
  }

  /** Rows for the full report's engine card: EPA test-vehicle facts, labelled as such. */
  function engineRowsHtml(r) {
    const t = r && r.epa_test_vehicles;
    if (!t || !t.available) return '';
    const years = (t.tested_model_years || []).join(', ');
    const rows = [
      dataRow('Rated horsepower (EPA test vehicles)', epaHp(r) && (epaHpCaveat(r) ? `${epaHp(r)} (${epaHpCaveat(r)})` : epaHp(r))),
      dataRow('Axle ratios tested', (t.axle_ratios || []).map(fmt).join(', ')),
      dataRow('Transmission tested', (t.transmissions || []).join('; ')),
      dataRow('EPA test weight', t.test_weight_lb ? `${span(t.test_weight_lb)} lb` : null),
      dataRow('EPA test group', (t.test_groups || []).join(', ')),
    ].join('');
    const closest = t.match === 'closest_test_configuration' ? 'Closest EPA test configuration. ' : '';
    return rows + `<p class="small source-note">${closest}These are the manufacturer's EPA test vehicles for this engine family (EPA Test Car List${years ? ', model year ' + esc(years) : ''}), not necessarily this car's configuration. Matched by: ${esc((t.match_basis || []).join('; '))}.</p>`;
  }

  const int = v => Number(v).toLocaleString('en-US');

  // ---- FuelEconomy.gov match (fuel card and car sheet) ----
  const basisText = f => (f.match_basis || []).map(b => String(b).replace(/^differs: /, 'differs from the VIN: ')).join('; ');
  /** "22–25 mpg combined (19–21 city, 26–29 highway)" when the VIN fits several EPA configurations, else null. */
  function fuelRangeText(f) {
    const m = f && f.match === 'multiple_configurations' && f.mpg_range;
    if (!m || !m.combined) return null;
    return `${span(m.combined)} ${m.unit} combined${m.city && m.highway ? ` (${span(m.city)} city, ${span(m.highway)} hwy)` : ''}`;
  }
  /** Fuel card body for several EPA configurations: the range, each configuration and the match basis; '' otherwise. */
  function fuelSeveralHtml(f) {
    if (!f || f.match !== 'multiple_configurations') return '';
    const range = f.mpg_range && f.mpg_range.combined;
    return (range ? `<div class="mpg-row"><div class="mpg-item"><div class="mpg-value">${esc(span(range))}</div><div class="mpg-label">Combined ${esc(f.mpg_range.unit)}, range</div></div></div>` : '')
      + `<p class="small">${esc(f.summary || 'Several EPA configurations fit this VIN')}.</p>`
      + configList(f)
      + `<p class="small source-note">EPA rates configurations, not individual cars. Matched by: ${esc(basisText(f))}.</p>`;
  }
  /** Each configuration: what separates it in plain words ("6-speed manual"), its figures and EPA's own listing. */
  function configList(f) {
    const items = (f.configurations || []).map(c => {
      const what = [c.transmission, num(c.displacement) ? `${fmt(c.displacement)} L` : null, num(c.cylinders) ? `${c.cylinders} cyl` : null, c.engine_note].filter(present).join(', ');
      const figure = num(c.combined_mpg) ? `<strong>${esc(c.combined_mpg)} ${esc(c.unit)}</strong> combined${num(c.city_mpg) && num(c.highway_mpg) ? ` (${esc(c.city_mpg)} city, ${esc(c.highway_mpg)} highway)` : ''}` : 'no EPA figure';
      const epa = `EPA: ${esc(c.epa_model)}${what ? ' · ' + esc(what) : ''}`;
      return `<li>${c.label ? `${esc(c.label)}: ` : ''}${figure} <span class="source-note">(${epa})</span>${c.source_url ? ` <a href="${esc(c.source_url)}" rel="noopener">EPA</a>` : ''}</li>`;
    }).join('');
    const more = num(f.configuration_count) > (f.configurations || []).length ? `<li>and ${esc(f.configuration_count - f.configurations.length)} more</li>` : '';
    return items || more ? `<ul class="small fuel-configs">${items}${more}</ul>` : '';
  }
  /** Note under a single EPA figure: the closest-match disclosure, or what was matched; '' without a match record. */
  function fuelMatchNote(f) {
    if (!f || !f.available || !f.match) return '';
    // The same combined rating for every configuration the VIN fits: the figure stands, the configurations are listed.
    if (f.match === 'same_rating') return `<p class="small">${esc(f.summary)}.</p>${configList(f)}<p class="small source-note">${f.closest ? 'Closest EPA configurations, not an exact match. ' : ''}Matched by: ${esc(basisText(f))}.</p>`;
    return `<p class="small source-note">${f.match === 'closest' ? 'Closest EPA configuration, not an exact match. ' : ''}Matched by: ${esc(basisText(f))}.</p>`;
  }

  /** Body of the "Production and theft (historical)" card, or '' when the model year or line is not in NHTSA's report. */
  function theftHtml(r) {
    const p = r && r.production_theft;
    if (!p || !p.available || !(p.lines || []).length) return '';
    const several = p.lines.length > 1;
    const lines = p.lines.map((l, i) => (several ? `<p class="small"${i ? ' style="margin-top:14px"' : ''}><strong>${esc(l.line)}</strong></p>` : '') + [
      dataRow('Vehicle line', several ? null : `${l.line} (${l.manufacturer})`),
      dataRow(`Production, model year ${p.model_year}`, int(l.production)),
      dataRow(`Thefts in ${p.calendar_year}`, int(l.thefts)),
      dataRow('Theft rate', `${l.thefts_per_1000_produced} per 1,000 produced${l.rate_check ? ' (as printed; does not equal thefts ÷ production)' : ''}`),
      dataRow('Rank', present(l.rank) ? `${l.rank} of ${l.lines_ranked} lines (1 = highest rate)` : null),
    ].join('')).join('');
    const closest = p.match === 'closest_line_name' ? `Closest line name: matched by ${esc((p.match_basis || []).join('; '))}. ` : '';
    const src = p.source && p.source.url ? ` <a href="${esc(p.source.url)}" rel="noopener">Federal Register ${esc(p.source.document_number)}</a>.` : '';
    return lines + `<p class="small source-note">${closest}Figures for the whole vehicle line, not this car: thefts of model year ${esc(p.model_year)} vehicles reported to the FBI's crime information center in ${esc(p.calendar_year)}, and the line's production as reported to the EPA (NHTSA final theft data).${src}</p>`;
  }

  /** Body of the "Parts content and origin" card, or '' when the model year or carline is not in the AALA reports. */
  function partsHtml(r) {
    const a = r && r.parts_content;
    if (!a || !a.available || !(a.rows || []).length) return '';
    const several = a.rows.length > 1;
    const origin = (o, col, row) => (o ? o.countries : (row.unreadable || []).includes(col) ? 'Not readable in the report' : null);
    const body = a.rows.map((row, i) => (several ? `<p class="small"${i ? ' style="margin-top:14px"' : ''}><strong>${esc(row.carline)}</strong> (listed version ${i + 1} of ${a.rows.length})</p>` : '') + [
      dataRow('Carline in the report', several ? null : row.carline),
      dataRow('US/Canadian parts content', `${row.us_canada_parts_pct}%`),
      dataRow('Other major sources', (row.other_major_sources || []).map(f => `${f.country || f.printed} ${f.pct}%`).join(', ') || null),
      dataRow('Final assembly', origin(row.final_assembly, 'final_assembly', row)),
      dataRow('Engine/motor from', origin(row.engine_origin, 'engine_origin', row)),
      dataRow('Transmission from', origin(row.transmission_origin, 'transmission_origin', row)),
      dataRow('Also printed', row.notes || null),
    ].join('')).join('');
    const closest = a.match === 'closest_carline' ? `Closest carline: ${esc((a.match_basis || []).join('; '))}. ` : '';
    const versions = a.rows_note ? esc(a.rows_note) + ' ' : '';
    const src = a.source && a.source.url ? ` <a href="${esc(a.source.url)}" rel="noopener">NHTSA AALA report, model year ${esc(a.model_year)}</a>.` : '';
    return body + `<p class="small source-note">${closest}${versions}Figures for the whole carline as the manufacturer reported them for the model year, not this car; content is the share of the parts' value.${src}</p>`;
  }

  const CARD_ICON = '<svg class="card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 15v-4"/><path d="M12 15V8"/><path d="M16 15v-6"/></svg>';

  /** Put (or replace) one extra card after an existing card; a card without content is removed. */
  function card(id, after, title, body) {
    const old = document.querySelector('#' + id);
    if (old) old.remove();
    const anchor = document.querySelector('#' + after);
    if (!body || !anchor) return;
    const section = document.createElement('section');
    section.className = 'card';
    section.id = id;
    section.innerHTML = `<h3 class="card-title">${CARD_ICON} ${esc(title)}</h3><div class="card-body">${body}</div>`;
    anchor.insertAdjacentElement('afterend', section);
  }

  /** Called by app.js after the report cards are drawn. */
  function render(r) {
    if (typeof document === 'undefined' || !r) return;
    // Each part on its own: a problem in one extra source never stops the rest of the report.
    const part = fn => { try { fn(); } catch (err) { console.error('[more-sources]', err); } };
    part(() => { const engine = document.querySelector('#engine-body'); if (engine) engine.innerHTML += engineRowsHtml(r); });
    part(() => card('card-parts-content', 'card-plant', 'Parts content and origin', partsHtml(r)));
    part(() => card('card-production-theft', document.querySelector('#card-parts-content') ? 'card-parts-content' : 'card-plant', 'Production and theft (historical)', theftHtml(r)));
  }

  return { builtHtml, epaHp, epaHpCaveat, engineRowsHtml, partsHtml, theftHtml, fuelRangeText, fuelSeveralHtml, fuelMatchNote, render };
})();
if (typeof window !== 'undefined') window.MoreSources = MoreSources;
