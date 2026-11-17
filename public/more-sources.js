/* Extra official sources in the full report (loaded before app.js):
 * - recall build-date ranges (NHTSA recall flat file, BGMAN/ENDMAN)
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

  return { builtHtml };
})();
if (typeof window !== 'undefined') window.MoreSources = MoreSources;
