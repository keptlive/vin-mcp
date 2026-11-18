/* Clean view of the VIN report: values first, explanations one tap away.
 *
 * The report's generators (car-sheet.js, app.js, more-sources.js ...) write every caveat next to its value, which
 * the printed sheet needs and which stays the full record. On screen that buries the values. This layer changes
 * nothing they write. It marks what it finds, adds small "Details" switches, and report-clean.css (screen only)
 * hides the explanatory text until a switch is opened:
 *   - sheet sections and cards: notes, source lines and write-in blanks fold under "Details";
 *   - recall campaigns: one line each (component, campaign number, month); the text opens on tap;
 *   - "Related model names" campaigns: folded under their heading;
 *   - owner complaints: two lines each; tap for the whole text;
 *   - short values sit two or three to a row instead of one.
 * Print is untouched. A MutationObserver re-applies the marks whenever the report is drawn again. */
const ReportClean = (() => {
  const SHEET_EXTRA = '.sheet-note, .sheet-source, .sheet-url, .placard-match, .write-ins';
  const CARD_EXTRA = '.source-note, .dc-note';
  const IN_FORM = '.placard-fix, .decode-fix';          // correction forms keep their own notes
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const squash = s => String(s ?? '').replace(/\s+/g, ' ').trim();

  /** A value that needs the full row: long text, or a long label. Short ones share a row. */
  function isWide(label, value) {
    return squash(value).length > 20 || squash(label).length > 24;
  }

  /** "21V900000 · Nov 2021" from a campaign number and an ISO date; either may be missing. */
  function recallMeta(campaign, reported) {
    const m = /^(\d{4})-(\d{2})/.exec(squash(reported));
    const when = m && MONTHS[Number(m[2]) - 1] ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '';
    return [squash(campaign), when].filter(Boolean).join(' · ');
  }

  /** Hero badges that repeat the Vehicle section (body style, vehicle type) or state the normal case (valid check digit). */
  function badgeIsExtra(label, neutral) {
    const t = squash(label);
    if (/^checksum valid$/i.test(t)) return true;
    return Boolean(neutral) && !/star|recall|open|rating/i.test(t);
  }

  /* ── Browser only below ── */
  function button(label) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'clean-toggle'; b.textContent = label;
    b.dataset.label = label; b.setAttribute('aria-expanded', 'false');
    return b;
  }
  const has = (el, selector) => [...el.querySelectorAll(selector)].some(x => !x.closest(IN_FORM));

  function sheet(root) {
    for (const section of root.querySelectorAll('#sheet-body .sheet-section:not([data-clean])')) {
      section.dataset.clean = '1';
      for (const row of section.querySelectorAll('.sheet-row')) {
        const dd = row.querySelector('dd');
        if (!dd) continue;
        const value = [...dd.childNodes].filter(n => !(n.nodeType === 1 && n.matches('.sheet-source, .sheet-url'))).map(n => n.textContent).join('');
        if (dd.querySelector('a, .sheet-source') || isWide(row.querySelector('dt')?.textContent, value)) row.classList.add('wide');
      }
      // a section with no values keeps its note: the note is all it has to say
      const values = section.querySelector('.sheet-row, .placard-values, .sheet-manual');
      if (!values || !has(section, SHEET_EXTRA)) continue;
      section.dataset.cleanBox = '1';
      section.querySelector('h3')?.append(button('Details'));
    }
    const foot = root.querySelector('#sheet-foot');
    if (foot && foot.children.length && !foot.querySelector(':scope > .clean-toggle')) {
      foot.dataset.cleanBox = '1';
      foot.prepend(button('Sources and limits'));
    }
    for (const badge of root.querySelectorAll('#hero-badges .badge')) {
      badge.classList.toggle('badge-extra', badgeIsExtra(badge.textContent, badge.classList.contains('badge-neutral')));
    }
  }

  function cards(root) {
    for (const card of root.querySelectorAll('.cards-grid > .card')) {
      const body = card.querySelector(':scope > .card-body');
      if (!body) continue;
      const rows = [...body.querySelectorAll(':scope > .data-row')];
      if (rows.length >= 2) body.classList.add('cells');
      for (const row of rows) {
        row.classList.toggle('wide', isWide(row.querySelector('.data-label')?.textContent, row.querySelector('.data-value')?.textContent));
      }
      const title = card.querySelector(':scope > .card-title');
      const wanted = has(body, CARD_EXTRA);
      const existing = title?.querySelector(':scope > .clean-toggle');
      if (wanted && title && !existing && !title.querySelector('.card-title-toggle')) {
        card.dataset.cleanBox = '1';
        title.append(button('Details'));
      } else if (!wanted && existing) {
        existing.remove(); delete card.dataset.cleanBox; card.classList.remove('is-open');
      }
    }
  }

  function recalls(root) {
    const body = root.querySelector('#recalls-body');
    if (!body) return;
    for (const item of body.querySelectorAll('.recall-item:not([data-clean])')) {
      item.dataset.clean = '1';
      const head = item.querySelector(':scope > .recall-component');
      if (head) {                                        // a campaign: one line until opened
        const rows = [...item.querySelectorAll('.recall-details > div')];
        const field = name => {
          const row = rows.find(d => squash(d.querySelector('.recall-detail-label')?.textContent) === name);
          return row ? squash(row.textContent).slice(name.length) : '';
        };
        const meta = recallMeta(field('Campaign:'), field('Reported to NHTSA:'));
        if (meta) { const span = document.createElement('span'); span.className = 'recall-meta'; span.textContent = meta; head.append(span); }
        item.classList.add('clean-fold');
        head.tabIndex = 0; head.setAttribute('role', 'button'); head.setAttribute('aria-expanded', 'false');
        continue;
      }
      const heading = item.querySelector(':scope > h3');  // this VIN's status: the result stays, the explanation folds
      const extra = [...item.querySelectorAll(':scope > p')].slice(1).filter(p => !p.querySelector('a'));
      if (!heading || !extra.length) continue;
      extra.forEach(p => p.classList.add('clean-extra'));
      item.dataset.cleanBox = '1';
      heading.append(button('Details'));
    }
    // campaigns filed under related model names: folded under their own heading
    for (const heading of body.querySelectorAll(':scope > h3:not([data-clean])')) {
      heading.dataset.clean = '1';
      if (!/^Related model names/i.test(squash(heading.textContent))) continue;
      const box = document.createElement('div'), content = document.createElement('div');
      box.className = 'clean-related'; box.dataset.cleanBox = '1'; content.className = 'clean-related-body';
      while (heading.nextSibling) content.append(heading.nextSibling);
      heading.before(box);
      heading.append(button('Show'));
      box.append(heading, content);
    }
  }

  let queued = false;
  function apply() {
    queued = false;
    const root = document.querySelector('#results');
    if (!root) return;
    sheet(root); cards(root); recalls(root);
  }
  function schedule() {
    if (queued) return;
    queued = true;
    (window.requestAnimationFrame || setTimeout)(apply);
  }

  function flip(box, control, open) {
    box.classList.toggle('is-open', open);
    control.setAttribute('aria-expanded', String(open));
    if (control.dataset.label) control.textContent = open ? (control.dataset.label === 'Show' ? 'Hide' : 'Less') : control.dataset.label;
  }

  function init() {
    const root = document.querySelector('#results');
    if (!root) return;
    root.addEventListener('click', event => {
      const toggle = event.target.closest('.clean-toggle');
      if (toggle) {
        const box = toggle.closest('[data-clean-box]');
        if (box) flip(box, toggle, !box.classList.contains('is-open'));
        return;
      }
      const head = event.target.closest('.clean-fold > .recall-component');
      if (head) { flip(head.parentElement, head, !head.parentElement.classList.contains('is-open')); return; }
      const complaint = event.target.closest('.complaint-item');
      if (complaint && !event.target.closest('a, button')) complaint.classList.toggle('is-open');
    });
    root.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const head = event.target.closest?.('.clean-fold > .recall-component');
      if (!head) return;
      event.preventDefault();
      flip(head.parentElement, head, !head.parentElement.classList.contains('is-open'));
    });
    new MutationObserver(schedule).observe(root, { childList: true, subtree: true });
    schedule();
  }

  if (typeof document !== 'undefined') init();
  return { isWide, recallMeta, badgeIsExtra, apply };
})();
if (typeof window !== 'undefined') window.ReportClean = ReportClean;
