/* Extra official sources in the full report (loaded before app.js):
 * - recall build-date ranges (NHTSA recall flat file, BGMAN/ENDMAN)
 * - EPA test vehicles (EPA Test Car List): rated horsepower and tested axle ratios in the engine card
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

  const fmt = v => Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const span = r => (r ? (r.min === r.max ? fmt(r.min) : `${fmt(r.min)}–${fmt(r.max)}`) : null);
  const dataRow = (label, value) => (present(value) ? `<div class="data-row"><span class="data-label">${esc(label)}</span><span class="data-value">${esc(value)}</span></div>` : '');

  /** "325 hp" or "240–255 hp" from the EPA test vehicles, or null. */
  function epaHp(r) {
    const t = r && r.epa_test_vehicles;
    return t && t.available && t.rated_hp ? `${span(t.rated_hp)} hp` : null;
  }

  /** Rows for the full report's engine card: EPA test-vehicle facts, labelled as such. */
  function engineRowsHtml(r) {
    const t = r && r.epa_test_vehicles;
    if (!t || !t.available) return '';
    const years = (t.tested_model_years || []).join(', ');
    const rows = [
      dataRow('Rated horsepower (EPA test vehicles)', epaHp(r)),
      dataRow('Axle ratios tested', (t.axle_ratios || []).map(fmt).join(', ')),
      dataRow('Transmission tested', (t.transmissions || []).join('; ')),
      dataRow('EPA test weight', t.test_weight_lb ? `${span(t.test_weight_lb)} lb` : null),
      dataRow('EPA test group', (t.test_groups || []).join(', ')),
    ].join('');
    const closest = t.match === 'closest_test_configuration' ? 'Closest EPA test configuration. ' : '';
    return rows + `<p class="small source-note">${closest}These are the manufacturer's EPA test vehicles for this engine family (EPA Test Car List${years ? ', model year ' + esc(years) : ''}), not necessarily this car's configuration. Matched by: ${esc((t.match_basis || []).join('; '))}.</p>`;
  }

  /** Called by app.js after the report cards are drawn. */
  function render(r) {
    if (typeof document === 'undefined' || !r) return;
    const engine = document.querySelector('#engine-body');
    if (engine) engine.innerHTML += engineRowsHtml(r);
  }

  return { builtHtml, epaHp, engineRowsHtml, render };
})();
if (typeof window !== 'undefined') window.MoreSources = MoreSources;
