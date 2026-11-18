/* Redraw part of a page in place without losing what the reader is doing there: typed text, choices, disabled
 * (already sent) forms and their status lines, open <details>, focus and caret, and the place on screen.
 *
 * Used when the manufacturer's VIN recall status arrives after the report is drawn (public/app.js, car-sheet.js):
 * only the blocks whose data changed are redrawn, through these helpers.
 * - Form controls are matched by kind (tag, type, name) and their order within the redrawn element.
 * - The place on screen: an element at the top of the viewport that is not redrawn keeps its position; browsers
 *   with scroll anchoring already do this, and then the correction measured here is zero.
 */
const KeepState = (() => {
  const CONTROLS = 'input,select,textarea,button';
  const FOCUSABLE = 'input,select,textarea,button,a[href],summary,[tabindex]';
  const kindOf = el => `${el.tagName}|${el.type || ''}|${el.name || ''}`;

  /** What the reader has done inside `root`. */
  function snapshot(root) {
    if (!root || !root.querySelectorAll) return null;
    const controls = [...root.querySelectorAll(CONTROLS)].map(el => ({kind: kindOf(el), value: el.value, checked: el.checked, disabled: el.disabled}));
    const details = [...root.querySelectorAll('details')].map(d => d.open);
    const statuses = [...root.querySelectorAll('[role=status]')].map(s => s.textContent);
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    let focus = null;
    if (active && active !== root && root.contains(active)) {
      const list = [...root.querySelectorAll(FOCUSABLE)];
      let start = null, end = null;
      try { start = active.selectionStart; end = active.selectionEnd; } catch { /* not a text control */ }
      focus = {index: list.indexOf(active), kind: kindOf(active), start, end};
    }
    return {controls, details, statuses, focus};
  }

  /** Put a snapshot back onto the redrawn `root`. */
  function restore(root, snap) {
    if (!root || !snap) return;
    const seen = new Map(), byKind = new Map();
    for (const c of snap.controls) byKind.set(c.kind, [...(byKind.get(c.kind) || []), c]);
    for (const el of root.querySelectorAll(CONTROLS)) {
      const kind = kindOf(el), n = seen.get(kind) || 0, old = (byKind.get(kind) || [])[n];
      seen.set(kind, n + 1);
      if (!old) continue;
      if (el.tagName !== 'BUTTON') {
        if (el.type === 'checkbox' || el.type === 'radio') el.checked = old.checked;
        else if (el.value !== old.value && (el.tagName !== 'SELECT' || [...el.options].some(o => o.value === old.value))) el.value = old.value;
      }
      el.disabled = old.disabled;
    }
    [...root.querySelectorAll('details')].forEach((d, i) => { if (i < snap.details.length) d.open = snap.details[i]; });
    [...root.querySelectorAll('[role=status]')].forEach((s, i) => { if (i < snap.statuses.length && snap.statuses[i]) s.textContent = snap.statuses[i]; });
    if (snap.focus && snap.focus.index >= 0) {
      const el = [...root.querySelectorAll(FOCUSABLE)][snap.focus.index];
      if (el && kindOf(el) === snap.focus.kind && typeof el.focus === 'function') {
        el.focus({preventScroll: true});
        if (snap.focus.start !== null && typeof el.setSelectionRange === 'function') { try { el.setSelectionRange(snap.focus.start, snap.focus.end); } catch { /* not a text control */ } }
      }
    }
  }

  /** The element at the top of the viewport that lies outside every element in `roots`, with its position. */
  function anchor(roots) {
    if (typeof document === 'undefined' || typeof innerWidth === 'undefined' || !document.elementFromPoint) return null;
    for (const y of [8, 48, 120, Math.round(innerHeight / 2)]) {
      let el = document.elementFromPoint(Math.round(innerWidth / 2), y);
      // inside a redrawn element: anchor on that element itself, which stays in the page
      const host = el && roots.find(r => r && r.contains(el));
      if (host) el = host;
      if (el && el !== document.body && el !== document.documentElement) return {el, top: el.getBoundingClientRect().top};
    }
    return null;
  }

  /**
   * Run `redraw`, which replaces the contents of the `roots` elements, keeping their form state and focus, and the
   * place on screen. `moving`: more elements `redraw` changes that keep their own state (e.g. the car sheet, whose
   * sections are swapped with replace()); they only count for the place on screen.
   */
  function around(roots, redraw, moving = []) {
    roots = roots.filter(Boolean);
    const snaps = roots.map(snapshot), mark = anchor([...roots, ...moving.filter(Boolean)]);
    redraw();
    roots.forEach((root, i) => restore(root, snaps[i]));
    if (mark && mark.el.isConnected) {
      const delta = mark.el.getBoundingClientRect().top - mark.top;
      if (Math.abs(delta) >= 1) scrollBy({top: delta, behavior: 'instant'}); // html has scroll-behavior: smooth
    }
  }

  /** Replace `oldEl` with the element `html` describes, keeping what the reader did in it. Returns the new element. */
  function replace(oldEl, html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    const next = t.content.firstElementChild;
    if (!next || t.content.childElementCount !== 1) return null;
    const snap = snapshot(oldEl);
    oldEl.replaceWith(next);
    restore(next, snap);
    return next;
  }

  return {snapshot, restore, anchor, around, replace};
})();
if (typeof window !== 'undefined') window.KeepState = KeepState;
