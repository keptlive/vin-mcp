/* Decode checks in the web report and the car sheet (report field decode_checks, lib/decode-checks.mjs).
 *
 * Rules kept here (tested in tests/decode-checks.test.mjs):
 * - The official decode (NHTSA vPIC) is never hidden: a corrected or doubtful field always shows vPIC's value too.
 * - corrected: the checked value, marked, with "official decode: ..." and the reason; doubtful: vPIC's value,
 *   marked, with the other value; filled: the value with where it came from. Confirmed and unverified fields are
 *   shown as before (the card lists confirmations).
 * - "Report a decode error" sends a correction for review (POST /api/decode-corrections); it never changes a value.
 */
const DecodeChecks = (() => {
  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const MARKED = ['corrected', 'doubtful', 'filled'];
  const WORD = { corrected: 'Corrected', doubtful: 'Doubtful', filled: 'Filled in', confirmed: 'Confirmed', unverified: 'Not checked', unknown: 'Unknown' };
  const TIER = { owner: 'you', manufacturer_vin_record: 'the manufacturer’s record of this VIN', mcp_vin_rule_fix: 'an mcp.vin rule fix', nhtsa_test_vehicle_pattern: 'NHTSA test vehicles with this VIN pattern', vpic_decode: 'the official decode', assumption: 'EPA’s list for this model year' };

  const fields = r => (r && r.decode_checks && Array.isArray(r.decode_checks.fields) ? r.decode_checks.fields : []);
  const check = (r, field) => fields(r).find(f => f.field === field) || null;

  /** Inline marker for one or more fields of a row: '' when none is corrected, doubtful or filled. */
  function marker(r, ...names) {
    const marked = names.map(n => check(r, n)).filter(c => c && MARKED.includes(c.status));
    return marked.map(c => {
      const other = c.status === 'corrected' ? (c.original !== null && c.original !== '' ? `official decode: ${c.original}` : '')
        : c.status === 'doubtful' ? (c.candidates || []).filter(x => x.tier !== 'vpic_decode').map(x => `${TIER[x.tier] || x.tier}: ${x.value_label}`).join('; ')
        : `from ${TIER[c.basis] || 'another record'}`;
      const value = c.status === 'doubtful' ? '' : `${esc(c.label)}: ${esc(c.shown)} `;
      return ` <span class="dc dc-${esc(c.status)}" title="${esc(c.note || '')}">${esc(WORD[c.status])}</span><span class="dc-detail">${value}${other ? `(${esc(other)})` : ''}</span>`;
    }).join('');
  }

  /** The value to show for a field: the corrected or filled value, else the given fallback (vPIC's). */
  function shown(r, field, fallback) {
    const c = check(r, field);
    return c && (c.status === 'corrected' || c.status === 'filled') && c.shown ? c.shown : fallback;
  }

  /**
   * HTML for a one-field row: corrected/filled = the checked value, marked, with the official value (or "blank");
   * doubtful = the official value, marked, with the other value; otherwise the official text (escaped), or '' when
   * it is empty and nothing was filled.
   */
  function valueHtml(r, field, officialText) {
    const c = check(r, field);
    // The report's values carry mcp.vin's rule fixes: for a field a fix changed, NHTSA's official value is c.original.
    const given = c && byRuleFix(c) ? originalText(c) : officialText;
    const off = given === null || given === undefined ? '' : String(given);
    if (!c || !MARKED.includes(c.status)) return esc(off);
    const tag = `<span class="dc dc-${esc(c.status)}" title="${esc(c.note || '')}">${esc(WORD[c.status])}</span>`;
    if (c.status === 'corrected') return `${esc(c.shown)} ${tag}<span class="dc-detail dc-detail-corrected">official decode: ${esc(off || c.original || 'blank')}</span>`;
    if (c.status === 'filled') return `${esc(c.shown)}<span class="dc-mark" aria-hidden="true">†</span> ${tag}<span class="dc-detail dc-detail-filled">${off || c.original ? `official decode: ${esc(off || c.original)}${c.field === 'powertrain' ? ', electrification blank' : ''}` : 'official decode: blank'}; from ${esc(TIER[c.basis] || 'another record')}</span>`;
    const other = (c.candidates || []).filter(x => x.tier !== 'vpic_decode').map(x => `${TIER[x.tier] || x.tier}: ${x.value_label}`).join('; ');
    return `${esc(off || 'blank')} ${tag}${other ? `<span class="dc-detail dc-detail-doubtful">${esc(other)}</span>` : ''}`;
  }

  /** Did an mcp.vin rule fix (a reviewed correction of NHTSA's vPIC rules) change this field? */
  function byRuleFix(c) { return !!(c && c.evidence && c.evidence.rule_fix); }
  /** NHTSA's official value of a checked field, as text. */
  function originalText(c) {
    if (c.original === null || c.original === undefined || c.original === '') return '';
    return c.field === 'engine_size' && !Number.isNaN(Number(c.original)) ? `${Number(c.original).toFixed(1)} L` : String(c.original);
  }

  /** The checked value of a field for display: corrected or filled value, else null (keep vPIC's). */
  function checkedValue(r, field) {
    const c = check(r, field);
    return c && (c.status === 'corrected' || c.status === 'filled') ? c.shown_value : null;
  }

  /**
   * HTML for a row built from several fields (engine = size + cylinders; transmission = speeds + type).
   * officialText: the row from vPIC's values; checkedText: the same row from the checked values. One tag for the
   * strongest status present (corrected > doubtful > filled); vPIC's row stays visible. null when nothing is marked.
   */
  function combinedHtml(r, names, officialText, checkedText) {
    const cs = names.map(n => check(r, n)).filter(c => c && MARKED.includes(c.status));
    if (!cs.length) return null;
    const top = ['corrected', 'doubtful', 'filled'].find(s => cs.some(c => c.status === s));
    // officialText is built from the report's values, which carry any rule fix: then name NHTSA's values field by field.
    const fixed = names.map(n => check(r, n)).filter(byRuleFix);
    const off = fixed.length ? fixed.map(c => `${c.label.toLowerCase()} ${originalText(c) || 'blank'}`).join(', ') : officialText ? String(officialText) : '';
    const tag = `<span class="dc dc-${top}" title="${esc(cs.map(c => c.note).filter(Boolean).join(' '))}">${esc(WORD[top])}</span>`;
    if (top === 'doubtful') {
      const other = cs.filter(c => c.status === 'doubtful').flatMap(c => (c.candidates || []).filter(x => x.tier !== 'vpic_decode').map(x => `${c.label.toLowerCase()} ${x.value_label} (${TIER[x.tier] || x.tier})`)).join('; ');
      return `${esc(off || 'Blank in the official decode')} ${tag}${other ? `<span class="dc-detail dc-detail-doubtful">${esc(other)}</span>` : ''}`;
    }
    const from = [...new Set(cs.map(c => TIER[c.basis] || 'another record'))].join('; ');
    const detail = top === 'corrected' ? `official decode: ${off || 'blank'}` : `official decode: ${off || 'blank'}; from ${from}`;
    return `${esc(checkedText || off)}${top === 'filled' ? '<span class="dc-mark" aria-hidden="true">†</span>' : ''} ${tag}<span class="dc-detail dc-detail-${top}">${esc(detail)}</span>`;
  }

  /** Card body: a line per checked field, then sources and the report control. */
  function cardHtml(r) {
    const dc = r && r.decode_checks;
    if (!dc || !Array.isArray(dc.fields)) return '<p class="dc-note">The decode checks are not available for this VIN.</p>';
    const rows = dc.fields.filter(f => f.status !== 'unknown').map(f => {
      // NHTSA lab reports behind the field: an mcp.vin rule fix's evidence first, then the test vehicles of the pattern.
      const fixEv = (f.evidence && f.evidence.rule_fix && f.evidence.rule_fix.fixes || []).flatMap(x => x.evidence || []).map(e => ({ report_url: e && e.url, test_no: e && e.test_no }));
      const seen = new Set();
      const tests = [...fixEv, ...(f.evidence && f.evidence.test_vehicles || [])]
        .filter(t => t.report_url && /^https:\/\/(nrd-static\.nhtsa\.dot\.gov|static\.nhtsa\.gov)\//.test(t.report_url) && !seen.has(t.report_url) && seen.add(t.report_url)).slice(0, 3)
        .map(t => `<a href="${esc(t.report_url.replace(/ /g, '%20'))}" target="_blank" rel="noopener">${t.test_no ? 'test ' + esc(t.test_no) : 'report'}</a>`).join(', ');
      const value = f.status === 'corrected' ? `${esc(f.shown)} <span class="dc-was">official decode: ${esc(f.original ?? 'blank')}</span>`
        : f.status === 'filled' ? `${esc(f.shown)} <span class="dc-was">official decode: ${f.original !== null && f.original !== undefined && f.original !== '' ? `${esc(f.original)}${f.field === 'powertrain' ? ', electrification blank' : ''}` : 'blank'}</span>` : esc(f.shown ?? f.original ?? '—');
      return `<li class="dc-item dc-item-${esc(f.status)}"><span class="dc dc-${esc(f.status)}">${esc(WORD[f.status] || f.status)}</span> <strong>${esc(f.label)}</strong>: ${value}`
        + `${f.note ? `<span class="dc-why">${esc(f.note)}${tests ? ` NHTSA ${tests}.` : ''}</span>` : ''}</li>`;
    }).join('');
    const s = dc.sources || {};
    const mfr = s.manufacturer_record || {};
    const mfrText = mfr.status === 'used' ? `the manufacturer’s description of this VIN (“${esc(mfr.text)}”, ${esc(mfr.source || 'recall lookup')})`
      : mfr.status === 'not_checked' ? 'the manufacturer’s record (not yet loaded)' : mfr.status === 'not_supported' ? null : 'the manufacturer’s record (not available for this VIN)';
    const tv = s.test_vehicle_pattern || {};
    const tvText = tv.status === 'used' ? `${esc(tv.vehicles)} NHTSA test vehicle${tv.vehicles === 1 ? '' : 's'} with VIN pattern ${esc(dc.pattern)}` : `NHTSA test vehicles (none with VIN pattern ${esc(dc.pattern || '?')})`;
    const fixText = s.rule_fixes && s.rule_fixes.status === 'used' ? `mcp.vin’s reviewed fixes of NHTSA’s vPIC rules (${esc((s.rule_fixes.ids || []).join(', '))}${s.rule_fixes.release ? `, vPIC release ${esc(s.rule_fixes.release)}` : ''})` : null;
    const used = [mfrText, fixText, tvText, s.epa && s.epa.status === 'used' ? 'EPA’s configurations for this model year' : null].filter(Boolean).join('; ');
    return `<ul class="dc-list">${rows}</ul><p class="dc-note">Checked against ${used}. ${esc(dc.note || '')}</p>${formHtml(r)}`;
  }

  /** "Report a decode error": screen only, for review, never applied. */
  function formHtml(r) {
    const vin = String(r && r.vin || '');
    if (vin.length !== 17) return '';
    const opts = [['drive', 'Drive type'], ['engine_size', 'Engine size'], ['cylinders', 'Cylinders'], ['powertrain', 'Fuel or hybrid/electric'], ['transmission', 'Transmission'], ['speeds', 'Transmission speeds'],
      ['seats', 'Seats'], ['body', 'Body style'], ['trim', 'Trim'], ['model', 'Model or year'], ['other', 'Something else']];
    return `<details class="decode-fix sheet-screen-only"><summary>Report a decode error</summary><form class="decode-fix-form" data-vin="${esc(vin)}" novalidate>`
      + '<p class="dc-note">Tell us what your vehicle really has. We review reports before using them; they are never shown to other readers and never change a value by themselves. Please leave personal details out. <a href="/privacy/#decode-corrections">Privacy</a></p>'
      + `<div class="fix-grid"><label class="fix-field"><span>Which field</span><select name="field">${opts.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></label>`
      + '<label class="fix-field"><span>What your vehicle has</span><input name="value" maxlength="80" autocomplete="off" spellcheck="false" placeholder="e.g. front-wheel drive"></label>'
      + '<label class="fix-field"><span>How you know</span><select name="source"><option value="">(optional)</option><option value="owner">My own vehicle</option><option value="window_sticker">Window sticker or build sheet</option><option value="manufacturer">The manufacturer or a dealer</option><option value="other">Other</option></select></label>'
      + '<label class="fix-field fix-note"><span>Note (optional)</span><textarea name="note" maxlength="500" rows="2"></textarea></label></div>'
      + '<button type="submit" class="secondary">Send report</button><p class="decode-fix-status" role="status" aria-live="polite"></p></form></details>';
  }

  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('submit', async event => {
      const form = event.target;
      if (!form || !form.matches || !form.matches('form.decode-fix-form')) return;
      event.preventDefault();
      const status = form.querySelector('.decode-fix-status'), button = form.querySelector('button[type=submit]');
      const data = Object.fromEntries(new FormData(form));
      data.vin = form.dataset.vin;
      button.disabled = true;
      status.textContent = 'Sending…';
      try {
        const res = await fetch('/api/decode-corrections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        const out = await res.json().catch(() => ({}));
        if (res.ok) {
          status.textContent = out.message || 'Thanks. We review reports before using them.';
          form.querySelectorAll('input, select, textarea').forEach(el => { el.disabled = true; });
          return;
        }
        status.textContent = res.status === 429 ? 'Too many reports from this network. Try again in a minute.' : out.error || 'The report could not be sent. Try again later.';
      } catch {
        status.textContent = 'The report could not be sent. Check the connection and try again.';
      }
      button.disabled = false;
    });
  }

  return { check, marker, shown, valueHtml, checkedValue, combinedHtml, cardHtml, formHtml, fields };
})();
if (typeof window !== 'undefined') window.DecodeChecks = DecodeChecks;
