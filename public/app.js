/* ── VIN Decoder Frontend ── */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// ── Elements ──
const hero = $('#hero');
const form = $('#vin-form');
const input = $('#vin-input');
const btn = $('#decode-btn');
const inputError = $('#input-error');
const results = $('#results');

// ── State ──
let currentReport = null;

// ── VIN Validation (client-side quick check) ──
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;
const TRANSLITERATION = {A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,J:1,K:2,L:3,M:4,N:5,P:7,R:9,S:2,T:3,U:4,V:5,W:6,X:7,Y:8,Z:9};
const WEIGHTS = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];

function quickValidate(vin) {
  vin = vin.toUpperCase().trim();
  if (vin.length !== 17) return { valid: false, error: `VIN must be 17 characters (got ${vin.length})` };
  if (!VIN_RE.test(vin)) return { valid: false, error: 'VIN contains invalid characters (I, O, Q not allowed)' };

  // Checksum
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ch = vin[i];
    const val = /\d/.test(ch) ? parseInt(ch) : TRANSLITERATION[ch];
    if (val === undefined) return { valid: false, error: `Invalid character: ${ch}` };
    sum += val * WEIGHTS[i];
  }
  const remainder = sum % 11;
  const expected = remainder === 10 ? 'X' : String(remainder);
  if (vin[8] !== expected) return { valid: false, error: `Checksum invalid (expected ${expected}, got ${vin[8]})` };

  return { valid: true };
}

// ── Form Submit ──
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const vin = input.value.trim().toUpperCase();

  // Client-side validation
  const check = quickValidate(vin);
  if (!check.valid) {
    showInputError(check.error);
    input.classList.add('invalid');
    return;
  }

  input.classList.remove('invalid');
  hideInputError();
  setBtnLoading(true);

  try {
    const res = await fetch(`/api/vin/${encodeURIComponent(vin)}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Server error' }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const report = await res.json();
    currentReport = report;

    if (!report.valid) {
      showInputError('Invalid VIN — validation failed');
      return;
    }

    if (!report.vehicle) {
      showInputError(report.error || 'Could not decode VIN');
      return;
    }

    // Save to history
    saveToHistory(vin, report);

    // Render results
    renderResults(report);

    // Compact hero
    hero.classList.add('compact');
    results.hidden = false;
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });

  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setBtnLoading(false);
  }
});

// ── Example VIN link ──
$$('[data-vin]').forEach(el => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    input.value = el.dataset.vin;
    form.dispatchEvent(new Event('submit'));
  });
});

// ── Render Results ──
function renderResults(report) {
  renderHero(report);
  renderOverview(report);
  renderEngine(report);
  renderSafetyRatings(report);
  renderFuel(report);
  renderRecalls(report);
  renderComplaints(report);
  renderSafetyEquipment(report);
  renderPlant(report);
  renderRaw(report);
}

// ── Hero ──
function renderHero(r) {
  const v = r.vehicle;
  const title = [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ');
  $('#vehicle-title').textContent = title;

  // VIN segments
  const vin = r.vin;
  $('#vin-display').innerHTML = `
    <span class="vin-seg vin-wmi" title="WMI: ${esc(r.validation?.wmi?.manufacturer || 'Unknown')}">${vin.slice(0,3)}</span>
    <span class="vin-seg vin-vds" title="VDS: Vehicle attributes">${vin.slice(3,8)}</span>
    <span class="vin-seg vin-check" title="Check digit">${vin[8]}</span>
    <span class="vin-seg vin-year" title="Model year: ${v.year || '?'}">${vin[9]}</span>
    <span class="vin-seg vin-plant" title="Assembly plant">${vin[10]}</span>
    <span class="vin-seg vin-seq" title="Sequential number">${vin.slice(11)}</span>
  `;

  // Badges
  const badges = [];
  badges.push(`<span class="badge badge-green">Checksum Valid</span>`);
  if (v.body_class) badges.push(`<span class="badge badge-neutral">${esc(v.body_class)}</span>`);
  if (v.vehicle_type) badges.push(`<span class="badge badge-neutral">${esc(v.vehicle_type)}</span>`);

  const recallCount = r.recalls?.count || 0;
  if (recallCount > 0) {
    badges.push(`<span class="badge badge-red">${recallCount} Recall${recallCount > 1 ? 's' : ''}</span>`);
  } else {
    badges.push(`<span class="badge badge-green">No Recalls</span>`);
  }

  if (r.safety_ratings?.rated) {
    const stars = r.safety_ratings.overall;
    if (stars) badges.push(`<span class="badge badge-neutral">${stars}/5 Stars</span>`);
  }

  $('#hero-badges').innerHTML = badges.join('');

  // Photos
  const photos = r.photos;
  const mainImg = $('#photo-main');
  const thumbsEl = $('#photo-thumbs');

  if (photos) {
    const urls = typeof photos === 'object' && !Array.isArray(photos)
      ? Object.values(photos)
      : Array.isArray(photos) ? photos : [photos];

    if (urls.length > 0) {
      mainImg.src = urls[0];
      mainImg.alt = title;
      thumbsEl.innerHTML = urls.map((url, i) =>
        `<img src="${esc(url)}" alt="View ${i+1}" class="${i === 0 ? 'active' : ''}" data-url="${esc(url)}">`
      ).join('');

      $$('img', thumbsEl).forEach(img => {
        img.addEventListener('click', () => {
          mainImg.src = img.dataset.url;
          $$('img', thumbsEl).forEach(t => t.classList.remove('active'));
          img.classList.add('active');
        });
      });
    } else {
      mainImg.style.display = 'none';
      thumbsEl.innerHTML = '';
    }
  } else {
    mainImg.style.display = 'none';
    thumbsEl.innerHTML = '';
  }
}

// ── Overview Card ──
function renderOverview(r) {
  const v = r.vehicle;
  const rows = [
    ['Year', v.year],
    ['Make', v.make],
    ['Model', v.model],
    ['Trim', v.trim],
    ['Body Class', v.body_class],
    ['Doors', v.doors],
    ['Vehicle Type', v.vehicle_type],
  ];
  $('#overview-body').innerHTML = rows.map(([l, v]) => dataRow(l, v)).join('');
}

// ── Engine Card ──
function renderEngine(r) {
  const e = r.engine || {};
  const t = r.transmission || {};
  const rows = [
    ['Engine', e.type],
    ['Cylinders', e.cylinders],
    ['Displacement', e.displacement_l ? `${Number(e.displacement_l).toFixed(1)}L` : null],
    ['Horsepower', e.hp ? `${e.hp} HP` : null],
    ['Fuel Type', e.fuel_type],
    ['Fuel Injection', e.fuel_injection],
    ['Turbo', e.turbo],
    ['Transmission', t.type],
    ['Speeds', t.speeds],
    ['Drive Type', t.drive_type],
    ['EV Type', e.ev_type],
    ['Battery', e.battery_kwh ? `${e.battery_kwh} kWh` : null],
  ];
  $('#engine-body').innerHTML = rows.map(([l, v]) => dataRow(l, v)).join('');
}

// ── Safety Ratings Card ──
function renderSafetyRatings(r) {
  const s = r.safety_ratings;
  if (!s || !s.rated) {
    $('#safety-ratings-body').innerHTML = '<div class="empty-state">No safety ratings available for this vehicle</div>';
    return;
  }

  const overall = `
    <div class="overall-rating">
      <div class="stars stars-lg">${starsHTML(s.overall)}</div>
      <div class="overall-label">Overall Safety Rating</div>
    </div>
  `;

  const ratings = [
    ['Frontal (Driver)', s.frontal_driver],
    ['Frontal (Passenger)', s.frontal_passenger],
    ['Side (Driver)', s.side_driver],
    ['Side (Passenger)', s.side_passenger],
    ['Rollover', s.rollover],
    ['Side Pole', s.side_pole],
  ];

  const ratingRows = ratings
    .filter(([, v]) => v != null)
    .map(([label, val]) => `
      <div class="rating-row">
        <span class="rating-label">${label}</span>
        <div class="stars">${starsHTML(val)}</div>
      </div>
    `).join('');

  $('#safety-ratings-body').innerHTML = overall + ratingRows;
}

// ── Fuel Economy Card ──
function renderFuel(r) {
  const f = r.fuel_economy;
  if (!f || !f.available) {
    $('#fuel-body').innerHTML = '<div class="empty-state">No fuel economy data available</div>';
    return;
  }

  const mpgRow = (f.city_mpg || f.highway_mpg || f.combined_mpg) ? `
    <div class="mpg-row">
      ${f.city_mpg ? `<div class="mpg-item"><div class="mpg-value">${f.city_mpg}</div><div class="mpg-label">City MPG</div></div>` : ''}
      ${f.highway_mpg ? `<div class="mpg-item"><div class="mpg-value">${f.highway_mpg}</div><div class="mpg-label">Highway MPG</div></div>` : ''}
      ${f.combined_mpg ? `<div class="mpg-item"><div class="mpg-value">${f.combined_mpg}</div><div class="mpg-label">Combined MPG</div></div>` : ''}
    </div>
  ` : '';

  const details = [
    ['Fuel Type', f.fuel_type],
    ['Annual Fuel Cost', f.annual_fuel_cost ? `$${f.annual_fuel_cost}` : null],
    ['CO2 (g/mile)', f.co2_grams_per_mile],
    ['CO2 (tailpipe)', f.co2_tailpipe],
    ['Fuel Grade', f.fuel_grade],
    ['EV Range', f.ev_range ? `${f.ev_range} mi` : null],
    ['Charge Time (240V)', f.charge_time_240v ? `${f.charge_time_240v} hr` : null],
    ['kWh/100mi', f.kwh_per_100mi],
  ];

  $('#fuel-body').innerHTML = mpgRow + details.map(([l, v]) => dataRow(l, v)).join('');
}

// ── Recalls Card ──
function renderRecalls(r) {
  const rec = r.recalls;
  const count = rec?.count || 0;
  const badge = $('#recall-count');

  if (count === 0) {
    badge.textContent = '0';
    badge.className = 'count-badge count-green';
    $('#recalls-body').innerHTML = '<div class="empty-state">No recalls found</div>';
    return;
  }

  badge.textContent = count;
  badge.className = 'count-badge count-red';

  const MAX_SHOW = 5;
  const items = rec.recalls.slice(0, MAX_SHOW).map(recall => `
    <div class="recall-item">
      <div class="recall-component">${esc(recall.component || 'Unknown Component')}</div>
      <div class="recall-summary">${esc(recall.summary || '')}</div>
      <div class="recall-details">
        ${recall.consequence ? `<div><span class="recall-detail-label">Consequence:</span> ${esc(recall.consequence)}</div>` : ''}
        ${recall.remedy ? `<div><span class="recall-detail-label">Remedy:</span> ${esc(recall.remedy)}</div>` : ''}
        ${recall.campaign_number ? `<div><span class="recall-detail-label">Campaign:</span> ${esc(recall.campaign_number)}</div>` : ''}
        ${recall.report_date ? `<div><span class="recall-detail-label">Date:</span> ${esc(recall.report_date)}</div>` : ''}
      </div>
    </div>
  `).join('');

  const showMore = count > MAX_SHOW
    ? `<button class="show-more-btn" onclick="toggleRecalls(this)">Show ${count - MAX_SHOW} more</button>
       <div class="recall-overflow" hidden>${rec.recalls.slice(MAX_SHOW).map(recall => `
         <div class="recall-item">
           <div class="recall-component">${esc(recall.component || 'Unknown Component')}</div>
           <div class="recall-summary">${esc(recall.summary || '')}</div>
         </div>`).join('')}</div>`
    : '';

  $('#recalls-body').innerHTML = items + showMore;
}

window.toggleRecalls = function(btn) {
  const overflow = btn.nextElementSibling;
  overflow.hidden = !overflow.hidden;
  btn.textContent = overflow.hidden ? btn.textContent : 'Show less';
};

// ── Complaints Card ──
function renderComplaints(r) {
  const c = r.complaints;
  const count = c?.count || 0;
  const badge = $('#complaint-count');

  if (count === 0) {
    badge.textContent = '0';
    badge.className = 'count-badge count-green';
    $('#complaints-body').innerHTML = '<div class="empty-state">No complaints found</div>';
    return;
  }

  badge.textContent = count;
  badge.className = count > 10 ? 'count-badge count-red' : 'count-badge count-orange';

  const summary = c.summary || {};
  const stats = `
    <div class="complaint-stats">
      <div class="complaint-stat">
        <div class="complaint-stat-value">${count}</div>
        <div class="complaint-stat-label">Total</div>
      </div>
      <div class="complaint-stat">
        <div class="complaint-stat-value" style="color:var(--red)">${summary.crashes || 0}</div>
        <div class="complaint-stat-label">Crashes</div>
      </div>
      <div class="complaint-stat">
        <div class="complaint-stat-value" style="color:var(--orange)">${summary.fires || 0}</div>
        <div class="complaint-stat-label">Fires</div>
      </div>
      <div class="complaint-stat">
        <div class="complaint-stat-value" style="color:var(--yellow)">${summary.injuries || 0}</div>
        <div class="complaint-stat-label">Injuries</div>
      </div>
      <div class="complaint-stat">
        <div class="complaint-stat-value" style="color:var(--red)">${summary.deaths || 0}</div>
        <div class="complaint-stat-label">Deaths</div>
      </div>
    </div>
  `;

  const MAX_SHOW = 5;
  const items = c.complaints.slice(0, MAX_SHOW).map(comp => `
    <div class="complaint-item">
      <div class="complaint-component">${esc(comp.component || 'Unknown')}
        ${comp.crash ? '<span class="badge badge-red" style="font-size:.7rem">Crash</span>' : ''}
        ${comp.fire ? '<span class="badge badge-orange" style="font-size:.7rem">Fire</span>' : ''}
      </div>
      <div class="complaint-summary">${esc(truncate(comp.summary || '', 300))}</div>
      <div class="complaint-meta">
        ${comp.date_of_incident ? `<span>Incident: ${esc(comp.date_of_incident)}</span>` : ''}
        ${comp.date_complaint_filed ? `<span>Filed: ${esc(comp.date_complaint_filed)}</span>` : ''}
      </div>
    </div>
  `).join('');

  const showMore = count > MAX_SHOW
    ? `<button class="show-more-btn" onclick="toggleComplaints(this)">Show ${count - MAX_SHOW} more</button>
       <div class="complaint-overflow" hidden>${c.complaints.slice(MAX_SHOW).map(comp => `
         <div class="complaint-item">
           <div class="complaint-component">${esc(comp.component || 'Unknown')}</div>
           <div class="complaint-summary">${esc(truncate(comp.summary || '', 200))}</div>
         </div>`).join('')}</div>`
    : '';

  $('#complaints-body').innerHTML = stats + items + showMore;
}

window.toggleComplaints = function(btn) {
  const overflow = btn.nextElementSibling;
  overflow.hidden = !overflow.hidden;
  btn.textContent = overflow.hidden ? btn.textContent : 'Show less';
};

// ── Safety Equipment Card ──
function renderSafetyEquipment(r) {
  const s = r.safety_equipment;
  if (!s) {
    $('#safety-equip-body').innerHTML = '<div class="empty-state">No safety equipment data</div>';
    return;
  }

  const items = [
    ['Frontal Air Bags', s.airbags_front],
    ['Side Air Bags', s.airbags_side],
    ['Curtain Air Bags', s.airbags_curtain],
    ['Knee Air Bags', s.airbags_knee],
    ['ABS', s.abs],
    ['ESC', s.esc],
    ['Traction Control', s.traction_control],
    ['TPMS', s.tpms],
    ['Forward Collision Warning', s.forward_collision_warning],
    ['Lane Departure Warning', s.lane_departure_warning],
    ['Lane Keeping', s.lane_keeping],
    ['Adaptive Cruise Control', s.adaptive_cruise],
    ['Backup Camera', s.backup_camera],
    ['Parking Assist', s.parking_assist],
    ['Blind Spot Monitor', s.blind_spot],
    ['Auto Emergency Braking', s.auto_emergency_braking],
    ['Pedestrian Detection', s.pedestrian_detection],
    ['Daytime Running Lights', s.daytime_running_lights],
    ['Pretensioner', s.pretensioner],
    ['Seat Belts', s.seat_belt_type],
  ];

  const html = items.map(([label, value]) => {
    const has = value && value !== 'Not Applicable';
    return `
      <div class="equip-item ${has ? 'equip-yes' : 'equip-no'}">
        <span class="equip-icon">${has ? '\u2713' : '\u2013'}</span>
        <span>${esc(label)}${has && typeof value === 'string' && value !== 'Standard' && value !== 'Yes' ? `: ${esc(value)}` : ''}</span>
      </div>
    `;
  }).join('');

  $('#safety-equip-body').innerHTML = `<div class="equip-grid">${html}</div>`;
}

// ── Plant / Manufacturing Card ──
function renderPlant(r) {
  const p = r.plant || {};
  const v = r.validation || {};
  const rows = [
    ['Manufacturer', v.wmi?.manufacturer],
    ['Country of Origin', v.wmi?.country],
    ['Region', v.wmi?.region],
    ['Plant City', p.city],
    ['Plant State', p.state],
    ['Plant Country', p.country],
    ['Plant Company', p.company],
  ];
  $('#plant-body').innerHTML = rows.map(([l, v]) => dataRow(l, v)).join('');
}

// ── Raw Data Card ──
function renderRaw(r) {
  const raw = r.raw_nhtsa;
  if (!raw) {
    $('#raw-body').innerHTML = '<div class="empty-state">No raw data available</div>';
    return;
  }

  const entries = Object.entries(raw).filter(([, v]) => v && v !== '' && v !== 'Not Applicable');
  entries.sort((a, b) => a[0].localeCompare(b[0]));

  const filterInput = `<input class="raw-filter" placeholder="Filter fields..." oninput="filterRaw(this.value)">`;
  const tableRows = entries.map(([k, v]) =>
    `<tr class="raw-row"><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`
  ).join('');

  $('#raw-body').innerHTML = `${filterInput}<table class="raw-table"><thead><tr><th>Field</th><th>Value</th></tr></thead><tbody>${tableRows}</tbody></table>`;
}

window.filterRaw = function(query) {
  const q = query.toLowerCase();
  $$('.raw-row').forEach(row => {
    const text = row.textContent.toLowerCase();
    row.style.display = text.includes(q) ? '' : 'none';
  });
};

// ── Collapsible raw data ──
$$('.card-title-toggle').forEach(el => {
  el.addEventListener('click', () => {
    const target = el.dataset.target;
    const body = $(`#${target}`);
    el.classList.toggle('open');
    body.classList.toggle('expanded');
  });
});

// ── Helpers ──
function dataRow(label, value) {
  if (value == null || value === '') return '';
  return `<div class="data-row"><span class="data-label">${esc(label)}</span><span class="data-value">${esc(String(value))}</span></div>`;
}

function starsHTML(rating, max = 5) {
  if (rating == null) return '<span class="star-empty">N/A</span>';
  const n = Number(rating);
  let html = '';
  for (let i = 1; i <= max; i++) {
    html += `<span class="${i <= n ? 'star-filled' : 'star-empty'}">\u2605</span>`;
  }
  return html;
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max) + '...' : str;
}

function showInputError(msg) {
  inputError.textContent = msg;
  inputError.hidden = false;
}
function hideInputError() {
  inputError.hidden = true;
}

function setBtnLoading(loading) {
  btn.disabled = loading;
  $('.btn-text', btn).hidden = loading;
  $('.btn-spinner', btn).hidden = !loading;
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toast-container').appendChild(el);
  setTimeout(() => {
    el.classList.add('fade-out');
    setTimeout(() => el.remove(), 300);
  }, 4000);
}

// ── History ──
const HISTORY_KEY = 'vin-history';
const MAX_HISTORY = 15;

function getHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch {
    return [];
  }
}

function saveToHistory(vin, report) {
  const v = report.vehicle || {};
  const entry = {
    vin,
    desc: [v.year, v.make, v.model].filter(Boolean).join(' '),
    ts: Date.now(),
  };

  let history = getHistory().filter(h => h.vin !== vin);
  history.unshift(entry);
  history = history.slice(0, MAX_HISTORY);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  renderHistory();
}

function renderHistory() {
  const history = getHistory();
  const list = $('#history-list');

  if (history.length === 0) {
    list.innerHTML = '<li style="color:var(--text-muted);font-size:.85rem">No history yet</li>';
    return;
  }

  list.innerHTML = history.map(h => `
    <li data-vin="${esc(h.vin)}">
      <div class="history-vin">${esc(h.vin)}</div>
      <div class="history-desc">${esc(h.desc || 'Unknown vehicle')}</div>
    </li>
  `).join('');

  $$('li[data-vin]', list).forEach(li => {
    li.addEventListener('click', () => {
      input.value = li.dataset.vin;
      form.dispatchEvent(new Event('submit'));
      $('#history-panel').classList.remove('open');
    });
  });
}

// History toggle
$('#history-toggle').addEventListener('click', () => {
  const panel = $('#history-panel');
  panel.hidden = false;
  panel.classList.toggle('open');
  renderHistory();
});

$('#clear-history').addEventListener('click', () => {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
});

// ── URL routing (direct VIN link) ──
function checkUrlVin() {
  const path = window.location.pathname;
  const match = path.match(/^\/([A-HJ-NPR-Z0-9]{17})$/i);
  if (match) {
    input.value = match[1].toUpperCase();
    form.dispatchEvent(new Event('submit'));
  }
}

// ── Auto-uppercase input ──
input.addEventListener('input', () => {
  const pos = input.selectionStart;
  input.value = input.value.toUpperCase();
  input.setSelectionRange(pos, pos);
  input.classList.remove('invalid');
  hideInputError();
});

// ── Init ──
renderHistory();
checkUrlVin();
