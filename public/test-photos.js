/* Report photos: the vehicle NHTSA tested (report field `photos`, lib/test-photos.mjs), shown in the car sheet's
 * head. The test car before the test first (main photo + thumbnails), then views from NHTSA's crash tests.
 *
 * Rules: every photo says what it shows and which NHTSA test car it is ("NHTSA's test car: 2017 Honda CR-V AWD LX.
 * Not this vehicle; trim and colour may differ."), crash views say which test, and each links NHTSA's report for
 * that test. Images load only from this site (/nhtsa-photos/), never from NHTSA or a third party. No photos (null,
 * or nothing usable) = no photo area at all: no placeholder. The show_photos preference hides the area as before
 * (app.js applyPreferences sets its display); "no photos" uses the hidden attribute so the two never fight.
 */
const TestPhotos = (() => {
  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const PATH = /^\/nhtsa-photos\/\d{1,6}\/v\d{5}P\d{3,4}-(?:960|320)\.webp$/;
  /** Only this site's photo folder (relative, or absolute on this page's own origin). */
  function okImage(u) {
    const s = String(u || '');
    if (PATH.test(s)) return true;
    try {
      const url = new URL(s);
      const here = typeof location !== 'undefined' ? location.origin : null;
      return (url.origin === here || url.origin === 'https://mcp.vin') && PATH.test(url.pathname) && !url.search && !url.hash;
    } catch { return false; }
  }
  const okNhtsa = u => String(u || '').startsWith('https://nrd-static.nhtsa.dot.gov/');
  const dim = n => Number.isInteger(n) && n > 0 && n <= 4000;

  /** The usable items of a report, in the order given (before the test first). */
  function items(report) {
    const list = report && report.photos && Array.isArray(report.photos.items) ? report.photos.items : [];
    return list.filter(p => p && okImage(p.url) && okImage(p.thumbnail_url) && dim(p.width) && dim(p.height)
      && typeof p.tested_as === 'string' && p.tested_as.trim() && Number.isInteger(p.test_no) && typeof p.label === 'string');
  }

  function matchText(m) {
    if (!m || m.kind === 'exact') return '';
    if (m.kind === 'nearest_model_year') return ` NHTSA tested the ${esc(m.tested_model_year)} model (yours is ${esc(m.vin_model_year)}).`;
    const diffs = (m.differences || []).filter(d => d && d.field !== 'model_year' && d.tested && d.yours).map(d => `${esc(d.field)} ${esc(d.tested)}`);
    return diffs.length ? ` Tested version differs: ${diffs.join('; ')}.` : '';
  }

  /** Caption HTML for one item: what it shows, which test car, the disclaimer and NHTSA's report link. */
  function caption(p) {
    const car = `NHTSA's test car: ${esc(p.tested_as.trim())}.`;
    const how = p.phase !== 'pre_test' && p.test_description ? ` ${esc(p.test_description)}` : '';
    const link = okNhtsa(p.nhtsa_test_url) ? ` <a href="${esc(p.nhtsa_test_url)}" target="_blank" rel="noopener">${esc(p.test_label || `NHTSA test ${p.test_no}`)}</a>.` : '';
    return `<strong>${esc(p.label)}.</strong>${how} ${car}${matchText(p.match)} Not this vehicle; trim, colour and equipment may differ.${link}`;
  }

  function thumbsHtml(list) {
    const thumb = (p, i) => `<button type="button" class="photo-thumb${i === 0 ? ' active' : ''}${p.phase === 'pre_test' ? '' : ' crash'}" data-i="${i}" aria-label="${esc(p.label)}" aria-pressed="${i === 0}">`
      + `<img src="${esc(p.thumbnail_url)}" alt="" width="${esc(p.thumbnail_width || 80)}" height="${esc(p.thumbnail_height || 60)}" loading="lazy" decoding="async"></button>`;
    const pre = list.map((p, i) => [p, i]).filter(([p]) => p.phase === 'pre_test');
    const crash = list.map((p, i) => [p, i]).filter(([p]) => p.phase !== 'pre_test');
    return `<div class="photo-group" role="group" aria-label="Before the test">${pre.map(([p, i]) => thumb(p, i)).join('')}</div>`
      + (crash.length ? `<div class="photo-group crash" role="group" aria-label="Crash tests"><span class="photo-group-label" aria-hidden="true">Crash tests</span>${crash.map(([p, i]) => thumb(p, i)).join('')}</div>` : '');
  }

  function show(box, list, i) {
    const p = list[i];
    const img = box.querySelector('.photo-main');
    img.src = p.url; img.width = p.width; img.height = p.height;
    img.alt = `${p.label}. NHTSA's test car: ${p.tested_as}`;
    box.querySelector('.photo-caption').innerHTML = caption(p);
    for (const b of box.querySelectorAll('.photo-thumb')) {
      const on = Number(b.dataset.i) === i;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }

  function render(report) {
    if (typeof document === 'undefined') return;
    const box = document.getElementById('hero-photos');
    if (!box) return;
    const list = items(report);
    const head = box.closest('.sheet-head');
    if (!list.length || list[0].phase !== 'pre_test') {
      box.hidden = true;
      box.querySelector('.photo-thumbs').innerHTML = '';
      box.querySelector('.photo-caption').innerHTML = '';
      box.querySelector('.photo-main').removeAttribute('src');
      if (head) head.classList.add('no-photos');
      return;
    }
    box.hidden = false;
    if (head) head.classList.remove('no-photos');
    const thumbs = box.querySelector('.photo-thumbs');
    thumbs.innerHTML = list.length > 1 ? thumbsHtml(list) : '';
    show(box, list, 0);
    for (const b of thumbs.querySelectorAll('.photo-thumb')) b.addEventListener('click', () => show(box, list, Number(b.dataset.i)));
  }

  return { render, items, caption };
})();
if (typeof window !== 'undefined') window.TestPhotos = TestPhotos;
