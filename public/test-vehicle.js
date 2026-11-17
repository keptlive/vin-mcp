/* Full report: the FMVSS No. 135 brake test of the closest NHTSA test vehicle (report field
 * test_vehicle_specs.stopping_distance), shown under the safety ratings. Not on the one-page sheet.
 *
 * Rules: values only as NHTSA's compliance test report printed them (metres; feet converted), from one
 * tested vehicle, with the match to this VIN stated in words and the report linked. Not a rating and not
 * this VIN. Nothing is shown when no brake test is indexed within reach (missing never means zero).
 */
const TestVehicle = (() => {
  const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const HOSTS = ['https://static.nhtsa.gov/odi/ctr/', 'https://nrd-static.nhtsa.dot.gov/'];
  const okUrl = u => HOSTS.some(h => String(u || '').startsWith(h));
  const okStop = s => s && Number.isFinite(s.m) && s.m > 0 && Number.isFinite(s.ft) && s.ft > 0;
  const fmt = v => Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });

  function matchText(m) {
    if (!m || m.kind === 'exact') return 'Same model year.';
    const diffs = (m.differences || []).filter(d => d && d.field !== 'model_year' && d.tested && d.yours).map(d => `${d.field} ${d.tested} (yours: ${d.yours})`);
    if (m.kind === 'different_variant') return `Same model year, different version: ${diffs.join('; ') || 'see the report'}.`;
    let out = `NHTSA tested the ${m.tested_model_year} model (yours is ${m.vin_model_year}).`;
    if (diffs.length) out += ` Also different: ${diffs.join('; ')}.`;
    if (m.generation_check === 'different_wheelbase') out += ' Transport Canada lists a different wheelbase for that year, so it is likely another generation.';
    return out;
  }

  /** HTML for the brake test block, or '' when there is nothing to show. */
  function html(report) {
    const sd = report && report.test_vehicle_specs && report.test_vehicle_specs.stopping_distance;
    if (!sd || sd.shown !== true || !Array.isArray(sd.vehicles)) return '';
    const items = sd.vehicles.filter(v => v && v.tested_as && okUrl(v.report_url) && (okStop(v.lightly_loaded) || okStop(v.fully_loaded_gvwr))).map(v => {
      const parts = [okStop(v.lightly_loaded) && `${fmt(v.lightly_loaded.m)} m (${fmt(v.lightly_loaded.ft)} ft) lightly loaded`,
        okStop(v.fully_loaded_gvwr) && `${fmt(v.fully_loaded_gvwr.m)} m (${fmt(v.fully_loaded_gvwr.ft)} ft) loaded to its GVWR`].filter(Boolean);
      return `<li><span class="brake-test-vehicle">${esc(v.tested_as)}</span>: stop from 100 km/h (62 mph) in ${esc(parts.join('; '))}. `
        + `<span class="brake-test-match">${esc(matchText(v.match))}</span> `
        + `<a href="${esc(v.report_url)}" target="_blank" rel="noopener">${esc(v.report_label || 'NHTSA test report')}</a></li>`;
    });
    if (!items.length) return '';
    return `<div class="brake-test"><h4 class="brake-test-title">Brake test of an NHTSA test vehicle (FMVSS No. 135)</h4><ul>${items.join('')}</ul>`
      + `<p class="brake-test-note">One vehicle in NHTSA’s brake compliance test; the standard allows at most 70 m (230 ft) from 100 km/h. Not a rating and not this VIN: brakes, tires, load and road change real stopping distances.</p></div>`;
  }

  function render(report) {
    if (typeof document === 'undefined') return;
    const body = document.getElementById('safety-ratings-body');
    if (!body) return;
    const old = body.querySelector('.brake-test');
    if (old) old.remove();
    const block = html(report);
    if (block) body.insertAdjacentHTML('beforeend', block);
  }

  return { render, html };
})();
if (typeof window !== 'undefined') window.TestVehicle = TestVehicle;
