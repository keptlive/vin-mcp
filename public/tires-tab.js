/* Tires tab: the quick view above the car sheet's own "Tires and wheels" section.
 * The tab shows that section alone (market.css), so its wording, write-in blanks and correction form are the same
 * ones as on the sheet. This file adds only the figures up top: tire size and cold pressures of the closest vehicle
 * NHTSA tested (report field tire_placard), with how it matches this VIN. The owner's door placard governs. */
const TiresTab = (() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const same = v => JSON.stringify([v.tires, v.cold_pressure_psi, v.cold_pressure_kpa]);
  const kpa = n => Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);

  /** One short sentence on how the tested vehicle matches this VIN; the full wording is in the section below. */
  function basisText(group) {
    const m = group[0].match || {};
    if (!m.kind || m.kind === 'exact') return 'From the vehicle NHTSA tested for this model year.';
    if (m.kind === 'different_variant') return 'From a different version NHTSA tested for this model year.';
    const years = [...new Set(group.map(x => x.match && x.match.tested_model_year).filter(Boolean))].sort();
    return `From NHTSA’s ${years.join(' and ')} test vehicle${years.length > 1 ? 's' : ''}; yours is ${m.vin_model_year}.`;
  }

  /** The figures block, or '' when NHTSA's test vehicles give no values for this VIN. `tested` = CarSheet.testedPlacards(). */
  function quickHtml(tested) {
    if (!tested || !tested.length) return '';
    const v = tested[0], group = tested.filter(x => same(x) === same(v));
    const others = new Set(tested.map(same)).size - 1;
    const exact = group.every(x => !x.match || x.match.kind === 'exact');
    const size = v.tires.front === v.tires.rear
      ? `<b>${esc(v.tires.front)}</b><small>front and rear</small>`
      : `<b class="tires-two">${esc(v.tires.front)}</b><small>front</small><b class="tires-two">${esc(v.tires.rear)}</b><small>rear</small>`;
    const psi = (label, side) => `<div class="market-tile"><span>${label}, cold</span><b>${esc(v.cold_pressure_psi[side])} psi</b><small>${esc(kpa(v.cold_pressure_kpa[side]))} kPa</small></div>`;
    return `<div class="market-tiles tires-tiles"><div class="market-tile market-tile-main"><span>Tire size</span>${size}</div>${psi('Front', 'front')}${psi('Rear', 'rear')}</div>
      <p class="tires-basis${exact ? '' : ' tires-basis-near'}"><strong>${esc(basisText(group))}</strong> Your door placard governs.${others > 0 ? ` ${others} other tested version${others > 1 ? 's list' : ' lists'} different values below.` : ''}</p>`;
  }

  function render(report) {
    const box = typeof document !== 'undefined' && document.querySelector('#tires-quick');
    if (!box) return;
    const sheet = typeof window !== 'undefined' && window.CarSheet;
    const html = sheet ? quickHtml(sheet.testedPlacards(report?.tire_placard)) : '';
    box.innerHTML = `${html || '<p class="tires-basis">No tire values from an NHTSA test vehicle for this car. The sizes and pressures are on the placard on the driver’s door pillar.</p>'}`;
  }

  return { basisText, quickHtml, render };
})();
if (typeof window !== 'undefined') window.TiresTab = TiresTab;
