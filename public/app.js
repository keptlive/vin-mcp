/* ── VIN Decoder Frontend ── */
const apiFetch=(url,options={})=>fetch(url,{...options,cache:'no-store'});

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
let authToken = localStorage.getItem('vin-auth-token');
let currentUser = null;
let userPrefs = null;
let savedVinsList = [];
let decodeRevision = 0;

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
  const revision = ++decodeRevision;
  if (!e.detail?.preserveView) window.VinWorkspace?.navigate('report');
  currentReport = null;
  results.hidden = true;
  window.VinWorkspace?.clearReport();

  // Client-side validation
  const check = quickValidate(vin);
  if (!check.valid) {
    showInputError(check.error);
    input.classList.add('invalid');
    setBtnLoading(false);
    $('#decode-status').textContent = '';
    input.focus();
    return;
  }

  input.classList.remove('invalid');
  hideInputError();
  setBtnLoading(true);
  $('#decode-status').textContent = 'Retrieving vehicle and safety records…';

  try {
    const res = await apiFetch(`/api/vin/${encodeURIComponent(vin)}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Server error' }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const report = await res.json();
    if (revision !== decodeRevision) return;
    if (!report.valid) {
      showInputError('Invalid VIN — validation failed');
      $('#decode-status').textContent = '';
      return;
    }

    if (!report.vehicle) {
      showInputError(report.error || 'Could not decode VIN');
      $('#decode-status').textContent = '';
      return;
    }
    currentReport = report;

    // Save to history
    saveToHistory(vin, report);

    // Render results
    renderResults(report);
    applyPreferences();
    updateSaveButton(vin);

    // Compact hero
    hero.classList.add('compact');
    results.hidden = false;
    $('#decode-status').textContent = 'Report ready. Review source coverage in each section.';
    if (!location.hash || location.hash === '#report') {
      history.replaceState(null, '', '/' + encodeURIComponent(vin) + location.search + '#report');
      results.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
    }

  } catch (err) {
    if (revision === decodeRevision) { showInputError(err.message); $('#decode-status').textContent = ''; }
  } finally {
    if (revision === decodeRevision) setBtnLoading(false);
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
  if (typeof window !== 'undefined') window.VinWorkspace?.reportUpdated(report);
}

// ── Hero ──
function renderHero(r) {
  const v = r.vehicle;
  const title = [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ');
  $('#vehicle-title').textContent = title;
  $('#research-model-link').href = '#communications';

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
    badges.push(`<span class="badge badge-red">${recallCount} Recall Campaign${recallCount > 1 ? 's' : ''}</span>`);
  } else if (r.recalls?.available === false) {
    badges.push(`<span class="badge badge-neutral">Recall lookup unavailable</span>`);
  } else {
    badges.push(`<span class="badge badge-green">No model-year campaigns found</span>`);
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
      mainImg.style.display = '';
      mainImg.src = urls[0];
      mainImg.alt = title;
      thumbsEl.innerHTML = urls.map((url, i) =>
        `<img src="${esc(url)}" alt="View ${i+1}" tabindex="0" role="button" aria-label="Show vehicle view ${i+1}" class="${i === 0 ? 'active' : ''}" data-url="${esc(url)}">`
      ).join('');

      $$('img', thumbsEl).forEach(img => {
        img.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); img.click(); } });
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
    const message = f?.reason === 'ambiguous_variant' ? 'Multiple EPA variants match. Fuel economy cannot be assigned confidently to this VIN.'
      : f?.reason === 'no_matching_variant' ? 'No EPA variant matches the decoded engine and transmission.'
      : f?.reason === 'upstream_error' ? 'EPA lookup is temporarily unavailable. Please try again.' : 'No fuel economy data available';
    $('#fuel-body').innerHTML = `<div class="empty-state">${message}</div>`;
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
    ['Charge Time (240V)', f.ev_charge_time_240v ? `${f.ev_charge_time_240v} hr` : null],
    ['EPA Variant', f.matched_variant],
    ['kWh/100mi', f.kwh_per_100mi],
  ];

  $('#fuel-body').innerHTML = mpgRow + details.map(([l, v]) => dataRow(l, v)).join('');
}

// ── Recalls Card ──
function renderRecalls(r) {
  renderCampaigns(r);
  const s = r.recall_status;
  const link = s?.verification_url || 'https://www.nhtsa.gov/recalls';
  const renderStatusRecords = records => records.map(x => `<div class="recall-item"><strong>${esc(x.campaign_number)} · ${esc(x.manufacturer_status)}</strong>${x.record_kind ? `<p class="small">${esc(x.record_kind.replaceAll('_',' '))}</p>` : ''}<p>${esc(x.summary || x.title || '')}</p>${x.completion_description ? `<p><span class="recall-detail-label">Completion basis:</span> ${esc(x.completion_description)}</p>` : ''}${x.repair_completed_at ? `<p><span class="recall-detail-label">Reported repair date:</span> ${esc(x.repair_completed_at)}</p>` : ''}${x.manufacturer_closed_at ? `<p><span class="recall-detail-label">Manufacturer closing date:</span> ${esc(x.manufacturer_closed_at)}</p>` : ''}${x.remedy ? `<p><span class="recall-detail-label">Remedy:</span> ${esc(x.remedy)}</p>` : ''}${x.document_url ? `<a href="${esc(x.document_url)}" target="_blank" rel="noopener">Manufacturer bulletin</a>` : ''}</div>`).join('');
  const content = s?.available
    ? `<p>${s.open_record_count!==undefined ? esc(s.open_record_count)+' open recall/campaign records · '+esc(s.open_count ?? 'Unknown')+' verified safety-recall count' : esc(s.open_count ?? 'Unknown')+' open recalls'} · ${esc(s.completed_count ?? 'Unknown')} manufacturer-reported completed/closed${s.unknown_count ? ' · '+esc(s.unknown_count)+' unknown status' : ''}</p>
       <p>Checked ${esc(s.source.retrieved_at)} · ${esc(s.source.provider)}</p>
       ${renderStatusRecords(s.campaigns || s.recalls)}
       ${!s.campaigns && s.service_campaigns?.length ? `<h4>Other manufacturer programs · ${esc(s.service_campaigns.length)}</h4>${renderStatusRecords(s.service_campaigns)}` : ''}
       <p>${esc(s.note)}</p>`
    : `<p>VIN-specific repair status is unavailable. ${esc(s?.note || 'Check the official source. Model-year campaigns do not establish completed repairs.')}</p>`;
  $('#recalls-body').innerHTML = `<div class="recall-item"><h3>VIN-specific recall repair status</h3>${content}<p><a href="${esc(link)}" target="_blank" rel="noopener">Verify this VIN with the official source</a></p></div><h3>Model-year recall campaigns</h3>` + $('#recalls-body').innerHTML;
}

function renderCampaigns(r) {
  const rec = r.recalls;
  const count = rec?.count || 0;
  const badge = $('#recall-count');

  if (rec?.available === false) {
    badge.textContent = '?';
    badge.className = 'count-badge';
    $('#recalls-body').innerHTML = '<div class="empty-state">Recall lookup is temporarily unavailable. Please try again.</div>';
    return;
  }
  if (count === 0) {
    badge.textContent = '0';
    badge.className = 'count-badge count-green';
    $('#recalls-body').innerHTML = '<div class="empty-state">No campaigns found for this make, model and year. Check your VIN at NHTSA for unrepaired recalls.</div>';
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

  $('#recalls-body').innerHTML = '<p class="empty-state">Campaigns for this make, model and year; your VIN may not be affected. <a href="https://www.nhtsa.gov/recalls" target="_blank" rel="noopener">Check VIN-specific repair status at NHTSA</a>.</p>' + items + showMore;
}

window.toggleRecalls = function(btn) {
  const overflow = btn.nextElementSibling;
  overflow.hidden = !overflow.hidden;
  if (!btn.dataset.moreLabel) btn.dataset.moreLabel = btn.textContent;
  btn.textContent = overflow.hidden ? btn.dataset.moreLabel : 'Show less';
};

// ── Complaints Card ──
function renderComplaints(r) {
  const c = r.complaints;
  const count = c?.count || 0;
  const badge = $('#complaint-count');

  if (c?.available === false) {
    badge.textContent = '?';
    badge.className = 'count-badge';
    $('#complaints-body').innerHTML = '<div class="empty-state">Complaint lookup is temporarily unavailable. Please try again.</div>';
    return;
  }
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
  if (!btn.dataset.moreLabel) btn.dataset.moreLabel = btn.textContent;
  btn.textContent = overflow.hidden ? btn.dataset.moreLabel : 'Show less';
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
    el.setAttribute('aria-expanded', String(body.classList.contains('expanded')));
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
  btn.setAttribute('aria-label', loading ? 'Loading vehicle report' : 'View report');
  btn.setAttribute('aria-busy', String(loading));
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

// ── Copy code block ──
window.copyCode = function(btn) {
  const code = btn.closest('.code-block').querySelector('code');
  navigator.clipboard.writeText(code.textContent.trim()).then(() => {
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1500);
  }).catch(() => {
    // Fallback
    const range = document.createRange();
    range.selectNodeContents(code);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('copy');
    sel.removeAllRanges();
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1500);
  });
};

// ── History ──
const HISTORY_KEY = 'vin-history';
const MAX_HISTORY = 15;

function getHistory() {
  try {
    const entries = JSON.parse(localStorage.getItem(HISTORY_KEY));
    return Array.isArray(entries) ? entries.filter(entry => entry && VIN_RE.test(entry.vin)).slice(0,MAX_HISTORY) : [];
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
  list.innerHTML = history.length ? history.map(h => `<li><button type="button" class="history-entry" data-vin="${esc(h.vin)}"><span class="history-vin">${esc(h.vin)}</span><span class="history-desc" style="display:block">${esc(h.desc || 'Unknown vehicle')}</span></button></li>`).join('') : '<li class="small">No recent reports yet. Start with a VIN.</li>';
  $$('[data-vin]', list).forEach(button => button.addEventListener('click', () => openVehicle(button.dataset.vin)));
}

function openVehicle(vin) {
  input.value = vin;
  window.VinWorkspace?.navigate('report');
  form.dispatchEvent(new Event('submit'));
}
function openHistory() { window.VinWorkspace?.navigate('saved'); renderHistory(); }
function closeHistory() { /* Recent vehicles are an inline workspace view. */ }
$('#history-toggle').addEventListener('click', openHistory);
$('#history-close').addEventListener('click', () => window.VinWorkspace?.navigate('report'));
$('#clear-history').addEventListener('click', () => { localStorage.removeItem(HISTORY_KEY); renderHistory(); });

function checkUrlVin() {
  const match = window.location.pathname.match(new RegExp('^/([A-HJ-NPR-Z0-9]{17})$', 'i'));
  if (match && currentReport?.vin !== match[1].toUpperCase()) {
    input.value = match[1].toUpperCase();
    form.dispatchEvent(new CustomEvent('submit', {detail:{preserveView:true}}));
  }
}
addEventListener('popstate', checkUrlVin);
input.addEventListener('input', () => {
  const pos = input.selectionStart;
  input.value = input.value.toUpperCase();
  input.setSelectionRange(pos, pos);
  input.classList.remove('invalid');
  hideInputError();
  decodeRevision++;
  setBtnLoading(false);
  $('#decode-status').textContent = '';
  if (currentReport?.vin !== input.value.trim().toUpperCase()) {
    currentReport = null;
    results.hidden = true;
    window.VinWorkspace?.clearReport();
  }
});

// Dialogs have one focus owner. Saved/recent vehicles are never floating drawers.
let dialogReturnFocus = null;
function openDialog(id, focusSelector) {
  dialogReturnFocus = document.activeElement;
  $$('.modal-overlay').forEach(el => el.hidden = true);
  const overlay = $(id); overlay.hidden = false;
  $('.workspace-layout').inert = true;
  $('.app-header').inert = true;
  document.body.style.overflow = 'hidden';
  (focusSelector ? $(focusSelector) : overlay.querySelector('input,button')).focus();
  $('#user-menu').open = false;
}
function closeDialog(id) {
  $(id).hidden = true;
  $('.workspace-layout').inert = false;
  $('.app-header').inert = false;
  document.body.style.overflow = '';
  const collapsedMenu = dialogReturnFocus?.closest('details:not([open])');
  if (collapsedMenu && dialogReturnFocus !== collapsedMenu.querySelector('summary')) collapsedMenu.querySelector('summary')?.focus();
  else if (dialogReturnFocus?.isConnected && !dialogReturnFocus.closest('[hidden]')) dialogReturnFocus.focus();
  else $('#my-vins-btn').focus();
  dialogReturnFocus = null;
}
$$('.modal-overlay').forEach(overlay => overlay.addEventListener('click', e => { if (e.target === overlay) closeDialog('#' + overlay.id); }));
document.addEventListener('keydown', e => {
  const overlay = $('.modal-overlay:not([hidden])');
  if (!overlay) return;
  if (e.key === 'Escape') { e.preventDefault(); closeDialog('#' + overlay.id); return; }
  if (e.key === 'Tab') {
    const focusable = $$('button,input,select,textarea,a[href],[tabindex="0"]', overlay).filter(el => !el.disabled && !el.closest('[hidden]'));
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) { e.preventDefault(); first?.focus(); }
  }
});

// Account operations only update UI after a successful response.
let authRevision = 0;
function authHeaders() { return authToken ? { Authorization: `Bearer ${authToken}` } : {}; }
async function accountRequest(url, options={}) {
  const response = await apiFetch(url, { ...options, headers: { ...authHeaders(), ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (HTTP ${response.status})`);
  return data;
}
async function checkAuth() {
  if (!authToken) { updateAuthUI(); return; }
  const revision = authRevision;
  try {
    const user = await accountRequest('/api/auth/me');
    if (revision !== authRevision) return;
    currentUser = user;
    await Promise.all([loadPreferences(), loadSavedVins()]);
    if (revision !== authRevision) return;
  } catch {
    if (revision !== authRevision) return;
    authToken = null; currentUser = null;
    localStorage.removeItem('vin-auth-token');
  }
  updateAuthUI(); applyPreferences();
}
function updateAuthUI() {
  $('#login-btn').hidden = !!currentUser;
  $('#user-menu').hidden = !currentUser;
  $('#user-menu').open = false;
  $('#saved-signin').hidden = !!currentUser;
  $('#saved-vins-list').hidden = !currentUser;
  if (currentUser) $('#user-email').textContent = currentUser.display_name || currentUser.email;
  updateSaveButton(currentReport?.vin);
  renderSavedVins();
}
function showSignIn() {
  $('#login-form').hidden = false; $('#register-form').hidden = true;
  $$('.modal-tab').forEach(tab => { const active = tab.dataset.tab === 'login'; tab.classList.toggle('active',active); tab.setAttribute('aria-pressed',String(active)); });
  openDialog('#auth-modal', '#login-email');
}
$('#login-btn').addEventListener('click', showSignIn);
$('#saved-login-btn').addEventListener('click', showSignIn);
$('#auth-close').addEventListener('click', () => closeDialog('#auth-modal'));
$$('.modal-tab').forEach(tab => tab.addEventListener('click', () => {
  $$('.modal-tab').forEach(t => { t.classList.toggle('active', t === tab); t.setAttribute('aria-pressed', String(t === tab)); });
  const isLogin = tab.dataset.tab === 'login';
  $('#login-form').hidden = !isLogin; $('#register-form').hidden = isLogin;
  $(isLogin ? '#login-email' : '#reg-email').focus();
}));
async function authenticate(e, register) {
  e.preventDefault();
  const revision = ++authRevision, button = e.target.querySelector('button[type=submit]');
  const errEl = $(register ? '#reg-error' : '#login-error'); errEl.hidden = true; button.disabled = true;
  try {
    const data = await accountRequest('/api/auth/' + (register ? 'register' : 'login'), {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify(register ? {email:$('#reg-email').value,password:$('#reg-password').value,display_name:$('#reg-name').value || undefined} : {email:$('#login-email').value,password:$('#login-password').value})
    });
    if (revision !== authRevision) return;
    authToken = data.token; currentUser = data.user;
    localStorage.setItem('vin-auth-token', authToken);
    closeDialog('#auth-modal');
    await Promise.all([loadPreferences(), loadSavedVins()]);
    if (revision !== authRevision) return;
    updateAuthUI(); applyPreferences();
    if (document.activeElement === document.body || document.activeElement?.closest('[hidden]')) $('#user-email').focus();
    toast(register ? 'Account created' : 'Signed in');
  } catch (err) { if (revision === authRevision) { errEl.textContent = err.message; errEl.hidden = false; } }
  finally { button.disabled = false; }
}
$('#login-form').addEventListener('submit', e => authenticate(e, false));
$('#register-form').addEventListener('submit', e => authenticate(e, true));
$('#logout-btn').addEventListener('click', () => {
  authRevision++; authToken = null; currentUser = null; userPrefs = null; savedVinsList = [];
  localStorage.removeItem('vin-auth-token');
  $('#saved-status').textContent = '';
  updateAuthUI(); applyPreferences(); toast('Signed out');
  $('#login-btn').focus();
});
async function loadSavedVins() {
  if (!authToken) return;
  const token = authToken;
  try {
    const data = await accountRequest('/api/user/vins');
    if (token !== authToken) return;
    savedVinsList = data; $('#saved-status').textContent = ''; renderSavedVins();
  } catch (err) { if (token === authToken) $('#saved-status').textContent = 'Saved vehicles could not be loaded. ' + err.message; }
}
function updateSaveButton(vin) {
  const button = $('#save-vin-btn'); button.hidden = !vin;
  const saved = savedVinsList.find(s => s.vin === vin?.toUpperCase());
  button.classList.toggle('saved', !!saved);
  $('#save-vin-text').textContent = !currentUser ? 'Sign in to save' : saved ? (saved.label || 'Saved · edit label') : 'Save vehicle';
}
let labelTarget = null;
function editVehicleLabel(vin) {
  if (!currentUser) { showSignIn(); return; }
  const existing = savedVinsList.find(s => s.vin === vin);
  labelTarget = {vin, id:existing?.id};
  $('#label-title').textContent = existing ? 'Edit vehicle label' : 'Save vehicle';
  $('#label-vin').textContent = vin;
  $('#vehicle-label').value = existing?.label || '';
  $('#label-error').hidden = true;
  openDialog('#label-modal', '#vehicle-label');
}
$('#save-vin-btn').addEventListener('click', () => { if (currentReport) editVehicleLabel(currentReport.vin); });
$('#label-close').addEventListener('click', () => closeDialog('#label-modal'));
$('#label-form').addEventListener('submit', async e => {
  e.preventDefault(); if (!labelTarget || !currentUser) return;
  const token = authToken, target = {...labelTarget}, label = $('#vehicle-label').value.trim(), button = $('#label-submit');
  button.disabled = true; $('#label-error').hidden = true;
  try {
    await accountRequest(target.id ? '/api/user/vins/' + target.id : '/api/user/vins', {method:target.id ? 'PUT' : 'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({vin:target.vin,label})});
    if (token !== authToken) return;
    await loadSavedVins(); updateSaveButton(currentReport?.vin); closeDialog('#label-modal'); toast(target.id ? 'Label updated' : 'Vehicle saved');
  } catch (err) { $('#label-error').textContent = err.message; $('#label-error').hidden = false; }
  finally { button.disabled = false; }
});
$('#my-vins-btn').addEventListener('click', () => { window.VinWorkspace?.navigate('saved'); renderSavedVins(); if (currentUser) loadSavedVins(); });
$('#saved-vins-close').addEventListener('click', () => window.VinWorkspace?.navigate('report'));
function renderSavedVins() {
  const list = $('#saved-vins-list');
  if (!currentUser) { list.replaceChildren(); return; }
  if (!savedVinsList.length) { list.innerHTML = '<li class="small">No saved vehicles yet. Open a VIN report and choose Save vehicle.</li>'; return; }
  list.innerHTML = savedVinsList.map(s => `<li class="saved-vin-item" data-vin="${esc(s.vin)}" data-id="${esc(s.id)}"><div class="saved-vin-info"><div class="saved-vin-label">${esc(s.label || [s.year,s.make,s.model].filter(Boolean).join(' ') || 'Vehicle')}</div><div class="saved-vin-number">${esc(s.vin)}</div></div><div class="saved-vin-actions"><button type="button" class="saved-vin-decode" aria-label="Open report ${esc(s.vin)}">Report</button><button type="button" class="saved-vin-compare" aria-label="Compare ${esc(s.vin)}">Compare</button><button type="button" class="saved-vin-rename" aria-label="Rename ${esc(s.vin)}">Rename</button><button type="button" class="saved-vin-delete" aria-label="Remove ${esc(s.vin)}">Remove</button></div></li>`).join('');
  $$('.saved-vin-decode', list).forEach(b => b.onclick = () => openVehicle(b.closest('li').dataset.vin));
  $$('.saved-vin-rename', list).forEach(b => b.onclick = () => editVehicleLabel(b.closest('li').dataset.vin));
  $$('.saved-vin-compare', list).forEach(b => b.onclick = () => window.VinWorkspace?.addComparison(b.closest('li').dataset.vin));
  $$('.saved-vin-delete', list).forEach(b => b.onclick = async () => {
    const li = b.closest('li'), id = li.dataset.id, token = authToken; b.disabled = true;
    try {
      await accountRequest('/api/user/vins/' + encodeURIComponent(id), {method:'DELETE'});
      if (token !== authToken) return;
      savedVinsList = savedVinsList.filter(s => String(s.id) !== id); renderSavedVins(); updateSaveButton(currentReport?.vin); toast('Vehicle removed');
    } catch (err) { $('#saved-status').textContent = 'Could not remove vehicle. ' + err.message; b.disabled = false; }
  });
}

// ── Output Preferences ──

async function loadPreferences() {
  if (!authToken) { userPrefs = null; return; }
  const token = authToken;
  try { const data = await accountRequest('/api/user/preferences'); if (token === authToken) userPrefs = data; } catch {}
}

function applyPreferences() {
  const prefs = userPrefs || {};
  const map = {
    show_overview: '#card-overview',
    show_engine: '#card-engine',
    show_safety_ratings: '#card-safety-ratings',
    show_fuel_economy: '#card-fuel',
    show_recalls: '#card-recalls',
    show_complaints: '#card-complaints',
    show_safety_equipment: '#card-safety-equip',
    show_photos: '.hero-photos',
    show_raw_nhtsa: '#card-raw',
  };
  for (const [key, selector] of Object.entries(map)) {
    const el = $(selector);
    if (el) {
      // If no prefs loaded (logged out), show everything. If prefs loaded, use them.
      el.style.display = userPrefs ? (prefs[key] ? '' : 'none') : '';
    }
  }
}

// Settings modal
$('#settings-btn').addEventListener('click', () => {
  syncSettingsUI();
  openDialog('#settings-modal', '#settings-toggles input');
});
$('#settings-close').addEventListener('click', () => {
  closeDialog('#settings-modal');
});


function syncSettingsUI() {
  const prefs = userPrefs || {};
  $$('#settings-toggles input[data-pref]').forEach(input => {
    const key = input.dataset.pref;
    input.checked = prefs[key] !== undefined ? !!prefs[key] : true;
  });
}

$$('#settings-toggles input[data-pref]').forEach(inp => {
  inp.addEventListener('change', async () => {
    if (!authToken) return;
    const token = authToken, key = inp.dataset.pref, value = inp.checked;
    inp.disabled = true;
    try {
      const data = await accountRequest('/api/user/preferences', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({[key]:value}) });
      if (token === authToken) { userPrefs = data; applyPreferences(); }
    } catch (err) { if (token === authToken) { inp.checked = !value; toast('Setting could not be saved. ' + err.message, 'error'); } }
    finally { inp.disabled = false; }
  });
});

// ── WebMCP (W3C Web Model Context Protocol) ──
// Exposes VIN tools to browser-based AI agents (e.g. Gemini in Chrome)
// https://webmachinelearning.github.io/webmcp/

if (typeof navigator !== 'undefined' && navigator.modelContext) {
  const vinParam = {
    type: 'object',
    properties: { vin: { type: 'string', description: '17-character Vehicle Identification Number' } },
    required: ['vin'],
  };

  navigator.modelContext.registerTool({
    name: 'decode_vin',
    description: 'Decode a Vehicle Identification Number (VIN) to get the full vehicle report including make, model, year, engine specs, safety ratings, model-year recall campaigns, consumer complaints, fuel economy, and photos.',
    inputSchema: vinParam,
    execute: async ({ vin }) => {
      const res = await apiFetch(`/api/vin/${encodeURIComponent(vin)}`);
      if (!res.ok) return { error: `Failed to decode VIN: HTTP ${res.status}` };
      const report = await res.json();
      // Also render in the UI
      if (report.valid && report.vehicle) {
        window.VinWorkspace?.navigate('report');
        input.value = vin.toUpperCase();
        currentReport = report;
        saveToHistory(vin, report);
        renderResults(report);
        applyPreferences();
        updateSaveButton(vin);
        hero.classList.add('compact');
        results.hidden = false;
      }
      return report;
    },
  });

  navigator.modelContext.registerTool({
    name: 'validate_vin',
    description: 'Check if a VIN is valid (format, characters, checksum) without performing a full decode.',
    inputSchema: vinParam,
    execute: async ({ vin }) => {
      const res = await apiFetch(`/api/vin/${encodeURIComponent(vin)}/validate`);
      if (!res.ok) return { error: `Validation failed: HTTP ${res.status}` };
      return await res.json();
    },
  });

  navigator.modelContext.registerTool({
    name: 'lookup_recalls',
    description: 'Look up NHTSA safety recalls for a vehicle by VIN. Returns recall campaigns, affected components, consequences, and remedies.',
    inputSchema: vinParam,
    execute: async ({ vin }) => {
      const res = await apiFetch(`/api/vin/${encodeURIComponent(vin)}/recalls`);
      if (!res.ok) return { error: `Recall lookup failed: HTTP ${res.status}` };
      return await res.json();
    },
  });

  navigator.modelContext.registerTool({
    name: 'lookup_complaints',
    description: 'Look up NHTSA consumer complaints for a vehicle by VIN. Returns complaint summaries, crash/fire/injury counts.',
    inputSchema: vinParam,
    execute: async ({ vin }) => {
      const res = await apiFetch(`/api/vin/${encodeURIComponent(vin)}/complaints`);
      if (!res.ok) return { error: `Complaint lookup failed: HTTP ${res.status}` };
      return await res.json();
    },
  });

  navigator.modelContext.registerTool({
    name: 'lookup_safety_ratings',
    description: 'Get NHTSA crash test safety ratings for a vehicle by VIN. Returns overall rating and individual test scores (frontal, side, rollover).',
    inputSchema: vinParam,
    execute: async ({ vin }) => {
      const res = await apiFetch(`/api/vin/${encodeURIComponent(vin)}/safety`);
      if (!res.ok) return { error: `Safety rating lookup failed: HTTP ${res.status}` };
      return await res.json();
    },
  });

  navigator.modelContext.registerTool({
    name: 'lookup_fuel_economy',
    description: 'Get EPA fuel economy data for a vehicle by VIN. Returns city/highway/combined MPG, annual fuel cost, CO2 emissions.',
    inputSchema: vinParam,
    execute: async ({ vin }) => {
      const res = await apiFetch(`/api/vin/${encodeURIComponent(vin)}/fuel`);
      if (!res.ok) return { error: `Fuel economy lookup failed: HTTP ${res.status}` };
      return await res.json();
    },
  });

  navigator.modelContext.registerTool({
    name: 'batch_decode',
    description: 'Decode multiple VINs at once (up to 10). Returns an array of vehicle reports.',
    inputSchema: {
      type: 'object',
      properties: { vins: { type: 'array', items: { type: 'string' }, description: 'Array of up to 10 VINs to decode', maxItems: 10 } },
      required: ['vins'],
    },
    execute: async ({ vins }) => {
      const res = await apiFetch('/api/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vins }),
      });
      if (!res.ok) return { error: `Batch decode failed: HTTP ${res.status}` };
      return await res.json();
    },
  });

  console.log('[WebMCP] 7 VIN tools registered for browser AI agents');
}

// ── Init ──
renderHistory();
checkUrlVin();
checkAuth();
