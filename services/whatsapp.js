// services/whatsapp.js — talks to Meta WhatsApp Cloud API (graph.facebook.com)
const fetch = require('node-fetch');
const db = require('../db/init');

const GRAPH_VERSION = 'v20.0';
const MAX_RETRIES = 5;
// Backoff schedule in minutes: quick retry first (likely a blip), then spacing out
// further so a longer outage doesn't hammer Meta's API or spam the WA Log.
const RETRY_DELAYS_MIN = [1, 5, 15, 60, 240];

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

// Meta error codes that mean "this will never succeed, don't retry" — bad number,
// template rejected, account restricted, etc. Everything else (rate limits, 5xx,
// network blips) is treated as transient and gets retried automatically.
const PERMANENT_ERROR_CODES = new Set([100, 131009, 131021, 131026, 131047, 132000, 132001, 132005, 132007, 132012, 132015, 132016]);

function isPermanentError(errorData) {
  if (!errorData) return false;
  return PERMANENT_ERROR_CODES.has(errorData.code);
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

  return attemptSend({ logId, to, templateName, language, variables });
}

// The actual API call + outcome handling, shared between first attempts and retries.
async function attemptSend({ logId, to, templateName, language, variables }) {
  const { token, phoneNumberId } = getCreds();
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
      return handleSendFailure(logId, data.error.message || 'Unknown error', data.error, { to, templateName, language, variables });
    }

    const waMessageId = data.messages && data.messages[0] && data.messages[0].id;
    db.prepare(`UPDATE wa_log SET status='sent', wa_message_id=?, error_message=NULL, updated_at=datetime('now') WHERE id=?`)
      .run(waMessageId || null, logId);
    return { success: true, waMessageId, logId };
  } catch (err) {
    // Network-level failure (timeout, DNS, connection reset) — always transient, always retry.
    return handleSendFailure(logId, err.message, null, { to, templateName, language, variables });
  }
}

// Decides whether a failed send gets scheduled for automatic retry or marked
// permanently failed, and records that decision in wa_log so nothing silently vanishes.
function handleSendFailure(logId, errorMessage, errorData, sendArgs) {
  const row = db.prepare('SELECT retry_count FROM wa_log WHERE id = ?').get(logId);
  const retryCount = (row ? row.retry_count : 0) || 0;
  const permanent = isPermanentError(errorData);

  if (!permanent && retryCount < MAX_RETRIES) {
    const delayMin = RETRY_DELAYS_MIN[Math.min(retryCount, RETRY_DELAYS_MIN.length - 1)];
    const nextRetryAt = new Date(Date.now() + delayMin * 60 * 1000).toISOString();
    db.prepare(`UPDATE wa_log SET status='retrying', error_message=?, retry_count=?, next_retry_at=?, updated_at=datetime('now') WHERE id=?`)
      .run(errorMessage, retryCount + 1, nextRetryAt, logId);
    return { success: false, error: errorMessage, logId, willRetry: true, nextRetryAt };
  }

  db.prepare(`UPDATE wa_log SET status='failed', error_message=?, updated_at=datetime('now') WHERE id=?`)
    .run(errorMessage, logId);
  return { success: false, error: errorMessage, logId, willRetry: false };
}

// Called periodically (see server.js) to find any wa_log rows due for retry and
// re-attempt them. This is what makes "no message ever silently fails" actually
// true — a blip in Meta's API or a momentary network issue self-heals without
// anyone needing to notice or manually resend.
async function processRetryQueue() {
  const due = db.prepare(`SELECT * FROM wa_log WHERE status = 'retrying' AND next_retry_at <= datetime('now') ORDER BY next_retry_at ASC LIMIT 20`).all();
  for (const row of due) {
    let variables = [];
    try { variables = JSON.parse(row.variables_json || '[]'); } catch (e) { /* ignore */ }
    await attemptSend({ logId: row.id, to: row.to_number, templateName: row.template_name, language: 'en', variables });
  }
  return due.length;
}

// Handle Meta webhook status callbacks (sent/delivered/read/failed)
function updateStatusFromWebhook(waMessageId, status, errorMsg) {
  db.prepare(`UPDATE wa_log SET status=?, error_message=COALESCE(?, error_message), updated_at=datetime('now') WHERE wa_message_id=?`)
    .run(status, errorMsg || null, waMessageId);
}

// Handle an inbound message from a client (webhook "messages" entry) — stores it
// and tries to associate it with the most recent outbound message to that number.
function recordInboundMessage(fromNumber, messageText, waMessageId) {
  const normalized = normalizePhone(fromNumber) || fromNumber;
  const lastOutbound = db.prepare(`SELECT id FROM wa_log WHERE to_number = ? ORDER BY id DESC LIMIT 1`).get(normalized);
  db.prepare(`INSERT INTO wa_replies (from_number, message_text, wa_message_id, in_reply_to_log_id) VALUES (?, ?, ?, ?)`)
    .run(normalized, messageText || '', waMessageId || null, lastOutbound ? lastOutbound.id : null);
}

module.exports = {
  getCreds, isConfigured, normalizePhone, syncTemplates, listTemplates,
  sendTemplateMessage, updateStatusFromWebhook, recordInboundMessage,
  processRetryQueue, getSetting,
};
