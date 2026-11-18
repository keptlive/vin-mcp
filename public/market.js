/* Price tab: what dealers near a ZIP code ask for cars like this one, what that suggests for a private sale and a
 * trade-in, and the cars for sale behind the numbers, each linked to the dealer's own page.
 *
 * Data: POST /api/market (lib/market.mjs) -> mcp.vin's index of dealer websites. Asking prices, not sale prices.
 * The ZIP code is kept in this browser (localStorage) and sent in the request body, which is not logged.
 * Few words on screen; the method sits in a closed <details>. */
const Market = (() => {
  const ZIP_KEY = 'mcpvin-zip';
  const FIRST = 6;                                   // listings shown before "Show all"
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const usd = n => '$' + Math.round(n).toLocaleString('en-US');
  const num = n => Math.round(n).toLocaleString('en-US');
  /** $26,100 -> "$26.1k", $104,000 -> "$104k": the figure on the tab. */
  const short = n => n >= 100000 ? '$' + Math.round(n / 1000) + 'k' : n >= 1000 ? '$' + (Math.round(n / 100) / 10).toFixed(1).replace(/\.0$/, '') + 'k' : usd(n);
  const date = iso => { const d = new Date(iso + 'T00:00:00Z'); return isNaN(d) ? '' : d.toLocaleDateString('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' }); };
  const safeUrl = u => /^https?:\/\//i.test(String(u || '')) ? String(u) : '';

  let state = { vin: null, key: null, data: null, sort: 'near', all: false, miles: null, loading: false, revision: 0 };
  const milesByVin = new Map();

  const storedZip = () => { try { const z = localStorage.getItem(ZIP_KEY); return /^\d{5}$/.test(z || '') ? z : ''; } catch { return ''; } };
  const storeZip = zip => { try { if (zip) localStorage.setItem(ZIP_KEY, zip); else localStorage.removeItem(ZIP_KEY); } catch { /* private mode */ } };

  /** Where the comparable cars are: "within 150 miles of 10520" / "nationwide". */
  function whereText(d) {
    if (!d.zip || d.radius_miles == null) return 'nationwide';
    return `within ${d.radius_miles} miles of ${d.zip}`;
  }

  /** One short line under the figures: how many cars, where, at what mileage, how fresh. */
  function basisText(d) {
    const parts = [`${num(d.comparables)} ${d.comparables === 1 ? 'car' : 'cars'} for sale ${whereText(d)}`];
    if (d.mode === 'used') parts.push(d.miles != null ? `priced at ${num(d.miles)} miles` : d.typical_miles ? `typical ${num(d.typical_miles)} miles` : '');
    if (d.as_of) parts.push(date(d.as_of));
    return parts.filter(Boolean).join(' · ');
  }

  /** Plain sentences for the service's note codes. Unknown codes say nothing. */
  function noteTexts(d) {
    const out = [];
    for (const code of d.notes || []) {
      if (code === 'zip_unknown') out.push('ZIP code not found: showing national prices.');
      else if (code === 'nearby_years') out.push(`Few ${d.year}s for sale: ${d.year - 1}–${d.year + 1} included.`);
      else if (code === 'thin') out.push(`Only ${d.comparables} comparable ${d.comparables === 1 ? 'car' : 'cars'}: treat as a rough guide.`);
      else if (code === 'no_mileage_adjustment') out.push('Too few cars to adjust for mileage.');
      else if (code === 'similar_models') out.push(`Includes similar model names${d.models_used?.length ? ': ' + d.models_used.slice(0, 4).join(', ') : ''}.`);
    }
    return out;
  }

  /** The exact car, when a dealer lists it: its price against the estimate, only when both are for the same mileage. */
  function thisCarDelta(d) {
    const car = d.this_car;
    if (!car?.price || d.mode !== 'used' || d.miles == null || car.miles == null) return '';
    if (Math.abs(d.miles - car.miles) > Math.max(1500, car.miles * 0.05)) return '';
    const diff = car.price - d.dealer_asking.mid;
    if (Math.abs(diff) < 300) return 'about typical for its mileage';
    return `${usd(Math.round(Math.abs(diff) / 100) * 100)} ${diff < 0 ? 'below' : 'above'} typical for its mileage`;
  }

  function sorted(listings, sort) {
    const by = { near: l => l.distance ?? 1e9, price: l => l.price ?? 1e12, miles: l => l.miles ?? 1e12 }[sort] || (l => 0);
    return [...listings].sort((a, b) => by(a) - by(b) || (a.price ?? 0) - (b.price ?? 0));
  }

  /* ── Chart: asking price against mileage. One series (cars for sale); the estimate and this car are labelled marks. ── */
  function niceTicks(lo, hi, count) {
    const span = hi - lo || 1, raw = span / count, mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || raw;
    const ticks = [];
    for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) ticks.push(Math.round(t));
    return ticks;
  }
  function chartSvg(d, width) {
    const pts = (d.points || []).filter(p => p[0] != null && p[1] != null);
    if (d.mode !== 'used' || pts.length < 8) return '';
    const W = Math.round(Math.min(900, Math.max(280, width || 640))), H = W < 480 ? 230 : 260, L = 44, R = 12, T = 16, B = 34;
    const car = d.this_car?.price && d.this_car.miles != null ? d.this_car : null;
    const xs = pts.map(p => p[0]).concat(d.miles ?? [], car ? car.miles : []);
    const ys = pts.map(p => p[1]).concat(d.dealer_asking.low, d.dealer_asking.high, car ? car.price : []);
    const x0 = 0, x1 = Math.max(...xs) * 1.04 || 1;
    const pad = (Math.max(...ys) - Math.min(...ys)) * 0.08 || 1000;
    const y0 = Math.max(0, Math.min(...ys) - pad), y1 = Math.max(...ys) + pad;
    const X = v => L + (v - x0) / (x1 - x0) * (W - L - R), Y = v => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
    const kMiles = v => v === 0 ? '0' : Math.round(v / 1000) + 'k';
    const kUsd = v => '$' + (v >= 10000 ? Math.round(v / 1000) : Math.round(v / 100) / 10) + 'k';
    const grid = niceTicks(y0, y1, 3).map(t => `<line class="mk-grid" x1="${L}" x2="${W - R}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}"/><text class="mk-tick" x="${L - 8}" y="${(Y(t) + 4).toFixed(1)}" text-anchor="end">${kUsd(t)}</text>`).join('');
    const xt = niceTicks(x0, x1, W < 480 ? 3 : 5).map(t => `<text class="mk-tick" x="${X(t).toFixed(1)}" y="${H - B + 18}" text-anchor="middle">${kMiles(t)}</text>`).join('');
    // With a mileage the range belongs to that mileage (a bar there); without one it is where most cars are priced (a band).
    const bandTop = Y(d.dealer_asking.high), bandH = Math.max(2, Y(d.dealer_asking.low) - Y(d.dealer_asking.high));
    const band = d.miles != null
      ? `<rect class="mk-band mk-band-at" x="${(X(d.miles) - 8).toFixed(1)}" width="16" rx="4" y="${bandTop.toFixed(1)}" height="${bandH.toFixed(1)}"/>`
      : `<rect class="mk-band" x="${L}" width="${W - L - R}" y="${bandTop.toFixed(1)}" height="${bandH.toFixed(1)}"/>`;
    const dots = pts.map(p => `<circle class="mk-dot" cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="4.5" data-tip="${esc(usd(p[1]) + ' · ' + num(p[0]) + ' mi')}"/>`).join('');
    const label = (x, y, text, cls) => { const end = x > W - 90; return `<text class="mk-label ${cls}" x="${(x + (end ? -10 : 10)).toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="${end ? 'end' : 'start'}">${esc(text)}</text>`; };
    let marks = '';
    if (d.miles != null) {
      const ex = X(d.miles), ey = Y(d.dealer_asking.mid);
      marks += `<line class="mk-guide" x1="${ex.toFixed(1)}" x2="${ex.toFixed(1)}" y1="${T}" y2="${H - B}"/><path class="mk-estimate" d="M${ex.toFixed(1)} ${(ey - 7).toFixed(1)}l7 7-7 7-7-7z" data-tip="${esc('Typical: ' + usd(d.dealer_asking.mid) + ' at ' + num(d.miles) + ' mi')}"/>`;
      if (!car || Math.abs(X(car.miles) - ex) > 70 || Math.abs(Y(car.price) - ey) > 16) marks += label(ex, ey, 'Typical', 'mk-label-estimate');
    }
    if (car) marks += `<circle class="mk-car" cx="${X(car.miles).toFixed(1)}" cy="${Y(car.price).toFixed(1)}" r="6" data-tip="${esc('This car: ' + usd(car.price) + ' · ' + num(car.miles) + ' mi')}"/>` + label(X(car.miles), Y(car.price), 'This car', 'mk-label-car');
    return `<figure class="market-chart"><figcaption>Asking price by mileage <span>${d.miles != null ? 'bar: typical range at this mileage' : 'shaded: where most are priced'}</span></figcaption>
      <div class="market-chart-box"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Asking price against mileage for ${pts.length} cars for sale. Most ask between ${usd(d.dealer_asking.low)} and ${usd(d.dealer_asking.high)}.">
      ${grid}<line class="mk-axis" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>${xt}<text class="mk-tick" x="${W - R}" y="${H - 2}" text-anchor="end">miles</text>${band}${dots}${marks}</svg><div class="market-tip" hidden></div></div></figure>`;
  }

  /* ── HTML pieces ── */
  function tilesHtml(d) {
    if (d.mode === 'new') {
      return `<div class="market-tiles market-tiles-one"><div class="market-tile market-tile-main"><span>New, dealer asking</span><b>${usd(d.dealer_asking.mid)}</b><small>${usd(d.dealer_asking.low)} – ${usd(d.dealer_asking.high)}</small></div></div>`;
    }
    return `<div class="market-tiles">
      <div class="market-tile"><span>Trade-in</span><b>${usd(d.trade_in.mid)}</b><small>${usd(d.trade_in.low)} – ${usd(d.trade_in.high)}</small></div>
      <div class="market-tile"><span>Private sale</span><b>${usd(d.private_party)}</b><small>estimate</small></div>
      <div class="market-tile market-tile-main"><span>Dealer price</span><b>${usd(d.dealer_asking.mid)}</b><small>${usd(d.dealer_asking.low)} – ${usd(d.dealer_asking.high)}</small></div>
    </div>`;
  }

  function formHtml(zip, miles, mode) {
    return `<form class="market-form" novalidate>
      <label>ZIP code<input name="zip" inputmode="numeric" autocomplete="postal-code" maxlength="5" placeholder="All US" value="${esc(zip)}"></label>
      ${mode === 'new' ? '' : `<label>Mileage<input name="miles" inputmode="numeric" maxlength="7" placeholder="Typical" value="${miles != null ? esc(num(miles)) : ''}"></label>`}
      <button type="submit">Update</button>
      <p class="market-form-error" role="alert" hidden></p>
    </form>`;
  }

  function thisCarHtml(d) {
    const car = d.this_car, url = safeUrl(car?.url);
    if (!car || !url) return '';
    const delta = thisCarDelta(d);
    const place = [car.dealer, [car.city, car.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
    return `<a class="market-thiscar" href="${esc(url)}" target="_blank" rel="noopener nofollow">
      <span class="market-thiscar-tag">This car is for sale</span>
      <span class="market-thiscar-main"><b>${car.price ? usd(car.price) : 'Price on request'}</b>${delta ? `<em>${esc(delta)}</em>` : ''}</span>
      <span class="market-thiscar-where">${esc(place)}${car.distance != null ? ` · ${num(car.distance)} mi away` : ''}</span>
      <span class="market-go" aria-hidden="true">View listing →</span></a>`;
  }

  function listingHtml(l, vin) {
    const url = safeUrl(l.url);
    if (!url) return '';
    const what = [l.year, l.trim].filter(Boolean).join(' ') + (l.condition === 'certified' ? ' · Certified' : '');
    const where = [l.dealer, [l.city, l.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
    const own = l.vin && l.vin === vin;
    return `<li class="market-item${own ? ' market-item-own' : ''}">
      <a class="market-item-link" href="${esc(url)}" target="_blank" rel="noopener nofollow">
        <span class="market-item-price">${usd(l.price)}</span>
        <span class="market-item-miles">${l.miles != null ? num(l.miles) + ' mi' : ''}</span>
        <span class="market-item-what">${esc(what)}${own ? ' · <strong>this car</strong>' : ''}${l.color ? ` · ${esc(l.color)}` : ''}</span>
        <span class="market-item-dist">${l.distance != null ? num(l.distance) + ' mi away' : ''}</span>
        <span class="market-item-where">${esc(where || new URL(url).hostname.replace(/^www\./, ''))}</span>
      </a>${l.vin && !own ? `<a class="market-item-report" href="/${esc(l.vin)}" aria-label="VIN report for this ${esc(what)}">Report</a>` : ''}</li>`;
  }

  function listingsHtml(d, st) {
    const all = sorted(d.listings || [], st.sort);
    if (!all.length) return '';
    const shown = st.all ? all : all.slice(0, FIRST);
    const chip = (id, label) => `<button type="button" class="market-chip" data-sort="${id}" aria-pressed="${st.sort === id}">${label}</button>`;
    const more = d.comparables > all.length ? ` of ${num(d.comparables)}` : '';
    return `<div class="market-list-head"><h3>Cars for sale</h3>
        <div class="market-sort" role="group" aria-label="Sort cars">${d.zip ? chip('near', 'Nearest') : ''}${chip('price', 'Lowest price')}${chip('miles', 'Fewest miles')}</div></div>
      <ul class="market-list">${shown.map(l => listingHtml(l, d.this_car?.vin)).join('')}</ul>
      ${all.length > FIRST && !st.all ? `<button type="button" class="secondary market-more">Show all ${all.length}${more}</button>` : ''}
      <p class="market-foot">Links open the dealer’s own page. Prices and availability can change there first.</p>`;
  }

  function methodHtml(d) {
    return `<details class="market-method"><summary>How these numbers are worked out</summary>
      <p><strong>Dealer price</strong> is the middle asking price of comparable cars on dealer websites; the range holds the middle half. ${d.per_10k_miles_pct != null ? `Among these cars, each 10,000 miles changes the price by about ${Math.abs(d.per_10k_miles_pct)}%.` : ''}</p>
      ${d.mode === 'used' ? `<p><strong>Private sale</strong> (91% of dealer price) and <strong>trade-in</strong> (82%, range 75–85%) are rules of thumb applied to that price, not offers and not measured sales.</p>` : ''}
      <p>These are asking prices, not sale prices. Comparable cars: same model year, make and model${d.trim ? `, ${esc(d.trim)} trim` : ''}; the search starts within 50 miles and widens until it finds 20.</p>
      <p>Coverage is partial: about 1.5 million cars from some 9,600 US dealer websites, thinner for some brands and regions. Condition, options and history are not considered.</p></details>`;
  }

  function panelHtml(d, st, zip) {
    if (st.loading && !d) return `<div class="market-skeleton" aria-busy="true"><span></span><span></span><span></span></div><p class="market-basis">Finding cars like this one…</p>`;
    if (!d || d.ok === false) {
      const none = d?.reason === 'no_comparables';
      return `${thisCarHtml(d || {})}<div class="market-empty"><h3>${none ? 'No comparable cars for sale' : 'Prices are unavailable right now'}</h3>
        <p>${none ? 'Our index of dealer websites has no cars like this one at the moment.' : 'The price service did not answer. The rest of the report is unaffected.'}</p>
        ${none ? '' : '<button type="button" class="secondary market-retry">Try again</button>'}</div>`;
    }
    const notes = noteTexts(d);
    return `<div class="market-head"><div><p class="eyebrow">MARKET PRICE</p><h2 class="market-title">${esc([d.year, st.title].filter(Boolean).join(' '))}</h2></div>${formHtml(zip, st.miles, d.mode)}</div>
      ${tilesHtml(d)}
      <p class="market-basis">${esc(basisText(d))}${st.loading ? ' · updating…' : ''}${!d.zip && !(d.notes || []).includes('zip_unknown') ? ' · <strong>Add a ZIP code for local prices.</strong>' : ''}</p>
      ${notes.length ? `<p class="market-notes">${notes.map(esc).join(' ')}</p>` : ''}
      ${thisCarHtml(d)}
      ${chartSvg(d, st.width)}
      ${listingsHtml(d, st)}
      ${methodHtml(d)}`;
  }

  /* ── Page wiring ── */
  function draw() {
    const panel = document.querySelector('#market-panel');
    if (!panel) return;
    state.width = (document.querySelector('#results')?.clientWidth || 640) - (window.innerWidth <= 560 ? 22 : 34);   // chart box inner width
    panel.innerHTML = panelHtml(state.data, state, storedZip());
    const figure = document.querySelector('#tab-price-figure');
    if (figure) {
      const ok = state.data?.ok && state.data.dealer_asking;
      figure.textContent = ok ? short(state.data.dealer_asking.mid) : '';
      figure.hidden = !ok;
    }
  }

  async function load() {
    const report = state.report;
    if (!report?.vehicle) return;
    const v = report.vehicle, zip = storedZip(), revision = ++state.revision;
    state.loading = true;
    draw();
    let data;
    try {
      const res = await fetch('/api/market', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vin: report.vin, year: v.year, make: v.make, model: v.model, trim: v.trim || '', zip, miles: state.miles ?? '' }),
      });
      data = res.ok ? await res.json() : { ok: false, reason: 'unavailable' };
    } catch { data = { ok: false, reason: 'unavailable' }; }
    if (revision !== state.revision) return;
    // The dealer's listing gives this car's mileage: price it there unless the reader entered their own.
    const listed = data?.this_car?.miles;
    if (data?.ok && data.mode === 'used' && state.miles == null && listed != null && listed > 0 && !state.listedTried) {
      state.listedTried = true; state.miles = listed; state.data = data;
      return load();
    }
    state.data = data; state.loading = false;
    draw();
  }

  function render(report) {
    if (typeof document === 'undefined' || !document.querySelector('#market-panel')) return;
    const v = report?.vehicle;
    if (!v?.year || !v.make || !v.model) { state = { ...state, vin: report?.vin, report: null, data: { ok: false, reason: 'no_comparables' }, loading: false }; draw(); return; }
    if (state.vin === report.vin && state.data) { state.report = report; return; }      // the same report drawn again
    state = { vin: report.vin, report, data: null, sort: storedZip() ? 'near' : 'price', all: false,
      miles: milesByVin.get(report.vin) ?? null, listedTried: milesByVin.has(report.vin), loading: false, revision: state.revision,
      title: [String(v.make).replace(/\b([A-Z])([A-Z]+)\b/g, (m, a, b) => m.length > 3 ? a + b.toLowerCase() : m), v.model].join(' ') };
    load();
  }

  function init() {
    const panel = document.querySelector('#market-panel');
    if (!panel) return;
    panel.addEventListener('submit', event => {
      if (!event.target.matches('.market-form')) return;
      event.preventDefault();
      const form = event.target, error = form.querySelector('.market-form-error');
      const zip = form.elements.zip.value.trim();
      const milesText = form.elements.miles ? form.elements.miles.value.replace(/[,\s]/g, '') : '';
      const fail = text => { error.textContent = text; error.hidden = false; };
      if (zip && !/^\d{5}$/.test(zip)) return fail('Enter a 5-digit ZIP code, or leave it empty for all of the US.');
      if (milesText && !(/^\d{1,6}$/.test(milesText) && Number(milesText) <= 500000)) return fail('Enter the mileage as a number, or leave it empty.');
      storeZip(zip);
      state.miles = milesText ? Number(milesText) : null;
      state.listedTried = true;                       // the reader has chosen: do not swap in the listing's mileage
      if (state.vin) milesByVin.set(state.vin, state.miles);
      state.sort = zip ? 'near' : (state.sort === 'near' ? 'price' : state.sort);
      state.all = false;
      load();
    });
    panel.addEventListener('click', event => {
      const chip = event.target.closest('[data-sort]');
      if (chip) { state.sort = chip.dataset.sort; draw(); panel.querySelector(`[data-sort="${state.sort}"]`)?.focus(); return; }
      if (event.target.closest('.market-more')) { state.all = true; draw(); return; }
      if (event.target.closest('.market-retry')) load();
    });
    // Chart tooltips: one small label that follows the hovered, focused or tapped mark.
    const tip = event => {
      const mark = event.target.closest?.('[data-tip]'), box = panel.querySelector('.market-chart-box'), el = panel.querySelector('.market-tip');
      if (!box || !el) return;
      if (!mark || event.type === 'pointerleave') { el.hidden = true; return; }
      const b = box.getBoundingClientRect(), m = mark.getBoundingClientRect();
      el.textContent = mark.dataset.tip; el.hidden = false;
      const left = Math.min(Math.max(m.left + m.width / 2 - b.left, 70), b.width - 70);
      el.style.left = left + 'px'; el.style.top = (m.top - b.top - 8) + 'px';
    };
    let resizeTimer; addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.data?.ok && !panel.querySelector('input:focus')) draw(); }, 200); });
    panel.addEventListener('pointerover', tip);
    panel.addEventListener('pointerdown', tip);
    panel.addEventListener('pointerleave', tip, true);
  }

  if (typeof document !== 'undefined') init();
  return { render, short, whereText, basisText, noteTexts, thisCarDelta, sorted, niceTicks, chartSvg, tilesHtml, listingHtml, listingsHtml, panelHtml };
})();
if (typeof window !== 'undefined') window.Market = Market;
