// routes/whatsapp.js
const express = require('express');
const db = require('../db/init');
const wa = require('../services/whatsapp');
const { can } = require('../middleware/auth');

const router = express.Router();

function requireManageSettings(req, res, next) {
  if (!can(req.user.role, 'manage_settings')) return res.status(403).json({ error: `Your role (${req.user.role}) cannot change WhatsApp settings.` });
  next();
}
function requireSendWhatsApp(req, res, next) {
  if (!can(req.user.role, 'send_whatsapp')) return res.status(403).json({ error: `Your role (${req.user.role}) cannot send WhatsApp messages.` });
  next();
}

// ── Settings ── (admin only)
router.get('/settings', requireManageSettings, (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  rows.forEach(r => { out[r.key] = r.key === 'wa_access_token' ? maskToken(r.value) : r.value; });
  out.configured = wa.isConfigured();
  res.json(out);
});

function maskToken(t) {
  if (!t) return '';
  if (t.length <= 8) return '••••••••';
  return t.slice(0, 6) + '••••••••' + t.slice(-4);
}

router.post('/settings', requireManageSettings, (req, res) => {
  const { wa_access_token, wa_phone_number_id, wa_business_account_id, wa_webhook_verify_token } = req.body;
  const upsert = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  // .trim() on every value — copy-pasting from a webpage very commonly drags in an
  // invisible trailing space or newline, which silently breaks the Graph API URL
  // built from these IDs and produces a confusing, hard-to-diagnose 400 error.
  if (wa_access_token && !wa_access_token.includes('••••')) upsert.run('wa_access_token', wa_access_token.trim());
  if (wa_phone_number_id) upsert.run('wa_phone_number_id', wa_phone_number_id.trim());
  if (wa_business_account_id) upsert.run('wa_business_account_id', wa_business_account_id.trim());
  if (wa_webhook_verify_token) upsert.run('wa_webhook_verify_token', wa_webhook_verify_token.trim());
  res.json({ success: true });
});

// ── Templates ── (read-only list available to any logged-in role that can send or view settings; sync is admin-only)
router.get('/templates', (req, res) => {
  res.json(wa.listTemplates());
});

router.post('/templates/sync', requireManageSettings, async (req, res) => {
  try {
    const count = await wa.syncTemplates();
    res.json({ success: true, count });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Send a single template message ──
router.post('/send', requireSendWhatsApp, async (req, res) => {
  const { toRaw, templateName, language, variables, clientName, sourcePage } = req.body;
  if (!toRaw || !templateName) return res.status(400).json({ error: 'toRaw and templateName required' });
  const result = await wa.sendTemplateMessage({ toRaw, templateName, language, variables, clientName, sourcePage });
  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

// ── Send to many (bulk) — returns array of results ──
router.post('/send-bulk', requireSendWhatsApp, async (req, res) => {
  const { recipients, templateName, language, sourcePage } = req.body;
  // recipients: [{ toRaw, variables: [...], clientName }]
  if (!Array.isArray(recipients) || !recipients.length || !templateName) {
    return res.status(400).json({ error: 'recipients[] and templateName required' });
  }
  const results = [];
  for (const r of recipients) {
    const result = await wa.sendTemplateMessage({
      toRaw: r.toRaw, templateName, language, variables: r.variables || [],
      clientName: r.clientName, sourcePage,
    });
    results.push({ to: r.toRaw, ...result });
    await new Promise(resolve => setTimeout(resolve, 250)); // gentle pacing, avoid rate limits
  }
  res.json({ results });
});

// ── Log ──
router.get('/log', (req, res) => {
  const { status, source_page, q, from, to, limit } = req.query;
  let sql = 'SELECT * FROM wa_log WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (source_page) { sql += ' AND source_page = ?'; params.push(source_page); }
  if (q) { sql += ' AND (client_name LIKE ? OR to_number LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  if (from) { sql += ' AND date(created_at) >= date(?)'; params.push(from); }
  if (to) { sql += ' AND date(created_at) <= date(?)'; params.push(to); }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(parseInt(limit) || 500);
  res.json(db.prepare(sql).all(...params));
});

// Manually re-trigger the retry queue right now (used by a "Retry Failed" button)
router.post('/retry-now', requireSendWhatsApp, async (req, res) => {
  const count = await wa.processRetryQueue();
  res.json({ success: true, retried: count });
});

// ── Inbound replies from clients ──
router.get('/replies', (req, res) => {
  const { unread_only, limit } = req.query;
  let sql = 'SELECT * FROM wa_replies WHERE 1=1';
  if (unread_only === 'true') sql += ' AND read_by_user = 0';
  sql += ' ORDER BY id DESC LIMIT ?';
  res.json(db.prepare(sql).all(parseInt(limit) || 200));
});

router.get('/replies/unread-count', (req, res) => {
  const row = db.prepare('SELECT COUNT(*) c FROM wa_replies WHERE read_by_user = 0').get();
  res.json({ count: row.c });
});

router.post('/replies/:id/mark-read', (req, res) => {
  db.prepare('UPDATE wa_replies SET read_by_user = 1 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

router.post('/replies/mark-all-read', (req, res) => {
  db.prepare('UPDATE wa_replies SET read_by_user = 1 WHERE read_by_user = 0').run();
  res.json({ success: true });
});

// ── Meta Webhook (delivery/read status callbacks + inbound messages) ──
// GET = verification handshake, POST = status updates & incoming messages
// Exported as standalone handlers too (see bottom of file) because this path must
// be reachable WITHOUT our own JWT auth — Meta calls it directly with no such header.
function logWebhookEvent(eventType, detail) {
  try {
    db.prepare(`INSERT INTO wa_webhook_events (event_type, detail) VALUES (?, ?)`).run(eventType, detail || null);
    // Keep this log from growing forever — last 500 events is plenty for diagnostics.
    db.prepare(`DELETE FROM wa_webhook_events WHERE id NOT IN (SELECT id FROM wa_webhook_events ORDER BY id DESC LIMIT 500)`).run();
  } catch (e) { /* logging failure shouldn't break the actual webhook response */ }
}

function webhookVerify(req, res) {
  const verifyToken = wa.getSetting('wa_webhook_verify_token') || process.env.WA_WEBHOOK_VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  logWebhookEvent('verify_attempt', `mode=${mode || '(none)'} token_received=${token ? '(set)' : '(missing)'}`);
  if (mode === 'subscribe' && token === verifyToken) {
    logWebhookEvent('verify_success', 'Token matched — webhook verified');
    return res.status(200).send(challenge);
  }
  logWebhookEvent('verify_failed', verifyToken
    ? 'Token mismatch — the value Meta sent does not match Settings → Webhook Verify Token'
    : 'No verify token saved in Settings yet');
  res.sendStatus(403);
}

function webhookReceive(req, res) {
  try {
    const entry = req.body.entry || [];
    for (const e of entry) {
      const changes = e.changes || [];
      for (const c of changes) {
        const value = c.value || {};
        // Outbound message status updates (sent/delivered/read/failed)
        if (value.statuses) {
          for (const s of value.statuses) {
            wa.updateStatusFromWebhook(s.id, s.status, s.errors ? s.errors[0].title : null);
            logWebhookEvent('status_callback', `${s.status} for message ${s.id}`);
          }
        }
        // Inbound messages FROM the client TO this business number
        if (value.messages) {
          for (const m of value.messages) {
            const text = m.text ? m.text.body : (m.button ? m.button.text : `[${m.type || 'message'}]`);
            wa.recordInboundMessage(m.from, text, m.id);
            logWebhookEvent('inbound_message', `From ${m.from}: ${(text || '').slice(0, 80)}`);
          }
        }
      }
    }
  } catch (err) {
    console.error('Webhook processing error', err);
    logWebhookEvent('processing_error', err.message);
  }
  res.sendStatus(200);
}

router.get('/webhook', webhookVerify);
router.post('/webhook', webhookReceive);

// ── Webhook Health Sheet — everything needed to self-diagnose without dev tools ──
router.get('/webhook-health', requireManageSettings, (req, res) => {
  const verifyTokenSaved = !!wa.getSetting('wa_webhook_verify_token');
  const recentEvents = db.prepare('SELECT * FROM wa_webhook_events ORDER BY id DESC LIMIT 30').all();
  const lastVerifySuccess = db.prepare(`SELECT * FROM wa_webhook_events WHERE event_type = 'verify_success' ORDER BY id DESC LIMIT 1`).get();
  const lastVerifyFailed = db.prepare(`SELECT * FROM wa_webhook_events WHERE event_type = 'verify_failed' ORDER BY id DESC LIMIT 1`).get();
  const lastStatusCallback = db.prepare(`SELECT * FROM wa_webhook_events WHERE event_type = 'status_callback' ORDER BY id DESC LIMIT 1`).get();
  const lastInbound = db.prepare(`SELECT * FROM wa_webhook_events WHERE event_type = 'inbound_message' ORDER BY id DESC LIMIT 1`).get();
  const totalStatusCallbacks = db.prepare(`SELECT COUNT(*) c FROM wa_webhook_events WHERE event_type = 'status_callback'`).get().c;
  const totalInbound = db.prepare(`SELECT COUNT(*) c FROM wa_webhook_events WHERE event_type = 'inbound_message'`).get().c;
  const unreadReplies = db.prepare('SELECT COUNT(*) c FROM wa_replies WHERE read_by_user = 0').get().c;

  res.json({
    verify_token_saved: verifyTokenSaved,
    ever_verified_successfully: !!lastVerifySuccess,
    last_verify_success: lastVerifySuccess ? lastVerifySuccess.received_at : null,
    last_verify_failed: lastVerifyFailed ? { at: lastVerifyFailed.received_at, reason: lastVerifyFailed.detail } : null,
    last_status_callback: lastStatusCallback ? lastStatusCallback.received_at : null,
    last_inbound_message: lastInbound ? lastInbound.received_at : null,
    total_status_callbacks_received: totalStatusCallbacks,
    total_inbound_messages_received: totalInbound,
    unread_replies: unreadReplies,
    recent_events: recentEvents,
  });
});

module.exports = router;
module.exports.webhookVerify = webhookVerify;
module.exports.webhookReceive = webhookReceive;
