// ════════════════════════════════════════════════════════════
// VISIT BOOK CRM — Frontend app logic
// Talks to the Express+SQLite backend over /api/*
// ════════════════════════════════════════════════════════════
const $ = id => document.getElementById(id);
const API = '/api';

let TOKEN = localStorage.getItem('vb_token') || null;
let CURRENT_USER = null;
let TEMPLATES = []; // cached approved WA templates
let WA_CONFIGURED = false;

// In-memory caches of last-loaded data (used for client-side filtering/rendering)
const STATE = {
  visitClients: [], activeClients: [], meetings: [], followups: [],
  swaData: [], swaSelected: [], waLog: [], executives: [],
};

// ── Generic fetch wrapper with auth header + error toast ──
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (TOKEN) opts.headers['Authorization'] = 'Bearer ' + TOKEN;
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try {
    res = await fetch(API + path, opts);
  } catch (e) {
    toast('⚠️ Network error — check your connection', 'error');
    throw e;
  }
  if (res.status === 401) {
    toast('Session expired — please log in again', 'error');
    doLogout();
    throw new Error('Unauthorized');
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    const msg = (data && data.error) || `Request failed (${res.status})`;
    toast('❌ ' + msg, 'error');
    throw new Error(msg);
  }
  return data;
}

function toast(msg, type = 'success') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast show ${type}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = 'toast'; }, 3200);
}

// ════════════════════════ AUTH ════════════════════════
async function doLogin() {
  const username = $('loginUsername').value.trim();
  const password = $('loginPassword').value;
  $('loginError').classList.remove('show');
  if (!username || !password) {
    $('loginError').textContent = 'Enter username and password';
    $('loginError').classList.add('show');
    return;
  }
  try {
    const res = await fetch(API + '/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      $('loginError').textContent = data.error || 'Login failed';
      $('loginError').classList.add('show');
      return;
    }
    TOKEN = data.token;
    CURRENT_USER = data.user;
    localStorage.setItem('vb_token', TOKEN);
    localStorage.setItem('vb_user', JSON.stringify(CURRENT_USER));
    boot();
  } catch (e) {
    $('loginError').textContent = 'Could not reach server';
    $('loginError').classList.add('show');
  }
}

function doLogout() {
  TOKEN = null; CURRENT_USER = null;
  localStorage.removeItem('vb_token');
  localStorage.removeItem('vb_user');
  $('appShell').style.display = 'none';
  $('loginScreen').style.display = 'flex';
}

// Allow Enter key to submit login
document.addEventListener('DOMContentLoaded', () => {
  ['loginUsername', 'loginPassword'].forEach(id => {
    $(id).addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  });
  tryAutoLogin();
});

function tryAutoLogin() {
  const savedUser = localStorage.getItem('vb_user');
  if (TOKEN && savedUser) {
    CURRENT_USER = JSON.parse(savedUser);
    boot();
  }
}

async function boot() {
  $('loginScreen').style.display = 'none';
  $('appShell').style.display = 'flex';
  $('userName').textContent = CURRENT_USER.name;
  $('userAv').textContent = (CURRENT_USER.name || '?').charAt(0).toUpperCase();
  $('webhookUrlDisplay').textContent = window.location.origin + '/api/whatsapp/webhook';

  await loadExecutives(); // other renders look up executive names, so this goes first
  await Promise.all([
    loadVisitClients(), loadActiveClients(), loadMeetings(), loadFollowups(),
    loadSwaData(), loadSwaSelected(), checkWaStatus(), checkAiStatus(),
  ]);
  showPage('visits');
}

async function loadExecutives() {
  STATE.executives = await api('GET', '/executives');
}

// ════════════════════════ NAVIGATION ════════════════════════
const PAGE_META = {
  visits: { title: 'Client Visits', desc: 'Field visits with area tracking' },
  followups: { title: "Today's Follow-ups", desc: 'Due today or overdue' },
  active: { title: 'Active Clients', desc: 'Your regular clients' },
  meetings: { title: 'Meetings', desc: 'Scheduled meetings' },
  swadata: { title: 'Swa Data', desc: 'Imported pending list' },
  swaselected: { title: 'Swa Selected', desc: 'Moved & sent batches' },
  walog: { title: 'WhatsApp Log', desc: 'Message delivery history' },
  reports: { title: 'Reports', desc: 'Performance overview' },
  settings: { title: 'Settings', desc: 'WhatsApp API & account' },
};

function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  $('page-' + id).classList.add('active');
  const navEl = document.querySelector(`.nav-item[data-page="${id}"]`);
  if (navEl) navEl.classList.add('active');
  $('pageTitle').textContent = PAGE_META[id].title;
  $('pageDesc').textContent = PAGE_META[id].desc;

  if (id === 'followups') loadFollowups();
  if (id === 'walog') loadWaLog();
  if (id === 'reports') loadReports();
  if (id === 'settings') loadSettingsPage();
}

function toggleUserMenu() {
  if (confirm((CURRENT_USER ? CURRENT_USER.name : 'User') + ' — log out?')) doLogout();
}

function closeModal(id) { $(id).classList.remove('open'); }
function openModalEl(id) { $(id).classList.add('open'); }

// ════════════════════════ SHARED HELPERS ════════════════════════
function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function statusTagClass(status) {
  const s = (status || '').toLowerCase();
  return s;
}

function todayISO() { return new Date().toISOString().split('T')[0]; }

function fillAreaOptions(selectEl, list, keepValue) {
  const areas = [...new Set(list.map(c => c.area).filter(Boolean))].sort();
  const cur = keepValue ? selectEl.value : '';
  selectEl.innerHTML = '<option value="">All Areas</option>' + areas.map(a => `<option ${a === cur ? 'selected' : ''}>${escapeHtml(a)}</option>`).join('');
}

function fillDatalist(dlEl, list, field) {
  const vals = [...new Set(list.map(c => c[field]).filter(Boolean))].sort();
  dlEl.innerHTML = vals.map(v => `<option value="${escapeHtml(v)}">`).join('');
}

// Generic CSV/Excel parsing → array of lowercase-snake-case-keyed row objects
function parseImportFile(file, onRows) {
  const isExcel = /\.xlsx$|\.xls$/i.test(file.name);
  const reader = new FileReader();
  reader.onload = e => {
    try {
      let rows = [];
      if (isExcel) {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const raw = XLSX.utils.sheet_to_json(ws, { defval: '' });
        rows = raw.map(normalizeRowKeys);
      } else {
        const parsed = parseCSV(e.target.result);
        if (parsed) rows = parsed.rows.map(normalizeRowKeys);
      }
      onRows(rows);
    } catch (err) {
      toast('❌ Import error: ' + err.message, 'error');
    }
  };
  if (isExcel) reader.readAsArrayBuffer(file); else reader.readAsText(file, 'UTF-8');
}

function normalizeRowKeys(row) {
  const out = {};
  Object.keys(row).forEach(k => {
    const nk = k.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    out[nk] = row[k] != null ? String(row[k]).trim() : '';
  });
  return out;
}

function parseCSV(text) {
  function parseLine(line) {
    const out = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += ch; }
      else { if (ch === '"') inQ = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; }
    }
    out.push(cur); return out;
  }
  const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim());
  if (lines.length < 2) return null;
  const headers = parseLine(lines[0]).map(h => h.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseLine(lines[i]);
    const rec = {};
    headers.forEach((h, j) => { rec[h] = (vals[j] !== undefined ? vals[j] : '').trim(); });
    rows.push(rec);
  }
  return { headers, rows };
}

function downloadCSV(filename, csvText) {
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

function makeCSV(cols, data) {
  const header = cols.map(c => c.toUpperCase().replace(/_/g, ' ')).join(',');
  const rows = data.map(r => cols.map(k => {
    let v = r[k] != null ? String(r[k]) : '';
    if (v.includes(',') || v.includes('"') || v.includes('\n')) v = '"' + v.replace(/"/g, '""') + '"';
    return v;
  }).join(','));
  return [header, ...rows].join('\n');
}

function exportTable(which) {
  const map = {
    visit_clients: { cols: ['name', 'area', 'address', 'landmark', 'location', 'phone', 'business', 'last_visit', 'status', 'remarks', 'follow_up_date'], data: STATE.visitClients, file: 'Visit_Clients.csv' },
    active_clients: { cols: ['name', 'area', 'address', 'landmark', 'location', 'phone', 'business', 'monthly_value', 'status', 'remarks'], data: STATE.activeClients, file: 'Active_Clients.csv' },
    swa_selected: { cols: ['sr', 'company', 'client', 'phone', 'address', 'remarks', 'sent_to_number', 'batch_id', 'moved_at'], data: STATE.swaSelected, file: 'Swa_Selected.csv' },
  };
  const cfg = map[which];
  if (!cfg) return;
  downloadCSV(cfg.file, makeCSV(cfg.cols, cfg.data));
}

// ════════════════════════ PAGE 1: VISIT CLIENTS ════════════════════════
async function loadVisitClients() {
  STATE.visitClients = await api('GET', '/visit-clients');
  renderVisitClients();
}

function renderVisitClients() {
  const q = ($('vc_search')?.value || '').toLowerCase();
  const area = $('vc_area_filter')?.value || '';
  const lead = $('vc_lead_filter')?.value || '';
  fillAreaOptions($('vc_area_filter'), STATE.visitClients, true);

  const filtered = STATE.visitClients.filter(c => {
    const mq = !q || (c.name || '').toLowerCase().includes(q) || (c.company || '').toLowerCase().includes(q) || (c.area || '').toLowerCase().includes(q) || (c.phone || '').includes(q);
    const ma = !area || c.area === area;
    const ml = !lead || c.lead_status === lead;
    return mq && ma && ml;
  });

  const tbody = $('visitClientBody');
  tbody.innerHTML = filtered.map((c, i) => `
    <tr class="clickable-row" onclick="rowClickGuard(event, () => openDetailPopup('visit_clients', ${c.id}))">
      <td class="cell-muted">${i + 1}</td>
      <td class="cell-name">${escapeHtml(c.name)}</td>
      <td class="cell-muted">${escapeHtml(c.company) || '—'}</td>
      <td>${c.area ? `<span class="tag area">${escapeHtml(c.area)}</span>` : '—'}</td>
      <td>${c.phone ? `<a href="tel:${c.phone}" class="cell-phone" onclick="event.stopPropagation()">${escapeHtml(c.phone)}</a>` : '—'}</td>
      <td><span class="tag ${(c.lead_status || 'cold').toLowerCase()}">${escapeHtml(c.lead_status) || 'Cold'}</span></td>
      <td class="cell-muted">${escapeHtml(c.last_visit) || '—'}</td>
      <td class="cell-muted">${c.follow_up_date ? escapeHtml(c.follow_up_date) : '—'}</td>
      <td class="cell-muted" style="max-width:200px;white-space:normal">${escapeHtml(c.remarks) || ''}</td>
      <td onclick="event.stopPropagation()">${rowActionMenu('vc', c)}</td>
    </tr>`).join('') || `<tr class="empty-row"><td colspan="10">No visit clients yet — click "+ Add Client" to start.</td></tr>`;
}

// Row action menu HTML — used for both Visit Clients ('vc') and Active Clients ('ac')
function rowActionMenu(prefix, c) {
  const menuId = `menu_${prefix}_${c.id}`;
  const items = [];
  items.push(`<button onclick="closeAllActionMenus();openLogVisitModal('${prefix === 'vc' ? 'visit_clients' : 'active_clients'}', ${c.id}, '${escapeHtml(c.name).replace(/'/g, "\\'")}'  )">📝 Log a Visit</button>`);
  if (c.phone) items.push(`<button onclick="closeAllActionMenus();openWaSendModal('${prefix === 'vc' ? 'visit_clients' : 'active_clients'}', ${c.id})">💬 Send WhatsApp</button>`);
  items.push(`<button onclick="closeAllActionMenus();${prefix === 'vc' ? 'openVisitClientModal' : 'openActiveClientModal'}(${c.id})">✏️ Edit</button>`);
  if (prefix === 'vc') {
    items.push(`<button onclick="closeAllActionMenus();markConverted(${c.id})">⭐ Mark Converted</button>`);
  } else {
    items.push(`<button onclick="closeAllActionMenus();openOrderModal(${c.id})">🧾 Add Order</button>`);
  }
  items.push(`<div class="sep"></div>`);
  items.push(`<button class="danger" onclick="closeAllActionMenus();${prefix === 'vc' ? 'deleteVisitClient' : 'deleteActiveClient'}(${c.id})">🗑️ Delete</button>`);

  return `<div class="action-menu-wrap">
    <button class="action-dots-btn" onclick="toggleActionMenu(event, '${menuId}')">⋮</button>
    <div class="action-dropdown" id="${menuId}">${items.join('')}</div>
  </div>`;
}

function toggleActionMenu(evt, menuId) {
  evt.stopPropagation();
  const isOpen = $(menuId).classList.contains('open');
  closeAllActionMenus();
  if (!isOpen) $(menuId).classList.add('open');
}
function closeAllActionMenus() {
  document.querySelectorAll('.action-dropdown.open').forEach(d => d.classList.remove('open'));
}
document.addEventListener('click', closeAllActionMenus);

// Prevents row-click (open detail) from firing when the click originated inside
// an interactive element (button/link/menu) that already handled itself.
function rowClickGuard(evt, fn) {
  if (evt.target.closest('.action-menu-wrap, a, button, input')) return;
  fn();
}

function openVisitClientModal(id) {
  const c = id ? STATE.visitClients.find(x => x.id === id) : {};
  $('vcModalTitle').textContent = id ? 'Edit Visit Client' : 'Add Visit Client';
  $('vc_id').value = id || '';
  $('vc_name').value = c.name || '';
  $('vc_company').value = c.company || '';
  $('vc_area').value = c.area || '';
  $('vc_phone').value = c.phone || '';
  $('vc_address').value = c.address || '';
  $('vc_last_visit').value = c.last_visit || todayISO();
  $('vc_follow_up_date').value = c.follow_up_date || '';
  $('vc_lead_status').value = c.lead_status || 'Cold';
  $('vc_remarks').value = c.remarks || '';
  fillDatalist($('areaListVC'), STATE.visitClients, 'area');
  openModalEl('modalVisitClient');
}

// sendAfterSave: if true, opens the WhatsApp send modal for this client right after
// saving — the "Save & Send WhatsApp" button, using the phone number just typed in.
async function saveVisitClient(sendAfterSave) {
  const id = $('vc_id').value;
  const payload = {
    name: $('vc_name').value.trim(), company: $('vc_company').value.trim(), area: $('vc_area').value.trim(), phone: $('vc_phone').value.trim(),
    address: $('vc_address').value.trim(), last_visit: $('vc_last_visit').value, follow_up_date: $('vc_follow_up_date').value || null,
    lead_status: $('vc_lead_status').value, remarks: $('vc_remarks').value.trim(),
  };
  if (!payload.name) { toast('Name is required', 'error'); return; }
  if (sendAfterSave && !payload.phone) { toast('Add a phone number first to send WhatsApp', 'error'); return; }

  let savedRecord;
  if (id) savedRecord = await api('PUT', '/visit-clients/' + id, payload);
  else savedRecord = await api('POST', '/visit-clients', payload);

  closeModal('modalVisitClient');
  await loadVisitClients();
  await loadFollowups();
  toast('✅ Visit client saved');

  if (sendAfterSave && savedRecord && savedRecord.id) {
    openWaSendModal('visit_clients', savedRecord.id);
  }
}

async function deleteVisitClient(id) {
  if (!confirm('Delete this client? This also removes their visit history.')) return;
  await api('DELETE', '/visit-clients/' + id);
  await loadVisitClients();
  toast('🗑️ Deleted');
}

// ── Mark Converted: moves a Visit Client to Active Clients, carrying visit history ──
function markConverted(visitClientId) {
  const c = STATE.visitClients.find(x => x.id === visitClientId);
  if (!c) return;
  $('cv_visit_client_id').value = visitClientId;
  $('cv_client_name_display').textContent = `Moving "${c.name}" to Active Clients — their visit history will carry over.`;
  $('cv_monthly_value').value = 0;
  $('cv_grade').value = '';
  fillExecutiveSelect($('cv_converted_by'));
  openModalEl('modalConvert');
}

async function confirmMarkConverted() {
  const visitClientId = $('cv_visit_client_id').value;
  const c = STATE.visitClients.find(x => x.id == visitClientId);
  const payload = {
    converted_by: $('cv_converted_by').value || null,
    grade: $('cv_grade').value || null,
    monthly_value: parseFloat($('cv_monthly_value').value) || 0,
  };
  try {
    await api('POST', `/visit-logs/convert/${visitClientId}`, payload);
    closeModal('modalConvert');
    await loadVisitClients();
    await loadActiveClients();
    await loadFollowups();
    toast(`⭐ ${c ? c.name : 'Client'} moved to Active Clients`);
    showPage('active');
  } catch (e) { /* already toasted */ }
}

async function importFile(event, table) {
  const file = event.target.files[0];
  if (!file) return;
  parseImportFile(file, async rows => {
    const valid = rows.filter(r => r.name);
    if (!valid.length) { toast('⚠️ No valid rows found (need a "name" column)', 'error'); return; }
    const endpoint = table === 'visit_clients' ? '/visit-clients/bulk-import' : '/active-clients/bulk-import';
    const result = await api('POST', endpoint, { rows: valid });
    toast(`✅ Import done — ${result.added} added, ${result.updated} updated`);
    if (table === 'visit_clients') await loadVisitClients(); else await loadActiveClients();
  });
  event.target.value = '';
}

// Downloadable blank CSV templates matching each page's import format exactly
function downloadImportTemplate(table) {
  const templates = {
    visit_clients: { file: 'Visit_Clients_Import_Template.csv', cols: ['name', 'company', 'area', 'phone', 'address', 'last_visit', 'follow_up_date', 'lead_status', 'remarks'], sample: ['Ramesh Patel', 'Ramesh Textiles', 'Varachha', '919876543210', 'Ring Road', '2026-06-21', '2026-06-28', 'Hot', 'Interested in silk sarees'] },
    active_clients: { file: 'Active_Clients_Import_Template.csv', cols: ['name', 'company', 'area', 'phone', 'business', 'address', 'monthly_value', 'grade', 'status', 'remarks'], sample: ['Suresh Textiles', 'Suresh & Co', 'Katargam', '919123456780', 'Wholesale', 'Main Market', '15000', 'A', 'Active', 'Regular bulk buyer'] },
    swa_data: { file: 'Swa_Data_Import_Template.csv', cols: ['sr', 'company', 'client', 'phone', 'address', 'remarks'], sample: ['1', 'ABC Textiles', 'Mr Patel', '919876500000', 'Ring Road', 'Urgent'] },
  };
  const t = templates[table];
  if (!t) return;
  const csv = t.cols.map(c => c.toUpperCase()).join(',') + '\n' + t.sample.join(',');
  downloadCSV(t.file, csv);
  toast('📄 Template downloaded — fill it in and use Import');
}

// ════════════════════════ PAGE 3: ACTIVE CLIENTS ════════════════════════
async function loadActiveClients() {
  STATE.activeClients = await api('GET', '/active-clients');
  renderActiveClients();
}

function renderActiveClients() {
  const q = ($('ac_search')?.value || '').toLowerCase();
  const area = $('ac_area_filter')?.value || '';
  const convertedBy = $('ac_converted_by_filter')?.value || '';
  fillAreaOptions($('ac_area_filter'), STATE.activeClients, true);
  fillConvertedByFilter();

  const filtered = STATE.activeClients.filter(c => {
    const mq = !q || (c.name || '').toLowerCase().includes(q) || (c.company || '').toLowerCase().includes(q) || (c.area || '').toLowerCase().includes(q) || (c.phone || '').includes(q);
    const mc = !convertedBy || String(c.converted_by) === convertedBy;
    return mq && (!area || c.area === area) && mc;
  });

  const tbody = $('activeClientBody');
  tbody.innerHTML = filtered.map((c, i) => `
    <tr class="clickable-row" onclick="rowClickGuard(event, () => openDetailPopup('active_clients', ${c.id}))">
      <td class="cell-muted">${i + 1}</td>
      <td class="cell-name">${escapeHtml(c.name)}</td>
      <td class="cell-muted">${escapeHtml(c.company) || '—'}</td>
      <td>${c.area ? `<span class="tag area">${escapeHtml(c.area)}</span>` : '—'}</td>
      <td>${c.phone ? `<a href="tel:${c.phone}" class="cell-phone" onclick="event.stopPropagation()">${escapeHtml(c.phone)}</a>` : '—'}</td>
      <td>${c.grade ? `<span class="tag grade-${c.grade.toLowerCase()}">${escapeHtml(c.grade)}</span>` : '—'}</td>
      <td style="font-weight:700;color:var(--accent-dark)">${c.monthly_value ? '₹' + Number(c.monthly_value).toLocaleString('en-IN') : '—'}</td>
      <td class="cell-muted" id="ac_order_total_${c.id}">…</td>
      <td class="cell-muted">${executiveName(c.converted_by)}</td>
      <td onclick="event.stopPropagation()">${rowActionMenu('ac', c)}</td>
    </tr>`).join('') || `<tr class="empty-row"><td colspan="10">No active clients yet.</td></tr>`;

  // Lazy-load order totals per row (best-effort, doesn't block table render)
  filtered.forEach(async c => {
    try {
      const orders = await api('GET', `/orders?active_client_id=${c.id}`);
      const total = orders.reduce((s, o) => s + (o.total_amount || 0), 0);
      const el = $('ac_order_total_' + c.id);
      if (el) el.textContent = orders.length ? `₹${total.toLocaleString('en-IN')} (${orders.length})` : '—';
    } catch (e) { /* ignore */ }
  });
}

function executiveName(id) {
  if (!id) return '—';
  const ex = STATE.executives.find(e => e.id === id);
  return ex ? ex.name : '—';
}

function fillConvertedByFilter() {
  const sel = $('ac_converted_by_filter');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">All Converted By</option>' + STATE.executives.map(e =>
    `<option value="${e.id}" ${String(e.id) === cur ? 'selected' : ''}>${escapeHtml(e.name)}</option>`).join('');
}

function fillExecutiveSelect(selectEl, keepValue) {
  const cur = keepValue ? selectEl.value : '';
  selectEl.innerHTML = '<option value="">—</option>' + STATE.executives.filter(e => e.active).map(e =>
    `<option value="${e.id}" ${String(e.id) === cur ? 'selected' : ''}>${escapeHtml(e.name)}</option>`).join('');
}

function openActiveClientModal(id) {
  const c = id ? STATE.activeClients.find(x => x.id === id) : {};
  $('acModalTitle').textContent = id ? 'Edit Active Client' : 'Add Active Client';
  $('ac_id').value = id || '';
  $('ac_name').value = c.name || '';
  $('ac_company').value = c.company || '';
  $('ac_area').value = c.area || '';
  $('ac_phone').value = c.phone || '';
  $('ac_business').value = c.business || '';
  $('ac_address').value = c.address || '';
  $('ac_monthly').value = c.monthly_value || '';
  $('ac_grade').value = c.grade || '';
  $('ac_status').value = c.status || 'Active';
  $('ac_remarks').value = c.remarks || '';
  fillDatalist($('areaListAC'), STATE.activeClients, 'area');
  fillExecutiveSelect($('ac_converted_by'));
  $('ac_converted_by').value = c.converted_by || '';
  openModalEl('modalActiveClient');
}

async function saveActiveClient(sendAfterSave) {
  const id = $('ac_id').value;
  const payload = {
    name: $('ac_name').value.trim(), company: $('ac_company').value.trim(), area: $('ac_area').value.trim(), phone: $('ac_phone').value.trim(),
    business: $('ac_business').value.trim(), address: $('ac_address').value.trim(),
    monthly_value: parseFloat($('ac_monthly').value) || 0, grade: $('ac_grade').value || null,
    converted_by: $('ac_converted_by').value || null,
    status: $('ac_status').value, remarks: $('ac_remarks').value.trim(),
  };
  if (!payload.name) { toast('Name is required', 'error'); return; }
  if (sendAfterSave && !payload.phone) { toast('Add a phone number first to send WhatsApp', 'error'); return; }

  let savedRecord;
  if (id) savedRecord = await api('PUT', '/active-clients/' + id, payload);
  else savedRecord = await api('POST', '/active-clients', payload);

  closeModal('modalActiveClient');
  await loadActiveClients();
  toast('✅ Active client saved');

  if (sendAfterSave && savedRecord && savedRecord.id) {
    openWaSendModal('active_clients', savedRecord.id);
  }
}

async function deleteActiveClient(id) {
  if (!confirm('Delete this client? This also removes their order and visit history.')) return;
  await api('DELETE', '/active-clients/' + id);
  await loadActiveClients();
  toast('🗑️ Deleted');
}

// ════════════════════════ VISIT LOGS (multi-entry history) ════════════════════════
let LOG_VISIT_CONTEXT = null;

function openLogVisitModal(clientTable, clientId, clientName) {
  LOG_VISIT_CONTEXT = { clientTable, clientId };
  $('lv_client_id').value = clientId;
  $('lv_client_table').value = clientTable;
  $('lv_client_name_display').textContent = `Logging a visit for: ${clientName}`;
  $('lv_visit_date').value = todayISO();
  $('lv_next_followup').value = '';
  $('lv_lead_status').value = 'Hot';
  $('lv_remarks').value = '';
  $('lv_ai_followup_result').className = 'ai-suggestion-box';
  $('lv_ai_status_result').className = 'ai-suggestion-box';
  $('lv_ai_followup_box').style.display = AI_CONFIGURED ? 'block' : 'none';
  $('lv_ai_status_box').style.display = AI_CONFIGURED ? 'flex' : 'none';
  openModalEl('modalLogVisit');
}

async function saveVisitLog() {
  const payload = {
    client_id: parseInt($('lv_client_id').value),
    client_table: $('lv_client_table').value,
    visit_date: $('lv_visit_date').value,
    next_follow_up_date: $('lv_next_followup').value || null,
    lead_status: $('lv_lead_status').value,
    remarks: $('lv_remarks').value.trim(),
  };
  if (!payload.visit_date) { toast('Visit date is required', 'error'); return; }
  try {
    await api('POST', '/visit-logs', payload);
    closeModal('modalLogVisit');
    if (payload.client_table === 'visit_clients') { await loadVisitClients(); await loadFollowups(); }
    else { await loadActiveClients(); }
    toast('📝 Visit logged');
  } catch (e) { /* already toasted */ }
}



// ════════════════════════ PAGE 2: TODAY'S FOLLOW-UPS ════════════════════════
async function loadFollowups() {
  STATE.followups = await api('GET', '/followups');
  const badge = $('badgeFollowups');
  if (STATE.followups.length > 0) { badge.style.display = 'inline-block'; badge.textContent = STATE.followups.length; }
  else badge.style.display = 'none';
  renderFollowups();
}

// Groups today's follow-ups by area (already area-sorted by the backend) so a
// sales executive sees exactly the clients on their fixed daily route, together.
function renderFollowups() {
  const container = $('followupsContainer');
  if (!STATE.followups.length) {
    container.innerHTML = `<div style="padding:40px;text-align:center;color:var(--muted)">🎉 No follow-ups due today — you're all caught up!</div>`;
    updateFollowupSelCount();
    return;
  }

  const today = todayISO();
  const groups = {};
  STATE.followups.forEach(c => {
    const area = c.area || 'No Area';
    if (!groups[area]) groups[area] = [];
    groups[area].push(c);
  });

  container.innerHTML = Object.entries(groups).map(([area, clients]) => `
    <div class="panel-head" style="background:var(--paper-sunken);border-radius:0">
      <h3>📍 ${escapeHtml(area)} <span class="text-muted" style="font-weight:400;font-size:11px">(${clients.length})</span></h3>
    </div>
    <div class="table-scroll">
      <table>
        <thead><tr><th style="width:34px"><input type="checkbox" class="chk" onchange="followupAreaSelectAll(this,'${escapeHtml(area).replace(/'/g, "\\'")}')"></th><th>Name</th><th>Phone</th><th>Follow-up Date</th><th>Latest Remarks</th><th>WhatsApp</th><th>Log Visit</th></tr></thead>
        <tbody>
          ${clients.map(c => {
            const overdue = c.follow_up_date < today;
            return `
            <tr data-area="${escapeHtml(area)}">
              <td><input type="checkbox" class="chk followup-chk" data-id="${c.id}" onchange="updateFollowupSelCount()"></td>
              <td class="cell-name">${escapeHtml(c.name)}</td>
              <td>${c.phone ? `<a href="tel:${c.phone}" class="cell-phone">${escapeHtml(c.phone)}</a>` : '—'}</td>
              <td><span class="tag ${overdue ? 'failed' : 'pending'}">${escapeHtml(c.follow_up_date)}${overdue ? ' (overdue)' : ' (today)'}</span></td>
              <td class="cell-muted" style="max-width:220px;white-space:normal">${escapeHtml(c.remarks) || ''}</td>
              <td>${c.phone ? `<button class="wa-launch-btn" onclick="openWaSendModal('visit_clients', ${c.id})">💬</button>` : '—'}</td>
              <td><button class="btn btn-primary btn-sm" onclick="openLogVisitModal('visit_clients', ${c.id}, '${escapeHtml(c.name).replace(/'/g, "\\'")}')">📝 Log a Visit</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `).join('');
  updateFollowupSelCount();
}

function followupSelectAll(checked) {
  document.querySelectorAll('.followup-chk').forEach(c => c.checked = checked);
  updateFollowupSelCount();
}
function followupAreaSelectAll(headerChk, area) {
  document.querySelectorAll(`tr[data-area="${CSS.escape(area)}"] .followup-chk`).forEach(c => c.checked = headerChk.checked);
  updateFollowupSelCount();
}
function updateFollowupSelCount() {
  const n = document.querySelectorAll('.followup-chk:checked').length;
  $('fuSelCount').textContent = n;
  $('fuBulkSendBtn').disabled = n === 0;
}
function getSelectedFollowupIds() {
  return [...document.querySelectorAll('.followup-chk:checked')].map(c => parseInt(c.dataset.id));
}

// ── Bulk send: pick a template, send a summary of selected clients to ONE number.
//    This does NOT remove them from the list — only "Log a Visit" does that. ──
function openFollowupBulkSendModal() {
  const ids = getSelectedFollowupIds();
  if (!ids.length) { toast('Select at least one client first', 'error'); return; }
  $('fuBulkCount').textContent = ids.length;
  $('fuTargetNumber').value = '';
  populateTemplateSelect($('fuBulkTemplate'));
  $('fuBulkConfigWarning').style.display = WA_CONFIGURED ? 'none' : 'flex';
  renderFollowupBulkPreview();
  openModalEl('modalFollowupBulkSend');
}

function renderFollowupBulkPreview() {
  const ids = getSelectedFollowupIds();
  const clients = STATE.followups.filter(c => ids.includes(c.id));
  const tplName = $('fuBulkTemplate').value;
  const tpl = TEMPLATES.find(t => t.template_name === tplName);
  if (!tpl) { $('fuBulkPreview').textContent = 'Select a template…'; return; }
  const listText = clients.map((c, i) => `${i + 1}. ${c.name} | ${c.area || '-'} | ${c.phone || '-'} | due ${c.follow_up_date}`).join('\n');
  let body = tpl.body_text || '';
  body = body.replace('{{1}}', clients.length).replace('{{2}}', listText);
  $('fuBulkPreview').textContent = body || `(${clients.length} clients ready to send)`;
}

async function confirmFollowupBulkSend() {
  const ids = getSelectedFollowupIds();
  const targetNumber = $('fuTargetNumber').value.trim();
  const tplName = $('fuBulkTemplate').value;
  if (!targetNumber) { toast('Enter the target WhatsApp number', 'error'); return; }
  if (!tplName) { toast('Select a template', 'error'); return; }
  const tpl = TEMPLATES.find(t => t.template_name === tplName);
  const clients = STATE.followups.filter(c => ids.includes(c.id));
  const listText = clients.map((c, i) => `${i + 1}. ${c.name} | ${c.area || '-'} | ${c.phone || '-'} | due ${c.follow_up_date}`).join('\n');

  try {
    const result = await api('POST', '/whatsapp/send', {
      toRaw: targetNumber, templateName: tplName, language: tpl ? tpl.language : 'en',
      variables: [String(clients.length), listText], clientName: `Follow-ups batch (${clients.length})`, sourcePage: 'followups',
    });
    closeModal('modalFollowupBulkSend');
    if (result.success) toast(`✅ Sent follow-up summary for ${clients.length} clients`);
    else toast(`⚠️ Send failed: ${result.error}`, 'error');
  } catch (e) { /* already toasted */ }
}

// ════════════════════════ PAGE 4: MEETINGS ════════════════════════
async function loadMeetings() {
  const from = $('mt_from')?.value || '';
  const to = $('mt_to')?.value || '';
  const status = $('mt_status')?.value || '';
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  if (status) qs.set('status', status);
  STATE.meetings = await api('GET', '/meetings' + (qs.toString() ? '?' + qs.toString() : ''));
  renderMeetingsTable();
}
function renderMeetings() { loadMeetings(); }

function renderMeetingsTable() {
  const tbody = $('meetingsBody');
  tbody.innerHTML = STATE.meetings.map(m => `
    <tr>
      <td class="cell-muted">${escapeHtml(m.meeting_date)}</td>
      <td class="cell-muted">${escapeHtml(m.meeting_time) || '—'}</td>
      <td class="cell-name">${escapeHtml(m.client_name)}</td>
      <td>${m.area ? `<span class="tag area">${escapeHtml(m.area)}</span>` : '—'}</td>
      <td>${m.phone ? `<a href="tel:${m.phone}" class="cell-phone">${escapeHtml(m.phone)}</a>` : '—'}</td>
      <td class="cell-muted">${escapeHtml(m.notes) || ''}</td>
      <td><span class="tag ${statusTagClass(m.status)}">${escapeHtml(m.status)}</span></td>
      <td>${m.phone ? `<button class="wa-launch-btn" onclick="openWaSendModal('meetings', ${m.id})">💬</button>` : '—'}</td>
      <td class="row-actions">
        <button class="btn btn-secondary btn-sm" onclick="openMeetingModal(${m.id})">✏️</button>
        <button class="btn btn-danger btn-sm" onclick="deleteMeeting(${m.id})">🗑️</button>
      </td>
    </tr>`).join('') || `<tr class="empty-row"><td colspan="9">No meetings scheduled.</td></tr>`;
}

function openMeetingModal(id) {
  const m = id ? STATE.meetings.find(x => x.id === id) : {};
  $('mtModalTitle').textContent = id ? 'Edit Meeting' : 'Schedule Meeting';
  $('mt_id').value = id || '';
  $('mt_client').value = m.client_name || '';
  $('mt_phone').value = m.phone || '';
  $('mt_area').value = m.area || '';
  $('mt_date').value = m.meeting_date || todayISO();
  $('mt_time').value = m.meeting_time || '';
  $('mt_notes').value = m.notes || '';
  $('mt_status_sel').value = m.status || 'Scheduled';
  const allClients = [...STATE.visitClients, ...STATE.activeClients];
  $('clientListMT').innerHTML = [...new Set(allClients.map(c => c.name))].map(n => `<option value="${escapeHtml(n)}">`).join('');
  openModalEl('modalMeeting');
}

// Auto-fill phone/area when a known client name is typed into the meeting form
document.addEventListener('DOMContentLoaded', () => {
  $('mt_client').addEventListener('change', () => {
    const name = $('mt_client').value;
    const match = [...STATE.visitClients, ...STATE.activeClients].find(c => c.name === name);
    if (match) { $('mt_phone').value = match.phone || ''; $('mt_area').value = match.area || ''; }
  });
});

async function saveMeeting(sendAfterSave) {
  const id = $('mt_id').value;
  const payload = {
    client_name: $('mt_client').value.trim(), phone: $('mt_phone').value.trim(), area: $('mt_area').value.trim(),
    meeting_date: $('mt_date').value, meeting_time: $('mt_time').value, notes: $('mt_notes').value.trim(),
    status: $('mt_status_sel').value,
  };
  if (!payload.client_name || !payload.meeting_date) { toast('Client name and date are required', 'error'); return; }

  let savedRecord;
  if (id) savedRecord = await api('PUT', '/meetings/' + id, payload);
  else savedRecord = await api('POST', '/meetings', payload);

  closeModal('modalMeeting');
  await loadMeetings();
  toast('✅ Meeting saved');

  if (sendAfterSave && savedRecord && savedRecord.id) {
    openWaSendModal('meetings', savedRecord.id);
  }
}

async function deleteMeeting(id) {
  if (!confirm('Delete this meeting?')) return;
  await api('DELETE', '/meetings/' + id);
  await loadMeetings();
  toast('🗑️ Deleted');
}

// ════════════════════════ PAGE 5: SWA DATA ════════════════════════
async function loadSwaData() {
  STATE.swaData = await api('GET', '/swa/data');
  renderSwaData();
}

function renderSwaData() {
  const q = ($('swa_search')?.value || '').toLowerCase();
  const filtered = STATE.swaData.filter(r => {
    if (!q) return true;
    return (r.company || '').toLowerCase().includes(q) || (r.client || '').toLowerCase().includes(q) || (r.phone || '').includes(q);
  });
  const tbody = $('swaDataBody');
  tbody.innerHTML = filtered.map(r => `
    <tr>
      <td><input type="checkbox" class="chk swa-chk" data-id="${r.id}" onchange="updateSwaSelCount()"></td>
      <td class="cell-muted">${escapeHtml(r.sr)}</td>
      <td class="cell-name">${escapeHtml(r.company)}</td>
      <td>${escapeHtml(r.client)}</td>
      <td>${r.phone ? `<a href="tel:${r.phone}" class="cell-phone">${escapeHtml(r.phone)}</a>` : '—'}</td>
      <td class="cell-muted">${escapeHtml(r.address) || '—'}</td>
      <td class="cell-muted">${escapeHtml(r.remarks) || ''}</td>
      <td class="row-actions"><button class="btn btn-danger btn-sm" onclick="deleteSwaRow(${r.id})">🗑️</button></td>
    </tr>`).join('') || `<tr class="empty-row"><td colspan="8">No Swa data imported yet. Use "Import CSV/Excel" above.<br><span class="text-muted" style="font-size:11px">Expected columns: SR, COMPANY, CLIENT, PHONE, ADDRESS, REMARKS</span></td></tr>`;
  updateSwaSelCount();
}

function swaSelectAll(checked) {
  document.querySelectorAll('.swa-chk').forEach(c => c.checked = checked);
  $('swaChkAll').checked = checked;
  updateSwaSelCount();
}

function updateSwaSelCount() {
  const n = document.querySelectorAll('.swa-chk:checked').length;
  $('swaSelCount').textContent = n;
  $('swaSelCount2').textContent = n;
  $('swaMoveBtn').disabled = n === 0;
  $('swaIndivBtn').disabled = n === 0;
}

function getSelectedSwaIds() {
  return [...document.querySelectorAll('.swa-chk:checked')].map(c => parseInt(c.dataset.id));
}

async function deleteSwaRow(id) {
  if (!confirm('Delete this row?')) return;
  await api('DELETE', '/swa/data/' + id);
  await loadSwaData();
  toast('🗑️ Deleted');
}

async function importSwaFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  parseImportFile(file, async rows => {
    const valid = rows.filter(r => r.client || r.company);
    if (!valid.length) { toast('⚠️ No valid rows — need COMPANY or CLIENT column', 'error'); return; }
    const result = await api('POST', '/swa/data/bulk-import', { rows: valid });
    toast(`✅ Imported ${result.added} rows into Swa Data`);
    await loadSwaData();
  });
  event.target.value = '';
}

// ── Move & Send to ONE number flow ──
function openSwaMoveModal() {
  const ids = getSelectedSwaIds();
  if (!ids.length) { toast('Select at least one row first', 'error'); return; }
  $('swaMoveCount').textContent = ids.length;
  $('swaTargetNumber').value = '';
  populateTemplateSelect($('swaMoveTemplate'));
  $('swaMoveConfigWarning').style.display = WA_CONFIGURED ? 'none' : 'flex';
  renderSwaMovePreview();
  openModalEl('modalSwaMove');
}

function renderSwaMovePreview() {
  const ids = getSelectedSwaIds();
  const rows = STATE.swaData.filter(r => ids.includes(r.id));
  const tplName = $('swaMoveTemplate').value;
  const tpl = TEMPLATES.find(t => t.template_name === tplName);
  if (!tpl) { $('swaMovePreview').textContent = 'Select a template…'; return; }
  const listText = rows.map((r, i) => `${i + 1}. ${r.company || '-'} | ${r.client || '-'} | ${r.phone || '-'} | ${r.address || '-'} | ${r.remarks || '-'}`).join('\n');
  let body = tpl.body_text || '';
  body = body.replace('{{1}}', rows.length).replace('{{2}}', listText);
  $('swaMovePreview').textContent = body || `(${rows.length} rows ready to send)`;
}

async function confirmSwaMoveAndSend() {
  const ids = getSelectedSwaIds();
  const targetNumber = $('swaTargetNumber').value.trim();
  const tplName = $('swaMoveTemplate').value;
  if (!targetNumber) { toast('Enter the target WhatsApp number', 'error'); return; }
  if (!tplName) { toast('Select a template', 'error'); return; }
  const tpl = TEMPLATES.find(t => t.template_name === tplName);
  try {
    const result = await api('POST', '/swa/move-and-send', {
      ids, targetNumber, templateName: tplName, language: tpl ? tpl.language : 'en',
    });
    closeModal('modalSwaMove');
    await loadSwaData();
    await loadSwaSelected();
    if (result.success) toast(`✅ Moved ${result.moved} rows and sent WhatsApp message`);
    else toast(`⚠️ Moved ${result.moved} rows, but WhatsApp send failed: ${result.sendResult.error || 'unknown error'}`, 'error');
  } catch (e) { /* api() already toasted */ }
}

// ── Send Individually flow: each selected row -> its own message, its own phone ──
const SWA_FIELD_OPTIONS = [
  { value: 'sr', label: 'SR' }, { value: 'company', label: 'Company' }, { value: 'client', label: 'Client' },
  { value: 'phone', label: 'Phone' }, { value: 'address', label: 'Address' }, { value: 'remarks', label: 'Remarks' },
];

function openSwaIndividualSendModal() {
  const ids = getSelectedSwaIds();
  if (!ids.length) { toast('Select at least one row first', 'error'); return; }
  const rows = STATE.swaData.filter(r => ids.includes(r.id));
  if (rows.some(r => !r.phone)) {
    toast('⚠️ One or more selected rows has no phone number — every row needs one to send individually', 'error');
    return;
  }
  $('swaIndivCount').textContent = ids.length;
  populateTemplateSelect($('swaIndivTemplate'));
  $('swaIndivConfigWarning').style.display = WA_CONFIGURED ? 'none' : 'flex';
  renderSwaIndividualMapping();
  openModalEl('modalSwaIndividual');
}

function renderSwaIndividualMapping() {
  const tplName = $('swaIndivTemplate').value;
  const tpl = TEMPLATES.find(t => t.template_name === tplName);
  const container = $('swaIndivMappingContainer');
  if (!tpl) { container.innerHTML = ''; $('swaIndivPreview').textContent = 'Select a template…'; return; }

  const optionsHtml = SWA_FIELD_OPTIONS.map(f => `<option value="${f.value}">${f.label}</option>`).join('');
  container.innerHTML = Array.from({ length: tpl.variable_count }, (_, i) => `
    <div class="field" style="margin-bottom:8px">
      <label>{{${i + 1}}} comes from</label>
      <select class="swa-map-input" data-pos="${i + 1}" onchange="renderSwaIndividualPreview()">${optionsHtml}</select>
    </div>`).join('');

  // Sensible defaults: 1=company, 2=client, 3=phone, 4=address, 5=remarks
  const defaults = ['company', 'client', 'phone', 'address', 'remarks'];
  container.querySelectorAll('.swa-map-input').forEach((sel, i) => { sel.value = defaults[i] || 'remarks'; });

  renderSwaIndividualPreview();
}

function getSwaFieldMapping() {
  const mapping = {};
  document.querySelectorAll('.swa-map-input').forEach(sel => { mapping[sel.dataset.pos] = sel.value; });
  return mapping;
}

function renderSwaIndividualPreview() {
  const ids = getSelectedSwaIds();
  const rows = STATE.swaData.filter(r => ids.includes(r.id));
  if (!rows.length) return;
  const tplName = $('swaIndivTemplate').value;
  const tpl = TEMPLATES.find(t => t.template_name === tplName);
  if (!tpl) return;
  const mapping = getSwaFieldMapping();
  let body = tpl.body_text || '';
  Object.entries(mapping).forEach(([pos, field]) => {
    body = body.split(`{{${pos}}}`).join(rows[0][field] || '');
  });
  $('swaIndivPreview').textContent = body;
}

async function confirmSwaIndividualSend() {
  const ids = getSelectedSwaIds();
  const tplName = $('swaIndivTemplate').value;
  if (!tplName) { toast('Select a template', 'error'); return; }
  const tpl = TEMPLATES.find(t => t.template_name === tplName);
  const mapping = getSwaFieldMapping();
  try {
    const result = await api('POST', '/swa/move-and-send-individual', {
      ids, templateName: tplName, language: tpl ? tpl.language : 'en', fieldMapping: mapping,
    });
    closeModal('modalSwaIndividual');
    await loadSwaData();
    await loadSwaSelected();
    if (result.success) toast(`✅ Sent ${result.sent} individual messages, moved ${result.moved} rows`);
    else toast(`⚠️ Sent ${result.sent}/${result.moved}, ${result.failed} failed — check WA Log for details`, 'error');
  } catch (e) { /* already toasted */ }
}

// ════════════════════════ PAGE 6: SWA SELECTED ════════════════════════
async function loadSwaSelected() {
  STATE.swaSelected = await api('GET', '/swa/selected');
  renderSwaSelected();
}

function renderSwaSelected() {
  const areaFilter = $('swasel_area_filter')?.value || '';

  // Populate the AI-area filter dropdown from whatever areas have been sorted so far
  const areas = [...new Set(STATE.swaSelected.map(r => r.ai_area).filter(Boolean))].sort();
  const sel = $('swasel_area_filter');
  if (sel) {
    const cur = sel.value;
    sel.innerHTML = '<option value="">All AI Areas</option>' + areas.map(a => `<option ${a === cur ? 'selected' : ''}>${escapeHtml(a)}</option>`).join('');
  }

  const filtered = areaFilter ? STATE.swaSelected.filter(r => r.ai_area === areaFilter) : STATE.swaSelected;

  const tbody = $('swaSelectedBody');
  tbody.innerHTML = filtered.map(r => `
    <tr>
      <td class="cell-muted">${escapeHtml(r.sr)}</td>
      <td class="cell-name">${escapeHtml(r.company)}</td>
      <td>${escapeHtml(r.client)}</td>
      <td>${escapeHtml(r.phone) || '—'}</td>
      <td class="cell-muted">${escapeHtml(r.address) || '—'}</td>
      <td>${r.ai_area ? `<span class="tag area">${escapeHtml(r.ai_area)}</span>` : '<span class="text-muted" style="font-size:11px">not sorted</span>'}</td>
      <td class="cell-muted">${escapeHtml(r.remarks) || ''}</td>
      <td class="cell-phone">${escapeHtml(r.sent_to_number)}</td>
      <td><span class="tag pending" id="swaWaStatus_${r.id}">—</span></td>
      <td class="cell-muted">${escapeHtml(r.moved_at)}</td>
      <td class="row-actions"><button class="btn btn-secondary btn-sm" onclick="restoreSwaRow(${r.id})" title="Move back to Swa Data">↩️</button></td>
    </tr>`).join('') || `<tr class="empty-row"><td colspan="11">Nothing here yet. Select rows in Swa Data and send them.</td></tr>`;
}

async function aiSortSwaSelectedByArea() {
  if (!AI_CONFIGURED) { toast('Connect OpenAI in Settings → AI Features first', 'error'); return; }
  toast('✨ Sorting by area, this may take a moment…');
  try {
    const result = await api('POST', '/swa/selected/ai-sort-by-area');
    await loadSwaSelected();
    if (result.updated === 0 && result.message) toast(result.message);
    else toast(`✅ Sorted ${result.updated} of ${result.total} rows by area`);
  } catch (e) { /* already toasted */ }
}

async function restoreSwaRow(id) {
  if (!confirm('Move this row back to Swa Data?')) return;
  await api('POST', `/swa/selected/${id}/restore`);
  await loadSwaData();
  await loadSwaSelected();
  toast('↩️ Moved back to Swa Data');
}

// ════════════════════════ WHATSAPP CORE ════════════════════════
async function checkWaStatus() {
  try {
    const settings = await api('GET', '/whatsapp/settings');
    WA_CONFIGURED = !!settings.configured;
    const dot = $('waDot'), label = $('waDotLabel');
    if (WA_CONFIGURED) { dot.className = 'dot ok'; label.textContent = 'WhatsApp connected'; }
    else { dot.className = 'dot bad'; label.textContent = 'WhatsApp not connected'; }
    if (WA_CONFIGURED) await loadTemplates();
  } catch (e) {
    $('waDot').className = 'dot bad';
    $('waDotLabel').textContent = 'WhatsApp check failed';
  }
}

async function loadTemplates() {
  TEMPLATES = await api('GET', '/whatsapp/templates');
}

function populateTemplateSelect(selectEl) {
  if (!TEMPLATES.length) {
    selectEl.innerHTML = '<option value="">No templates synced — go to Settings</option>';
    return;
  }
  selectEl.innerHTML = TEMPLATES.map(t => `<option value="${escapeHtml(t.template_name)}">${escapeHtml(t.template_name)} (${escapeHtml(t.category || '')})</option>`).join('');
}

// Maps a client record's fields to {{1}}, {{2}}, ... positions.
// Default convention used across this app: {{1}}=name, {{2}}=area, {{3}}=business/extra, {{4}}=remarks
// You can adjust this mapping to match your actual approved templates' variable order.
function buildVariablesForClient(client, varCount) {
  const pool = [client.name || client.client_name || '', client.area || '', client.business || client.notes || '', client.remarks || '', client.last_visit || client.meeting_date || ''];
  return pool.slice(0, varCount || 2);
}

let WA_SEND_CONTEXT = null; // { sourceTable, recordId }

function openWaSendModal(sourceTable, recordId) {
  let record;
  if (sourceTable === 'visit_clients') record = STATE.visitClients.find(c => c.id === recordId);
  else if (sourceTable === 'active_clients') record = STATE.activeClients.find(c => c.id === recordId);
  else if (sourceTable === 'meetings') record = STATE.meetings.find(c => c.id === recordId);
  if (!record) return;

  WA_SEND_CONTEXT = { sourceTable, recordId, record };
  $('waSendTo').value = record.phone || '';
  populateTemplateSelect($('waSendTemplate'));
  $('waSendConfigWarning').style.display = WA_CONFIGURED ? 'none' : 'flex';
  $('waAiDraftBtn').style.display = (AI_CONFIGURED && record.remarks && sourceTable !== 'meetings') ? 'inline-flex' : 'none';
  renderWaPreview();
  openModalEl('modalWaSend');
}

async function useAiDraftForWaSend() {
  if (!WA_SEND_CONTEXT) return;
  const record = WA_SEND_CONTEXT.record;
  const name = record.name || record.client_name || '';
  $('waAiDraftBtn').disabled = true;
  $('waAiDraftBtn').textContent = '✨ Drafting…';
  const draft = await aiDraftMessageFromRemarks(record.remarks, name);
  $('waAiDraftBtn').disabled = false;
  $('waAiDraftBtn').textContent = '✨ AI: Draft from latest visit remarks';
  if (draft) {
    // Show the AI draft as a free-form preview note above the template preview —
    // the actual send still uses the approved template (Meta requires this), but
    // this gives a ready-to-copy alternative for manual/outside-template sending.
    $('waSendPreview').innerHTML = `<div style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px dashed rgba(37,211,102,0.3)"><b>✨ AI Draft (for reference — copy if sending manually):</b><br>${escapeHtml(draft)}</div>` + $('waSendPreview').innerHTML;
  }
}

function renderWaPreview() {
  if (!WA_SEND_CONTEXT) return;
  const tplName = $('waSendTemplate').value;
  const tpl = TEMPLATES.find(t => t.template_name === tplName);
  const container = $('waSendVarsContainer');
  if (!tpl) { $('waSendPreview').textContent = 'Select a template to preview the message…'; container.innerHTML = ''; return; }

  const vars = buildVariablesForClient(WA_SEND_CONTEXT.record, tpl.variable_count);
  // Render editable variable inputs so the user can tweak before sending
  container.innerHTML = vars.map((v, i) => `
    <div class="field" style="margin-bottom:8px">
      <label>Variable {{${i + 1}}}</label>
      <input type="text" class="wa-var-input" data-idx="${i}" value="${escapeHtml(v)}" oninput="renderWaPreviewFromInputs()">
    </div>`).join('');

  renderWaPreviewFromInputs();
}

function renderWaPreviewFromInputs() {
  const tplName = $('waSendTemplate').value;
  const tpl = TEMPLATES.find(t => t.template_name === tplName);
  if (!tpl) return;
  let body = tpl.body_text || '';
  document.querySelectorAll('.wa-var-input').forEach(inp => {
    const idx = parseInt(inp.dataset.idx) + 1;
    body = body.split(`{{${idx}}}`).join(inp.value || '');
  });
  $('waSendPreview').textContent = body;
}

async function confirmSendWa() {
  if (!WA_SEND_CONTEXT) return;
  const tplName = $('waSendTemplate').value;
  const tpl = TEMPLATES.find(t => t.template_name === tplName);
  if (!tpl) { toast('Select a template', 'error'); return; }
  const variables = [...document.querySelectorAll('.wa-var-input')].map(i => i.value);
  const record = WA_SEND_CONTEXT.record;
  const phone = $('waSendTo').value.trim();
  if (!phone) { toast('Enter a phone number to send to', 'error'); return; }

  const sourcePageMap = { visit_clients: 'visit_clients', active_clients: 'active_clients', meetings: 'meetings' };
  try {
    const result = await api('POST', '/whatsapp/send', {
      toRaw: phone, templateName: tplName, language: tpl.language, variables,
      clientName: record.name || record.client_name, sourcePage: sourcePageMap[WA_SEND_CONTEXT.sourceTable],
    });
    closeModal('modalWaSend');
    if (result.success) toast('📤 WhatsApp message sent');
    else toast('❌ Send failed: ' + result.error, 'error');
    if ($('page-walog').classList.contains('active')) loadWaLog();
  } catch (e) { /* already toasted */ }
}

// ════════════════════════ PAGE 7: WA LOG ════════════════════════
async function loadWaLog() {
  const qs = new URLSearchParams();
  const status = $('wl_status')?.value; if (status) qs.set('status', status);
  const q = $('wl_search')?.value; if (q) qs.set('q', q);
  const from = $('wl_from')?.value; if (from) qs.set('from', from);
  const to = $('wl_to')?.value; if (to) qs.set('to', to);
  STATE.waLog = await api('GET', '/whatsapp/log' + (qs.toString() ? '?' + qs.toString() : ''));
  renderWaLog();
}

function renderWaLog() {
  const tbody = $('waLogBody');
  tbody.innerHTML = STATE.waLog.map(l => `
    <tr>
      <td class="cell-muted" style="font-size:11px">${escapeHtml(l.created_at)}</td>
      <td class="cell-name">${escapeHtml(l.client_name) || '—'}</td>
      <td class="cell-phone">${escapeHtml(l.to_number)}</td>
      <td class="cell-muted">${escapeHtml(l.template_name)}</td>
      <td class="cell-muted">${escapeHtml(l.source_page) || '—'}</td>
      <td><span class="tag ${statusTagClass(l.status)}">${escapeHtml(l.status)}</span></td>
      <td class="cell-muted" style="font-size:11px;color:var(--red)">${escapeHtml(l.error_message) || ''}</td>
    </tr>`).join('') || `<tr class="empty-row"><td colspan="7">No WhatsApp messages sent yet.</td></tr>`;

  const counts = { sent: 0, delivered: 0, read: 0, failed: 0, pending: 0 };
  STATE.waLog.forEach(l => { if (counts[l.status] !== undefined) counts[l.status]++; });
  $('waLogKpis').innerHTML = `
    <div class="kpi"><div class="label">Total</div><div class="value">${STATE.waLog.length}</div></div>
    <div class="kpi"><div class="label">Delivered</div><div class="value green">${counts.delivered + counts.read}</div></div>
    <div class="kpi"><div class="label">Read</div><div class="value accent">${counts.read}</div></div>
    <div class="kpi"><div class="label">Failed</div><div class="value red">${counts.failed}</div></div>
    <div class="kpi"><div class="label">Pending</div><div class="value">${counts.pending}</div></div>
  `;
}

// ════════════════════════ PAGE 8: REPORTS ════════════════════════
async function loadReports() {
  const from = $('rep_from').value, to = $('rep_to').value;
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const data = await api('GET', '/reports/summary' + (qs.toString() ? '?' + qs.toString() : ''));

  $('reportKpis').innerHTML = `
    <div class="kpi"><div class="label">Visit Clients</div><div class="value">${data.visitClientCount}</div></div>
    <div class="kpi"><div class="label">Active Clients</div><div class="value accent">${data.activeClientCount}</div></div>
    <div class="kpi"><div class="label">Visits (range)</div><div class="value">${data.visitsInRange}</div></div>
    <div class="kpi"><div class="label">Follow-ups Pending</div><div class="value red">${data.followupsPending}</div></div>
    <div class="kpi"><div class="label">Meetings (range)</div><div class="value">${data.meetingsInRange}</div><div class="sub">${data.meetingsDone} done · ${data.meetingsScheduled} scheduled</div></div>
    <div class="kpi"><div class="label">WA Sent</div><div class="value green">${data.waSent}</div></div>
    <div class="kpi"><div class="label">WA Delivered</div><div class="value">${data.waDelivered}</div></div>
    <div class="kpi"><div class="label">WA Failed</div><div class="value red">${data.waFailed}</div></div>
    <div class="kpi"><div class="label">Monthly Value Total</div><div class="value accent">₹${Number(data.monthlyValueTotal || 0).toLocaleString('en-IN')}</div></div>
  `;

  const maxArea = Math.max(1, ...data.byArea.map(a => a.c));
  const maxWa = Math.max(1, ...data.waByDay.map(d => d.c));
  $('reportCharts').innerHTML = `
    <div class="bar-chart-wrap">
      <h3>Clients by Area (top 10)</h3>
      <div class="bars">${data.byArea.map(a => `
        <div class="bar-col">
          <div class="bar-val">${a.c}</div>
          <div class="bar" style="height:${(a.c / maxArea * 100)}%"></div>
          <div class="bar-label">${escapeHtml(a.area)}</div>
        </div>`).join('') || '<div class="text-muted" style="padding:20px">No area data yet</div>'}</div>
    </div>
    <div class="bar-chart-wrap">
      <h3>WhatsApp Messages by Day</h3>
      <div class="bars">${data.waByDay.map(d => `
        <div class="bar-col">
          <div class="bar-val">${d.c}</div>
          <div class="bar" style="height:${(d.c / maxWa * 100)}%;background:var(--wa-green)"></div>
          <div class="bar-label">${escapeHtml(d.d.slice(5))}</div>
        </div>`).join('') || '<div class="text-muted" style="padding:20px">No WhatsApp activity in this range</div>'}</div>
    </div>
  `;
}

function reportsTab(tab) {
  document.querySelectorAll('#page-reports .tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('#page-reports .tab-panel').forEach(p => p.classList.remove('active'));
  $('rtab_' + tab).classList.add('active');
  $('rpanel_' + tab).classList.add('active');
  if (tab === 'targets') {
    if (!$('tg_week').value) $('tg_week').value = todayISO();
    loadTargetsBoard();
  }
}

// ════════════════════════ SALES TARGETS BOARD ════════════════════════
function setTargetsWeekToToday() {
  $('tg_week').value = todayISO();
  loadTargetsBoard();
}

async function loadTargetsBoard() {
  const week = $('tg_week').value || todayISO();
  const data = await api('GET', `/targets/board?week_start=${week}`);
  const container = $('targetsBoard');

  if (!data.board.length) {
    container.innerHTML = `<div class="panel" style="padding:30px;text-align:center;color:var(--muted)">No sales executives yet. Add them in Settings → Sales Team.</div>`;
    return;
  }

  container.innerHTML = `
    <div class="kpi-row">
      ${data.board.map(b => `
        <div class="kpi">
          <div class="label">${escapeHtml(b.executive_name)}</div>
          <div class="value ${b.achieved_pct >= 100 ? 'green' : (b.achieved_pct < 50 ? 'red' : 'accent')}">${b.achieved_pct}%</div>
          <div class="sub">${b.actual_tons}t of ${b.total_due}t ${b.rollover_tons > 0 ? `(incl. ${b.rollover_tons}t rollover)` : ''}</div>
        </div>`).join('')}
    </div>
    <div class="panel">
      <div class="table-scroll">
        <table>
          <thead><tr><th>Executive</th><th>Week</th><th>Base Target</th><th>Rollover</th><th>Total Due</th><th>Achieved</th><th>Remaining</th><th>%</th></tr></thead>
          <tbody>
            ${data.board.map(b => `
              <tr>
                <td class="cell-name">${escapeHtml(b.executive_name)}</td>
                <td class="cell-muted">${escapeHtml(b.week_start)}</td>
                <td>${b.target_tons}t</td>
                <td class="${b.rollover_tons > 0 ? 'cell-phone' : 'cell-muted'}">${b.rollover_tons}t</td>
                <td style="font-weight:700">${b.total_due}t</td>
                <td class="cell-muted">${b.actual_tons}t</td>
                <td><span class="tag ${b.remaining_tons > 0 ? 'pending' : 'active'}">${b.remaining_tons}t</span></td>
                <td><span class="tag ${b.achieved_pct >= 100 ? 'active' : (b.achieved_pct < 50 ? 'failed' : 'pending')}">${b.achieved_pct}%</span></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function openSetTargetModal() {
  fillExecutiveSelect($('tg_executive'));
  $('tg_week_input').value = $('tg_week').value || todayISO();
  $('tg_tons').value = '';
  $('tg_notes').value = '';
  openModalEl('modalSetTarget');
}

async function confirmSetTarget() {
  const executive_id = $('tg_executive').value;
  const week_start = $('tg_week_input').value;
  const target_tons = parseFloat($('tg_tons').value);
  if (!executive_id) { toast('Select a sales executive', 'error'); return; }
  if (!week_start) { toast('Select a week', 'error'); return; }
  if (!target_tons || target_tons <= 0) { toast('Enter a target in tons', 'error'); return; }
  try {
    await api('POST', '/targets', { executive_id, week_start, target_tons, notes: $('tg_notes').value.trim() });
    closeModal('modalSetTarget');
    $('tg_week').value = week_start;
    await loadTargetsBoard();
    toast('✅ Target saved');
  } catch (e) { /* already toasted */ }
}

// ════════════════════════ PAGE 9: SETTINGS ════════════════════════
function settingsTab(tab) {
  document.querySelectorAll('#page-settings .tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('#page-settings .tab-panel').forEach(p => p.classList.remove('active'));
  $('tab_' + tab).classList.add('active');
  $('panel_' + tab).classList.add('active');
  if (tab === 'templates') renderTemplatesTable();
  if (tab === 'ai') loadAiSettingsPage();
  if (tab === 'team') renderExecutivesTable();
  if (tab === 'backup') loadBackupList();
}

async function loadSettingsPage() {
  const settings = await api('GET', '/whatsapp/settings');
  $('set_token').value = settings.wa_access_token || '';
  $('set_token').placeholder = settings.wa_access_token ? 'Token saved (hidden) — paste a new one to replace it' : 'EAAxxxxxxxxxxxx...';
  $('set_phoneid').value = settings.wa_phone_number_id || '';
  $('set_wabaid').value = settings.wa_business_account_id || '';
  $('set_verify').value = settings.wa_webhook_verify_token || '';

  const statusEl = $('waConfigStatus');
  if (settings.configured) {
    statusEl.innerHTML = `<div class="wa-status-bar ok">✓ WhatsApp is connected and ready to send messages.</div>`;
  } else {
    statusEl.innerHTML = `<div class="wa-status-bar bad">⚠️ Not connected yet. Fill in your Access Token and Phone Number ID below, then click Save.</div>`;
  }
  renderTemplatesTable();
}

async function loadAiSettingsPage() {
  const status = await api('GET', '/ai/status');
  $('set_openai_key').value = '';
  $('set_openai_key').placeholder = status.masked_key ? `Saved: ${status.masked_key} — paste a new key to replace it` : 'sk-xxxxxxxxxxxxxxxxxxxx';
  const statusEl = $('aiConfigStatus');
  statusEl.innerHTML = status.configured
    ? `<div class="wa-status-bar ok">✓ AI features are connected and ready to use.</div>`
    : `<div class="wa-status-bar bad">⚠️ Not connected yet. Paste your OpenAI API key below, then click Save.</div>`;
}

async function saveOpenAiSettings() {
  const key = $('set_openai_key').value.trim();
  if (!key) { toast('Paste your OpenAI API key first', 'error'); return; }
  await api('POST', '/ai/settings', { openai_api_key: key });
  toast('✅ OpenAI key saved');
  await checkAiStatus();
  await loadAiSettingsPage();
}

async function saveWaSettings() {
  const payload = {
    wa_access_token: $('set_token').value.trim(),
    wa_phone_number_id: $('set_phoneid').value.trim(),
    wa_business_account_id: $('set_wabaid').value.trim(),
    wa_webhook_verify_token: $('set_verify').value.trim(),
  };
  await api('POST', '/whatsapp/settings', payload);
  toast('✅ WhatsApp settings saved');
  await checkWaStatus();
  await loadSettingsPage();
}

async function syncTemplates() {
  try {
    const result = await api('POST', '/whatsapp/templates/sync');
    toast(`✅ Synced ${result.count} templates from Meta`);
    await loadTemplates();
    renderTemplatesTable();
  } catch (e) { /* already toasted */ }
}

function renderTemplatesTable() {
  $('templateCount').textContent = TEMPLATES.length + ' approved template(s)';
  $('templatesBody').innerHTML = TEMPLATES.map(t => `
    <tr>
      <td class="cell-name">${escapeHtml(t.template_name)}</td>
      <td class="cell-muted">${escapeHtml(t.language)}</td>
      <td><span class="tag area">${escapeHtml(t.category) || '—'}</span></td>
      <td class="cell-muted" style="white-space:normal;max-width:380px">${escapeHtml(t.body_text)}</td>
      <td class="cell-muted">${t.variable_count}</td>
    </tr>`).join('') || `<tr class="empty-row"><td colspan="5">No templates synced yet. Click "Sync Templates from Meta" above.</td></tr>`;
}

async function changePassword() {
  const oldPassword = $('pw_old').value, newPassword = $('pw_new').value;
  if (!oldPassword || !newPassword) { toast('Fill both fields', 'error'); return; }
  if (newPassword.length < 6) { toast('New password must be at least 6 characters', 'error'); return; }
  try {
    await api('POST', '/auth/change-password', { username: CURRENT_USER.username, oldPassword, newPassword });
    toast('✅ Password updated');
    $('pw_old').value = ''; $('pw_new').value = '';
  } catch (e) { /* already toasted */ }
}

// ════════════════════════ DETAIL POPUP ════════════════════════
async function openDetailPopup(clientTable, clientId) {
  const list = clientTable === 'visit_clients' ? STATE.visitClients : STATE.activeClients;
  const c = list.find(x => x.id === clientId);
  if (!c) return;

  $('detailContent').innerHTML = `<div style="padding:30px;text-align:center;color:var(--muted)">Loading…</div>`;
  openModalEl('modalDetail');

  const [logs, orders] = await Promise.all([
    api('GET', `/visit-logs?client_id=${clientId}&client_table=${clientTable}`),
    clientTable === 'active_clients' ? api('GET', `/orders?active_client_id=${clientId}`) : Promise.resolve([]),
  ]);

  const isVisitClient = clientTable === 'visit_clients';
  const orderTotal = orders.reduce((s, o) => s + (o.total_amount || 0), 0);

  $('detailContent').innerHTML = `
    <div class="detail-head">
      <div>
        <h2>${escapeHtml(c.name)}</h2>
        <div class="meta">
          ${c.area ? `<span class="tag area">${escapeHtml(c.area)}</span>` : ''}
          ${isVisitClient ? `<span class="tag ${(c.lead_status || 'cold').toLowerCase()}">${escapeHtml(c.lead_status) || 'Cold'}</span>` : ''}
          <span class="tag ${statusTagClass(c.status)}">${escapeHtml(c.status)}</span>
        </div>
      </div>
      <div class="gap-wrap">
        ${c.phone ? `<button class="wa-launch-btn" onclick="closeModal('modalDetail');openWaSendModal('${clientTable}', ${c.id})">💬 WhatsApp</button>` : ''}
        <button class="btn btn-secondary btn-sm" onclick="closeModal('modalDetail');${isVisitClient ? 'openVisitClientModal' : 'openActiveClientModal'}(${c.id})">✏️ Edit</button>
      </div>
    </div>

    <div class="detail-grid">
      <div class="detail-field"><div class="k">Phone</div><div class="v">${escapeHtml(c.phone) || '—'}</div></div>
      <div class="detail-field"><div class="k">Address</div><div class="v">${escapeHtml(c.address) || '—'}</div></div>
      ${isVisitClient ? `<div class="detail-field"><div class="k">Last Visit</div><div class="v">${escapeHtml(c.last_visit) || '—'}</div></div>
      <div class="detail-field"><div class="k">Next Follow-up</div><div class="v">${escapeHtml(c.follow_up_date) || '—'}</div></div>` : `
      <div class="detail-field"><div class="k">Business</div><div class="v">${escapeHtml(c.business) || '—'}</div></div>
      <div class="detail-field"><div class="k">Monthly Value</div><div class="v">${c.monthly_value ? '₹' + Number(c.monthly_value).toLocaleString('en-IN') : '—'}</div></div>
      <div class="detail-field"><div class="k">Total Orders</div><div class="v">₹${orderTotal.toLocaleString('en-IN')} (${orders.length})</div></div>`}
    </div>

    <div id="detailAiSummary"></div>

    <div class="detail-section-title">
      <span>📝 Visit History (${logs.length})</span>
      <button class="btn btn-primary btn-sm" onclick="closeModal('modalDetail');openLogVisitModal('${clientTable}', ${c.id}, '${escapeHtml(c.name).replace(/'/g, "\\'")}' )">+ Log a Visit</button>
    </div>
    <div class="timeline">
      ${logs.map(l => `
        <div class="timeline-item">
          <div class="tdate">${escapeHtml(l.visit_date)} ${l.lead_status ? `<span class="tag ${l.lead_status.toLowerCase()}" style="font-size:9px">${escapeHtml(l.lead_status)}</span>` : ''}</div>
          <div class="tremarks">${escapeHtml(l.remarks) || '<span class="text-muted">No remarks</span>'}</div>
          ${l.next_follow_up_date ? `<div class="tnext">Next follow-up: ${escapeHtml(l.next_follow_up_date)}</div>` : ''}
        </div>`).join('') || `<div class="text-muted" style="padding:10px 0">No visits logged yet.</div>`}
    </div>

    ${!isVisitClient ? `
    <div class="detail-section-title">
      <span>🧾 Orders (${orders.length})</span>
      <button class="btn btn-primary btn-sm" onclick="closeModal('modalDetail');openOrderModal(${c.id})">+ Add Order</button>
    </div>
    <div>
      ${orders.map(o => `
        <div class="order-card">
          <div class="ohead">
            <span>${o.bill_no ? 'Bill #' + escapeHtml(o.bill_no) : 'Order'} — ${escapeHtml(o.order_date)}</span>
            <button class="btn btn-danger btn-sm" onclick="deleteOrder(${o.id}, ${c.id})">🗑️</button>
          </div>
          <table style="width:100%">
            <thead><tr><th style="text-align:left;padding:4px 0">Product</th><th style="text-align:right">Qty</th><th style="text-align:right">Rate</th><th style="text-align:right">Amount</th></tr></thead>
            <tbody>${o.items.map(i => `<tr><td style="padding:3px 0">${escapeHtml(i.product)}</td><td style="text-align:right">${i.qty}</td><td style="text-align:right">₹${i.rate}</td><td style="text-align:right">₹${i.amount.toLocaleString('en-IN')}</td></tr>`).join('')}</tbody>
          </table>
          <div class="ototal">Total: ₹${o.total_amount.toLocaleString('en-IN')}</div>
          ${o.notes ? `<div class="cell-muted" style="margin-top:6px">${escapeHtml(o.notes)}</div>` : ''}
        </div>`).join('') || `<div class="text-muted" style="padding:10px 0">No orders yet.</div>`}
    </div>` : ''}
  `;

  // AI: one-line history summary (best-effort, non-blocking)
  if (AI_CONFIGURED && logs.length) {
    api('POST', '/ai/summarize-history', { client_id: c.id, client_table: clientTable }).then(r => {
      const el = $('detailAiSummary');
      if (el && r.success && r.text) {
        el.innerHTML = `<div class="ai-suggestion-box show">✨ <b>AI Summary:</b> ${escapeHtml(r.text)}</div>`;
      }
    }).catch(() => {});
  }
}

async function deleteOrder(orderId, activeClientId) {
  if (!confirm('Delete this order?')) return;
  await api('DELETE', '/orders/' + orderId);
  await loadActiveClients();
  openDetailPopup('active_clients', activeClientId);
  toast('🗑️ Order deleted');
}

// ════════════════════════ ORDERS ════════════════════════
let orderItemCounter = 0;

function openOrderModal(activeClientId) {
  $('ord_client_id').value = activeClientId;
  $('ord_bill_no').value = '';
  $('ord_date').value = todayISO();
  $('ord_notes').value = '';
  $('ord_items_container').innerHTML = '';
  orderItemCounter = 0;
  addOrderItemRow();
  openModalEl('modalOrder');
}

function addOrderItemRow() {
  orderItemCounter++;
  const id = 'oi_' + orderItemCounter;
  const row = document.createElement('div');
  row.className = 'field-grid';
  row.style.cssText = 'grid-template-columns:2fr 0.8fr 0.8fr 1fr 1fr auto;gap:8px;margin-bottom:8px;align-items:end';
  row.id = id;
  row.innerHTML = `
    <div class="field"><label>Product</label><input type="text" class="oi-product" oninput="recalcOrderTotal()"></div>
    <div class="field"><label>Qty</label><input type="number" class="oi-qty" value="1" oninput="recalcOrderTotal()"></div>
    <div class="field"><label>Unit</label><select class="oi-unit"><option value="kg">kg</option><option value="tons">tons</option></select></div>
    <div class="field"><label>Rate ₹</label><input type="number" class="oi-rate" value="0" oninput="recalcOrderTotal()"></div>
    <div class="field"><label>Amount</label><input type="text" class="oi-amount" readonly value="0" style="background:var(--paper-sunken)"></div>
    <button class="btn btn-danger btn-sm" onclick="document.getElementById('${id}').remove();recalcOrderTotal()" style="margin-bottom:1px">✕</button>
  `;
  $('ord_items_container').appendChild(row);
}

function recalcOrderTotal() {
  let total = 0;
  document.querySelectorAll('#ord_items_container > div').forEach(row => {
    const qty = parseFloat(row.querySelector('.oi-qty').value) || 0;
    const rate = parseFloat(row.querySelector('.oi-rate').value) || 0;
    const amt = qty * rate;
    row.querySelector('.oi-amount').value = amt.toLocaleString('en-IN');
    total += amt;
  });
  $('ord_total_display').textContent = total.toLocaleString('en-IN');
}

async function saveOrder() {
  const activeClientId = parseInt($('ord_client_id').value);
  const items = [...document.querySelectorAll('#ord_items_container > div')].map(row => ({
    product: row.querySelector('.oi-product').value.trim(),
    qty: parseFloat(row.querySelector('.oi-qty').value) || 0,
    unit: row.querySelector('.oi-unit').value,
    rate: parseFloat(row.querySelector('.oi-rate').value) || 0,
  })).filter(i => i.product);

  if (!items.length) { toast('Add at least one product', 'error'); return; }

  const payload = {
    active_client_id: activeClientId, bill_no: $('ord_bill_no').value.trim(),
    order_date: $('ord_date').value, notes: $('ord_notes').value.trim(), items,
  };
  if (!payload.order_date) { toast('Order date is required', 'error'); return; }
  try {
    await api('POST', '/orders', payload);
    closeModal('modalOrder');
    await loadActiveClients();
    toast('🧾 Order saved');
  } catch (e) { /* already toasted */ }
}

// ════════════════════════ AI FEATURES ════════════════════════
let AI_CONFIGURED = false;

async function checkAiStatus() {
  try {
    const status = await api('GET', '/ai/status');
    AI_CONFIGURED = !!status.configured;
  } catch (e) { AI_CONFIGURED = false; }
}

async function aiSuggestFollowup() {
  const clientId = parseInt($('lv_client_id').value);
  const clientTable = $('lv_client_table').value;
  const box = $('lv_ai_followup_result');
  box.className = 'ai-suggestion-box show';
  box.textContent = '✨ Thinking…';
  const result = await api('POST', '/ai/suggest-followup', { client_id: clientId, client_table: clientTable });
  if (!result.success) { box.textContent = '⚠️ ' + result.error; return; }
  if (!result.suggested_date) { box.textContent = result.reason || 'Not enough history yet.'; return; }
  box.innerHTML = `Suggested: <b>${escapeHtml(result.suggested_date)}</b> — ${escapeHtml(result.reason || '')}
    <span class="apply-link" onclick="$('lv_next_followup').value='${result.suggested_date}'">Apply</span>`;
}

async function aiSuggestLeadStatus() {
  const clientId = parseInt($('lv_client_id').value);
  const clientTable = $('lv_client_table').value;
  const box = $('lv_ai_status_result');
  box.className = 'ai-suggestion-box show';
  box.textContent = '✨ Thinking…';
  const result = await api('POST', '/ai/suggest-lead-status', { client_id: clientId, client_table: clientTable });
  if (!result.success) { box.textContent = '⚠️ ' + result.error; return; }
  if (!result.suggested_status) { box.textContent = result.reason || 'Not enough history yet.'; return; }
  box.innerHTML = `Suggested: <b>${escapeHtml(result.suggested_status)}</b> — ${escapeHtml(result.reason || '')}
    <span class="apply-link" onclick="$('lv_lead_status').value='${result.suggested_status}'">Apply</span>`;
}

// Voice-to-text capture for the Log a Visit remarks field
let MEDIA_RECORDER = null, AUDIO_CHUNKS = [];

async function toggleVoiceCapture() {
  const btn = $('lv_mic_btn');
  if (MEDIA_RECORDER && MEDIA_RECORDER.state === 'recording') {
    MEDIA_RECORDER.stop();
    return;
  }
  if (!AI_CONFIGURED) { toast('Connect OpenAI in Settings → AI Features first', 'error'); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    AUDIO_CHUNKS = [];
    MEDIA_RECORDER = new MediaRecorder(stream);
    MEDIA_RECORDER.ondataavailable = e => AUDIO_CHUNKS.push(e.data);
    MEDIA_RECORDER.onstop = async () => {
      btn.classList.remove('recording');
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(AUDIO_CHUNKS, { type: 'audio/webm' });
      toast('🎤 Transcribing…');
      const formData = new FormData();
      formData.append('audio', blob, 'visit_note.webm');
      try {
        const res = await fetch(API + '/ai/transcribe', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: formData });
        const data = await res.json();
        if (data.success && data.text) {
          const existing = $('lv_remarks').value.trim();
          $('lv_remarks').value = existing ? existing + ' ' + data.text : data.text;
          toast('✅ Transcribed');
        } else {
          toast('⚠️ ' + (data.error || 'Transcription failed'), 'error');
        }
      } catch (e) { toast('⚠️ Transcription failed', 'error'); }
    };
    MEDIA_RECORDER.start();
    btn.classList.add('recording');
    toast('🎤 Recording… click again to stop');
  } catch (e) {
    toast('⚠️ Microphone access denied or unavailable', 'error');
  }
}

// AI: draft a WhatsApp message from visit remarks — small helper button usable
// from the WhatsApp send modal when a client has visit history with remarks.
async function aiDraftMessageFromRemarks(remarks, clientName) {
  if (!AI_CONFIGURED) { toast('Connect OpenAI in Settings → AI Features first', 'error'); return null; }
  const result = await api('POST', '/ai/draft-message', { client_name: clientName, remarks });
  if (!result.success) { toast('⚠️ ' + result.error, 'error'); return null; }
  return result.text;
}

// ════════════════════════ SALES EXECUTIVES (Settings → Sales Team) ════════════════════════
function renderExecutivesTable() {
  $('executivesBody').innerHTML = STATE.executives.map(e => `
    <tr>
      <td class="cell-name">${escapeHtml(e.name)}</td>
      <td class="cell-muted">${escapeHtml(e.phone) || '—'}</td>
      <td><span class="tag ${e.active ? 'active' : 'inactive'}">${e.active ? 'Active' : 'Inactive'}</span></td>
      <td class="row-actions">
        <button class="btn btn-secondary btn-sm" onclick="openExecutiveModal(${e.id})">✏️</button>
        ${e.active ? `<button class="btn btn-danger btn-sm" onclick="deactivateExecutive(${e.id})">Deactivate</button>` : ''}
      </td>
    </tr>`).join('') || `<tr class="empty-row"><td colspan="4">No sales executives added yet.</td></tr>`;
}

function openExecutiveModal(id) {
  const e = id ? STATE.executives.find(x => x.id === id) : {};
  $('exModalTitle').textContent = id ? 'Edit Sales Executive' : 'Add Sales Executive';
  $('ex_id').value = id || '';
  $('ex_name').value = e.name || '';
  $('ex_phone').value = e.phone || '';
  openModalEl('modalExecutive');
}

async function saveExecutive() {
  const id = $('ex_id').value;
  const name = $('ex_name').value.trim();
  const phone = $('ex_phone').value.trim();
  if (!name) { toast('Name is required', 'error'); return; }
  if (id) await api('PUT', '/executives/' + id, { name, phone });
  else await api('POST', '/executives', { name, phone });
  closeModal('modalExecutive');
  await loadExecutives();
  renderExecutivesTable();
  toast('✅ Sales executive saved');
}

async function deactivateExecutive(id) {
  if (!confirm('Deactivate this executive? Their past records stay intact, they just won\'t appear in new dropdowns.')) return;
  await api('DELETE', '/executives/' + id);
  await loadExecutives();
  renderExecutivesTable();
  toast('✅ Deactivated');
}

// ════════════════════════ BACKUPS (Settings → Backups) ════════════════════════
function downloadBackupNow() {
  // Direct navigation triggers the browser's normal file-download flow, including
  // the Authorization header via a short-lived approach isn't possible for GET nav,
  // so we fetch + blob-download instead to keep the auth token in the request.
  fetch(API + '/backup/download', { headers: { Authorization: 'Bearer ' + TOKEN } })
    .then(res => {
      if (!res.ok) throw new Error('Backup download failed');
      return res.blob();
    })
    .then(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `visitbook-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast('✅ Backup downloaded');
      loadBackupList();
    })
    .catch(() => toast('❌ Backup download failed', 'error'));
}

async function loadBackupList() {
  try {
    const list = await api('GET', '/backup/list');
    $('backupListBody').innerHTML = list.map(b => `
      <tr>
        <td class="cell-muted" style="font-size:11.5px">${escapeHtml(b.name)}</td>
        <td class="cell-muted">${(b.size / 1024).toFixed(0)} KB</td>
        <td class="cell-muted">${new Date(b.created_at).toLocaleString('en-IN')}</td>
      </tr>`).join('') || `<tr class="empty-row"><td colspan="3">No automatic backups yet — one is taken after the first 10 minutes of activity.</td></tr>`;
  } catch (e) { /* ignore */ }
}
