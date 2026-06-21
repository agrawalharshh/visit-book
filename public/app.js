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
  swaData: [], swaSelected: [], waLog: [],
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

  await Promise.all([
    loadVisitClients(), loadActiveClients(), loadMeetings(), loadFollowups(),
    loadSwaData(), loadSwaSelected(), checkWaStatus(),
  ]);
  showPage('visits');
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
  const status = $('vc_status_filter')?.value || '';
  fillAreaOptions($('vc_area_filter'), STATE.visitClients, true);

  const filtered = STATE.visitClients.filter(c => {
    const mq = !q || (c.name || '').toLowerCase().includes(q) || (c.area || '').toLowerCase().includes(q) || (c.phone || '').includes(q);
    const ma = !area || c.area === area;
    const ms = !status || c.status === status;
    return mq && ma && ms;
  });

  const tbody = $('visitClientBody');
  tbody.innerHTML = filtered.map((c, i) => `
    <tr>
      <td class="cell-muted">${i + 1}</td>
      <td class="cell-name">${escapeHtml(c.name)}</td>
      <td>${c.area ? `<span class="tag area">${escapeHtml(c.area)}</span>` : '—'}</td>
      <td>${c.phone ? `<a href="tel:${c.phone}" class="cell-phone">${escapeHtml(c.phone)}</a>` : '—'}</td>
      <td class="cell-muted">${escapeHtml(c.business) || '—'}</td>
      <td class="cell-muted">${escapeHtml(c.last_visit) || '—'}</td>
      <td class="cell-muted">${c.follow_up_date ? escapeHtml(c.follow_up_date) : '—'}</td>
      <td><span class="tag ${statusTagClass(c.status)}">${escapeHtml(c.status) || 'Prospect'}</span></td>
      <td class="cell-muted">${escapeHtml(c.remarks) || ''}</td>
      <td class="row-actions">
        ${c.phone ? `<button class="wa-launch-btn" onclick="openWaSendModal('visit_clients', ${c.id})">💬</button>` : ''}
        <button class="btn btn-secondary btn-sm" onclick="openVisitClientModal(${c.id})">✏️</button>
        <button class="btn btn-danger btn-sm" onclick="deleteVisitClient(${c.id})">🗑️</button>
      </td>
    </tr>`).join('') || `<tr class="empty-row"><td colspan="10">No visit clients yet — click "+ Add Client" to start.</td></tr>`;
}

function openVisitClientModal(id) {
  const c = id ? STATE.visitClients.find(x => x.id === id) : {};
  $('vcModalTitle').textContent = id ? 'Edit Visit Client' : 'Add Visit Client';
  $('vc_id').value = id || '';
  $('vc_name').value = c.name || '';
  $('vc_area').value = c.area || '';
  $('vc_phone').value = c.phone || '';
  $('vc_business').value = c.business || '';
  $('vc_address').value = c.address || '';
  $('vc_landmark').value = c.landmark || '';
  $('vc_location').value = c.location || '';
  $('vc_last_visit').value = c.last_visit || todayISO();
  $('vc_follow_up_date').value = c.follow_up_date || '';
  $('vc_status').value = c.status || 'Prospect';
  $('vc_remarks').value = c.remarks || '';
  fillDatalist($('areaListVC'), STATE.visitClients, 'area');
  openModalEl('modalVisitClient');
}

async function saveVisitClient() {
  const id = $('vc_id').value;
  const payload = {
    name: $('vc_name').value.trim(), area: $('vc_area').value.trim(), phone: $('vc_phone').value.trim(),
    business: $('vc_business').value.trim(), address: $('vc_address').value.trim(), landmark: $('vc_landmark').value.trim(),
    location: $('vc_location').value.trim(), last_visit: $('vc_last_visit').value, follow_up_date: $('vc_follow_up_date').value || null,
    status: $('vc_status').value, remarks: $('vc_remarks').value.trim(),
  };
  if (!payload.name) { toast('Name is required', 'error'); return; }
  if (id) await api('PUT', '/visit-clients/' + id, payload);
  else await api('POST', '/visit-clients', payload);
  closeModal('modalVisitClient');
  await loadVisitClients();
  await loadFollowups();
  toast('✅ Visit client saved');
}

async function deleteVisitClient(id) {
  if (!confirm('Delete this client?')) return;
  await api('DELETE', '/visit-clients/' + id);
  await loadVisitClients();
  toast('🗑️ Deleted');
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

// ════════════════════════ PAGE 3: ACTIVE CLIENTS ════════════════════════
async function loadActiveClients() {
  STATE.activeClients = await api('GET', '/active-clients');
  renderActiveClients();
}

function renderActiveClients() {
  const q = ($('ac_search')?.value || '').toLowerCase();
  const area = $('ac_area_filter')?.value || '';
  fillAreaOptions($('ac_area_filter'), STATE.activeClients, true);

  const filtered = STATE.activeClients.filter(c => {
    const mq = !q || (c.name || '').toLowerCase().includes(q) || (c.area || '').toLowerCase().includes(q) || (c.phone || '').includes(q);
    return mq && (!area || c.area === area);
  });

  const tbody = $('activeClientBody');
  tbody.innerHTML = filtered.map((c, i) => `
    <tr>
      <td class="cell-muted">${i + 1}</td>
      <td class="cell-name">${escapeHtml(c.name)}</td>
      <td>${c.area ? `<span class="tag area">${escapeHtml(c.area)}</span>` : '—'}</td>
      <td>${c.phone ? `<a href="tel:${c.phone}" class="cell-phone">${escapeHtml(c.phone)}</a>` : '—'}</td>
      <td class="cell-muted">${escapeHtml(c.business) || '—'}</td>
      <td style="font-weight:700;color:var(--accent-dark)">${c.monthly_value ? '₹' + Number(c.monthly_value).toLocaleString('en-IN') : '—'}</td>
      <td><span class="tag ${statusTagClass(c.status)}">${escapeHtml(c.status) || 'Active'}</span></td>
      <td class="cell-muted">${escapeHtml(c.remarks) || ''}</td>
      <td class="row-actions">
        ${c.phone ? `<button class="wa-launch-btn" onclick="openWaSendModal('active_clients', ${c.id})">💬</button>` : ''}
        <button class="btn btn-secondary btn-sm" onclick="openActiveClientModal(${c.id})">✏️</button>
        <button class="btn btn-danger btn-sm" onclick="deleteActiveClient(${c.id})">🗑️</button>
      </td>
    </tr>`).join('') || `<tr class="empty-row"><td colspan="9">No active clients yet.</td></tr>`;
}

function openActiveClientModal(id) {
  const c = id ? STATE.activeClients.find(x => x.id === id) : {};
  $('acModalTitle').textContent = id ? 'Edit Active Client' : 'Add Active Client';
  $('ac_id').value = id || '';
  $('ac_name').value = c.name || '';
  $('ac_area').value = c.area || '';
  $('ac_phone').value = c.phone || '';
  $('ac_business').value = c.business || '';
  $('ac_address').value = c.address || '';
  $('ac_landmark').value = c.landmark || '';
  $('ac_location').value = c.location || '';
  $('ac_monthly').value = c.monthly_value || '';
  $('ac_status').value = c.status || 'Active';
  $('ac_remarks').value = c.remarks || '';
  fillDatalist($('areaListAC'), STATE.activeClients, 'area');
  openModalEl('modalActiveClient');
}

async function saveActiveClient() {
  const id = $('ac_id').value;
  const payload = {
    name: $('ac_name').value.trim(), area: $('ac_area').value.trim(), phone: $('ac_phone').value.trim(),
    business: $('ac_business').value.trim(), address: $('ac_address').value.trim(), landmark: $('ac_landmark').value.trim(),
    location: $('ac_location').value.trim(), monthly_value: parseFloat($('ac_monthly').value) || 0,
    status: $('ac_status').value, remarks: $('ac_remarks').value.trim(),
  };
  if (!payload.name) { toast('Name is required', 'error'); return; }
  if (id) await api('PUT', '/active-clients/' + id, payload);
  else await api('POST', '/active-clients', payload);
  closeModal('modalActiveClient');
  await loadActiveClients();
  toast('✅ Active client saved');
}

async function deleteActiveClient(id) {
  if (!confirm('Delete this client?')) return;
  await api('DELETE', '/active-clients/' + id);
  await loadActiveClients();
  toast('🗑️ Deleted');
}

// ════════════════════════ PAGE 2: TODAY'S FOLLOW-UPS ════════════════════════
async function loadFollowups() {
  STATE.followups = await api('GET', '/followups');
  const badge = $('badgeFollowups');
  if (STATE.followups.length > 0) { badge.style.display = 'inline-block'; badge.textContent = STATE.followups.length; }
  else badge.style.display = 'none';
  renderFollowups();
}

function renderFollowups() {
  const tbody = $('followupsBody');
  const today = todayISO();
  tbody.innerHTML = STATE.followups.map(c => {
    const overdue = c.follow_up_date < today;
    return `
    <tr>
      <td class="cell-name">${escapeHtml(c.name)}</td>
      <td>${c.area ? `<span class="tag area">${escapeHtml(c.area)}</span>` : '—'}</td>
      <td>${c.phone ? `<a href="tel:${c.phone}" class="cell-phone">${escapeHtml(c.phone)}</a>` : '—'}</td>
      <td><span class="tag ${overdue ? 'failed' : 'pending'}">${escapeHtml(c.follow_up_date)}${overdue ? ' (overdue)' : ' (today)'}</span></td>
      <td class="cell-muted">${escapeHtml(c.remarks) || ''}</td>
      <td>${c.phone ? `<button class="wa-launch-btn" onclick="openWaSendModal('visit_clients', ${c.id})">💬 Send</button>` : '—'}</td>
      <td class="row-actions">
        <button class="btn btn-secondary btn-sm" onclick="markFollowupDone(${c.id})">✅ Done</button>
        <button class="btn btn-secondary btn-sm" onclick="openVisitClientModal(${c.id})">✏️</button>
      </td>
    </tr>`;
  }).join('') || `<tr class="empty-row"><td colspan="7">🎉 No follow-ups due today — you're all caught up!</td></tr>`;
}

async function markFollowupDone(id) {
  await api('POST', `/followups/${id}/done`);
  await loadFollowups();
  await loadVisitClients();
  toast('✅ Marked as visited, follow-up cleared');
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

async function saveMeeting() {
  const id = $('mt_id').value;
  const payload = {
    client_name: $('mt_client').value.trim(), phone: $('mt_phone').value.trim(), area: $('mt_area').value.trim(),
    meeting_date: $('mt_date').value, meeting_time: $('mt_time').value, notes: $('mt_notes').value.trim(),
    status: $('mt_status_sel').value,
  };
  if (!payload.client_name || !payload.meeting_date) { toast('Client name and date are required', 'error'); return; }
  if (id) await api('PUT', '/meetings/' + id, payload);
  else await api('POST', '/meetings', payload);
  closeModal('modalMeeting');
  await loadMeetings();
  toast('✅ Meeting saved');
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
  $('swaMoveBtn').disabled = n === 0;
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

// ── Move & Send flow ──
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

// ════════════════════════ PAGE 6: SWA SELECTED ════════════════════════
async function loadSwaSelected() {
  STATE.swaSelected = await api('GET', '/swa/selected');
  renderSwaSelected();
}

function renderSwaSelected() {
  const tbody = $('swaSelectedBody');
  // Look up WA status per row, if we have it loaded from log (best-effort)
  tbody.innerHTML = STATE.swaSelected.map(r => `
    <tr>
      <td class="cell-muted">${escapeHtml(r.sr)}</td>
      <td class="cell-name">${escapeHtml(r.company)}</td>
      <td>${escapeHtml(r.client)}</td>
      <td>${escapeHtml(r.phone) || '—'}</td>
      <td class="cell-muted">${escapeHtml(r.address) || '—'}</td>
      <td class="cell-muted">${escapeHtml(r.remarks) || ''}</td>
      <td class="cell-phone">${escapeHtml(r.sent_to_number)}</td>
      <td class="cell-muted" style="font-size:11px">${escapeHtml((r.batch_id || '').replace('batch_', ''))}</td>
      <td><span class="tag pending" id="swaWaStatus_${r.id}">—</span></td>
      <td class="cell-muted">${escapeHtml(r.moved_at)}</td>
      <td class="row-actions"><button class="btn btn-secondary btn-sm" onclick="restoreSwaRow(${r.id})" title="Move back to Swa Data">↩️</button></td>
    </tr>`).join('') || `<tr class="empty-row"><td colspan="11">Nothing here yet. Select rows in Swa Data and click "Move & Send".</td></tr>`;

  // Best-effort: fetch WA status for any rows with a wa_log_id, fill in the placeholder tags
  STATE.swaSelected.forEach(async r => {
    if (!r.wa_log_id) return;
    const el = $('swaWaStatus_' + r.id);
    if (!el) return;
  });
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
  const name = record.name || record.client_name || '';
  const phone = record.phone || '';
  $('waSendTo').value = `${name} — ${phone}`;
  populateTemplateSelect($('waSendTemplate'));
  $('waSendConfigWarning').style.display = WA_CONFIGURED ? 'none' : 'flex';
  renderWaPreview();
  openModalEl('modalWaSend');
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
  const phone = record.phone;
  if (!phone) { toast('This client has no phone number', 'error'); return; }

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

// ════════════════════════ PAGE 9: SETTINGS ════════════════════════
function settingsTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  $('tab_' + tab).classList.add('active');
  $('panel_' + tab).classList.add('active');
  if (tab === 'templates') renderTemplatesTable();
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
