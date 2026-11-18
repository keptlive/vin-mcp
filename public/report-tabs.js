/* Tabs over the VIN report: Overview (the car sheet), Price, Tires, Safety, Specs, All.
 * One attribute does the work: #results[data-tab]. The style sheet (market.css) shows the matching view on screen;
 * print ignores the tabs and prints the full report as before. The choice is kept in the address as ?tab=price,
 * because the #hash already names the workspace view. */
const ReportTabs = (() => {
  const TABS = ['sheet', 'price', 'tires', 'safety', 'specs', 'all'];
  const listeners = [];
  let current = 'sheet';

  /** The tab named by an address query string, or 'sheet'. */
  function fromSearch(search) {
    const tab = new URLSearchParams(search || '').get('tab');
    return TABS.includes(tab) ? tab : 'sheet';
  }

  /** The query string that names a tab: Overview is the default and carries no parameter. */
  function toSearch(search, tab) {
    const params = new URLSearchParams(search || '');
    if (tab === 'sheet') params.delete('tab'); else params.set('tab', tab);
    const text = params.toString();
    return text ? '?' + text : '';
  }

  /** Short figure for the Safety tab: open recalls on this VIN, only when the maker reported a count above zero. */
  function safetyFigure(report) {
    const status = report?.recall_status;
    const open = Number(status?.open_count);
    return status?.available && Number.isFinite(open) && open > 0 ? `${open} open` : '';
  }

  function select(tab, { scroll = false, keepUrl = false, focus = false } = {}) {
    if (!TABS.includes(tab)) return;
    current = tab;
    const results = document.querySelector('#results');
    if (!results) return;
    results.dataset.tab = tab;
    for (const button of document.querySelectorAll('[data-report-tab]')) {
      const on = button.dataset.reportTab === tab;
      button.setAttribute('aria-selected', String(on));
      button.tabIndex = on ? 0 : -1;
      if (on && focus) button.focus({ preventScroll: true });
      if (on) button.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
    if (!keepUrl && /^\/[A-HJ-NPR-Z0-9]{17}$/i.test(location.pathname)) {
      history.replaceState(null, '', location.pathname + toSearch(location.search, tab) + location.hash);
    }
    const nav = document.querySelector('#report-nav');
    if (nav && (scroll || nav.getBoundingClientRect().top <= 0)) {
      nav.scrollIntoView({ behavior: 'auto', block: 'start' });
    }
    for (const fn of listeners) fn(tab);
  }

  function reportUpdated(report) {
    const v = report?.vehicle || {};
    const title = document.querySelector('#report-nav-title');
    if (title) title.textContent = document.querySelector('#vehicle-title')?.textContent || [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ');
    const figure = document.querySelector('#tab-safety-figure');
    if (figure) { const text = safetyFigure(report); figure.textContent = text; figure.hidden = !text; }
    select(fromSearch(location.search), { keepUrl: true });
  }

  function init() {
    const tablist = document.querySelector('.report-tabs');
    if (!tablist) return;
    tablist.addEventListener('click', event => {
      const button = event.target.closest('[data-report-tab]');
      if (button) select(button.dataset.reportTab);
    });
    tablist.addEventListener('keydown', event => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      const to = step ? TABS[(TABS.indexOf(current) + step + TABS.length) % TABS.length]
        : event.key === 'Home' ? TABS[0] : event.key === 'End' ? TABS[TABS.length - 1] : null;
      if (!to) return;
      event.preventDefault();
      select(to, { focus: true });
    });
  }

  if (typeof document !== 'undefined') init();
  return { TABS, fromSearch, toSearch, safetyFigure, select, reportUpdated, onChange: fn => listeners.push(fn), current: () => current };
})();
if (typeof window !== 'undefined') window.ReportTabs = ReportTabs;
