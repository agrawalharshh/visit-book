// services/whatsapp.js — talks to Meta WhatsApp Cloud API (graph.facebook.com)
const fetch = require('node-fetch');
const db = require('../db/init');

const GRAPH_VERSION = 'v20.0';

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function getCreds() {
  return {
    token: getSetting('wa_access_token'),
    phoneNumberId: getSetting('wa_phone_number_id'),
    wabaId: getSetting('wa_business_account_id'),
  };
}

function isConfigured() {
  const c = getCreds();
  return !!(c.token && c.phoneNumberId);
}

// Normalize Indian numbers: ensure country code 91, strip non-digits
function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/[^0-9]/g, '');
  if (digits.length === 10) digits = '91' + digits;
  if (digits.length === 11 && digits.startsWith('0')) digits = '91' + digits.slice(1);
  return digits;
}

// Fetch approved templates from Meta and cache them in wa_templates
async function syncTemplates() {
  const { token, wabaId } = getCreds();
  if (!token || !wabaId) {
    throw new Error('Missing WhatsApp Business Account ID or Access Token in Settings');
  }
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/message_templates?limit=100`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Failed to fetch templates');

  const insert = db.prepare(`INSERT INTO wa_templates (template_name, language, category, body_text, variable_count, status, raw_json, synced_at)
    VALUES (@name, @language, @category, @body, @varCount, @status, @raw, datetime('now'))`);
  const clear = db.prepare('DELETE FROM wa_templates');

  const tx = db.transaction((templates) => {
    clear.run();
    for (const t of templates) {
      const bodyComp = (t.components || []).find(c => c.type === 'BODY');
      const bodyText = bodyComp ? bodyComp.text : '';
      const varCount = (bodyText.match(/\{\{\d+\}\}/g) || []).length;
      insert.run({
        name: t.name,
        language: t.language,
        category: t.category,
        body: bodyText,
        varCount,
        status: t.status,
        raw: JSON.stringify(t),
      });
    }
  });
  tx(data.data || []);
  return (data.data || []).length;
}

function listTemplates() {
  return db.prepare("SELECT * FROM wa_templates WHERE status = 'APPROVED' ORDER BY template_name").all();
}

// Send a template message. variables = array of strings matching {{1}}, {{2}}, ...
async function sendTemplateMessage({ toRaw, templateName, language, variables = [], clientName, sourcePage }) {
  const { token, phoneNumberId } = getCreds();
  if (!token || !phoneNumberId) {
    // Still log the attempt so it's visible in WA Log / Reports, but never throw —
    // an uncaught throw here would crash the whole request (and in Node, an
    // unhandled rejection can crash the process).
    let logId = null;
    try {
      const to = normalizePhone(toRaw) || toRaw;
      const info = db.prepare(`INSERT INTO wa_log (to_number, client_name, template_name, variables_json, rendered_message, status, error_message, source_page)
        VALUES (?, ?, ?, ?, '', 'failed', ?, ?)`).run(to, clientName || '', templateName, JSON.stringify(variables), 'WhatsApp not configured', sourcePage || '');
      logId = info.lastInsertRowid;
    } catch (e) { /* ignore logging failure */ }
    return { success: false, error: 'WhatsApp not configured. Go to Settings and add your Access Token + Phone Number ID.', logId };
  }
  const to = normalizePhone(toRaw);
  if (!to) return { success: false, error: 'Invalid phone number' };

  const logStmt = db.prepare(`INSERT INTO wa_log (to_number, client_name, template_name, variables_json, rendered_message, status, source_page)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)`);
  const logInfo = logStmt.run(to, clientName || '', templateName, JSON.stringify(variables), '', sourcePage || '');
  const logId = logInfo.lastInsertRowid;

  const body = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: language || 'en' },
      components: variables.length ? [{
        type: 'body',
        parameters: variables.map(v => ({ type: 'text', text: String(v ?? '') })),
      }] : [],
    },
  };

  try {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await res.json();

    if (data.error) {
      db.prepare(`UPDATE wa_log SET status='failed', error_message=?, updated_at=datetime('now') WHERE id=?`)
        .run(data.error.message || 'Unknown error', logId);
      return { success: false, error: data.error.message, logId };
    }

    const waMessageId = data.messages && data.messages[0] && data.messages[0].id;
    db.prepare(`UPDATE wa_log SET status='sent', wa_message_id=?, updated_at=datetime('now') WHERE id=?`)
      .run(waMessageId || null, logId);
    return { success: true, waMessageId, logId };
  } catch (err) {
    db.prepare(`UPDATE wa_log SET status='failed', error_message=?, updated_at=datetime('now') WHERE id=?`)
      .run(err.message, logId);
    return { success: false, error: err.message, logId };
  }
}

// Handle Meta webhook status callbacks (sent/delivered/read/failed)
function updateStatusFromWebhook(waMessageId, status, errorMsg) {
  db.prepare(`UPDATE wa_log SET status=?, error_message=COALESCE(?, error_message), updated_at=datetime('now') WHERE wa_message_id=?`)
    .run(status, errorMsg || null, waMessageId);
}

module.exports = {
  getCreds, isConfigured, normalizePhone, syncTemplates, listTemplates,
  sendTemplateMessage, updateStatusFromWebhook, getSetting,
};
