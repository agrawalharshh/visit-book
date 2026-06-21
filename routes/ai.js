// routes/ai.js
const express = require('express');
const multer = require('multer');
const db = require('../db/init');
const ai = require('../services/openai');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

router.get('/status', (req, res) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('openai_api_key');
  res.json({ configured: ai.isConfigured(), masked_key: maskKey(row ? row.value : '') });
});

function maskKey(k) {
  if (!k) return '';
  if (k.length <= 8) return '••••••••';
  return k.slice(0, 4) + '••••••••' + k.slice(-4);
}

router.post('/settings', (req, res) => {
  const { openai_api_key } = req.body;
  if (openai_api_key && !openai_api_key.includes('••••')) {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('openai_api_key', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(openai_api_key);
  }
  res.json({ success: true });
});

// ── 1. Summarize a client's visit history into one line ──
router.post('/summarize-history', async (req, res) => {
  const { client_id, client_table } = req.body;
  if (!client_id || !client_table) return res.status(400).json({ error: 'client_id and client_table required' });
  const logs = db.prepare(`SELECT visit_date, lead_status, remarks FROM visit_logs WHERE client_id = ? AND client_table = ? ORDER BY visit_date ASC`)
    .all(client_id, client_table);
  if (!logs.length) return res.json({ success: true, text: 'No visit history yet.' });

  const historyText = logs.map(l => `${l.visit_date} [${l.lead_status || '—'}]: ${l.remarks || '(no remarks)'}`).join('\n');
  const result = await ai.chat([
    { role: 'system', content: 'You summarize a salesperson\'s client visit history into ONE short, plain sentence (max 25 words) a busy person can scan instantly. Focus on trend and current status, not a list of every visit. No markdown, no quotes.' },
    { role: 'user', content: `Visit history:\n${historyText}\n\nSummarize this client's journey in one sentence.` },
  ], { maxTokens: 80 });
  res.json(result);
});

// ── 2. Suggest next follow-up date based on pattern/remarks ──
router.post('/suggest-followup', async (req, res) => {
  const { client_id, client_table } = req.body;
  if (!client_id || !client_table) return res.status(400).json({ error: 'client_id and client_table required' });
  const logs = db.prepare(`SELECT visit_date, lead_status, remarks FROM visit_logs WHERE client_id = ? AND client_table = ? ORDER BY visit_date ASC`)
    .all(client_id, client_table);
  const today = new Date().toISOString().split('T')[0];
  if (!logs.length) return res.json({ success: true, suggested_date: null, reason: 'No visit history yet to base a suggestion on.' });

  const historyText = logs.map(l => `${l.visit_date} [${l.lead_status || '—'}]: ${l.remarks || ''}`).join('\n');
  const result = await ai.chat([
    { role: 'system', content: `Today's date is ${today}. Based on a client's visit history and remarks, suggest the best next follow-up date. Respond with STRICT JSON only, no markdown: {"date": "YYYY-MM-DD", "reason": "short reason under 15 words"}` },
    { role: 'user', content: `Visit history:\n${historyText}\n\nSuggest the next follow-up date.` },
  ], { maxTokens: 100 });

  if (!result.success) return res.json(result);
  try {
    const cleaned = result.text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    res.json({ success: true, suggested_date: parsed.date, reason: parsed.reason });
  } catch (e) {
    res.json({ success: true, suggested_date: null, reason: result.text });
  }
});

// ── 3. Draft a WhatsApp message from visit remarks ──
router.post('/draft-message', async (req, res) => {
  const { client_name, remarks, tone } = req.body;
  if (!remarks) return res.status(400).json({ error: 'remarks required' });
  const result = await ai.chat([
    { role: 'system', content: `You draft short, friendly WhatsApp business messages in ${tone || 'polite, professional'} Hindi-English (Hinglish is fine if natural) tone for a textile/saree wholesale trade context in Surat, India. Keep it under 50 words. No markdown, no emoji overload (max 1-2 emoji), ready to send as-is.` },
    { role: 'user', content: `Client: ${client_name || 'the client'}\nRecent visit remarks: ${remarks}\n\nDraft a WhatsApp follow-up message based on this.` },
  ], { maxTokens: 150 });
  res.json(result);
});

// ── 4. Voice-to-text for logging a visit ──
router.post('/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'audio file required' });
  const result = await ai.transcribeAudio(req.file.buffer, req.file.originalname, req.file.mimetype);
  res.json(result);
});

// ── 5. Smart lead scoring — suggest Hot/Cold based on remarks history ──
router.post('/suggest-lead-status', async (req, res) => {
  const { client_id, client_table } = req.body;
  if (!client_id || !client_table) return res.status(400).json({ error: 'client_id and client_table required' });
  const logs = db.prepare(`SELECT visit_date, lead_status, remarks FROM visit_logs WHERE client_id = ? AND client_table = ? ORDER BY visit_date ASC`)
    .all(client_id, client_table);
  if (!logs.length) return res.json({ success: true, suggested_status: null, reason: 'No visit history yet.' });

  const historyText = logs.map(l => `${l.visit_date} [${l.lead_status || '—'}]: ${l.remarks || ''}`).join('\n');
  const result = await ai.chat([
    { role: 'system', content: 'Based on a client\'s visit history, classify them as exactly "Hot" or "Cold" for sales follow-up priority. Respond with STRICT JSON only: {"status": "Hot" or "Cold", "reason": "short reason under 15 words"}' },
    { role: 'user', content: `Visit history:\n${historyText}\n\nClassify this lead.` },
  ], { maxTokens: 80 });

  if (!result.success) return res.json(result);
  try {
    const cleaned = result.text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    res.json({ success: true, suggested_status: parsed.status, reason: parsed.reason });
  } catch (e) {
    res.json({ success: true, suggested_status: null, reason: result.text });
  }
});

// ── 6. Daily Visit Plan — which Hot leads + overdue follow-ups to prioritize today,
//      clustered by area so the route makes sense for someone actually driving it ──
router.post('/daily-plan', async (req, res) => {
  if (!ai.isConfigured()) return res.json({ success: false, error: 'OpenAI not configured. Go to Settings → AI Features.' });

  const today = new Date().toISOString().split('T')[0];
  const overdue = db.prepare(`
    SELECT name, area, phone, lead_status, follow_up_date, remarks FROM visit_clients
    WHERE follow_up_date IS NOT NULL AND follow_up_date != '' AND date(follow_up_date) <= date('now')
    ORDER BY area, follow_up_date ASC LIMIT 60
  `).all();
  const hotNoFollowup = db.prepare(`
    SELECT name, area, phone, lead_status, remarks FROM visit_clients
    WHERE lead_status = 'Hot' AND (follow_up_date IS NULL OR follow_up_date = '')
    ORDER BY area LIMIT 30
  `).all();

  if (!overdue.length && !hotNoFollowup.length) {
    return res.json({ success: true, text: 'Nothing pending — no overdue follow-ups and no unscheduled Hot leads. Clear day!' });
  }

  const dataText = [
    overdue.length ? `OVERDUE/DUE TODAY FOLLOW-UPS:\n${overdue.map(c => `- ${c.name} | ${c.area || 'no area'} | ${c.lead_status || '-'} | due ${c.follow_up_date} | ${c.remarks || ''}`).join('\n')}` : '',
    hotNoFollowup.length ? `HOT LEADS WITH NO FOLLOW-UP SCHEDULED:\n${hotNoFollowup.map(c => `- ${c.name} | ${c.area || 'no area'} | ${c.remarks || ''}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');

  const result = await ai.chat([
    {
      role: 'system',
      content: `Today is ${today}. You build a practical daily visit plan for a textile-trade field salesperson in Surat, India. Group clients by AREA so the route is efficient (don't zigzag across the city). Prioritize overdue items first, then Hot leads. Keep it concise — area headers, then a short bullet per client with WHY they matter (e.g. "3 days overdue", "Hot, ready to order"). Plain text, no markdown headers, use simple line breaks. Max 200 words.`,
    },
    { role: 'user', content: dataText },
  ], { maxTokens: 500 });

  res.json(result);
});

// ── 7. Reorder Prediction — for Active Clients, flag who's "due" to reorder based
//      on their own historical order cadence (gap between past orders) ──
router.get('/reorder-predictions', (req, res) => {
  // This one is plain math, not an LLM call — more reliable and instant for a
  // pattern this regular. Runs for every active client with 2+ orders.
  const clients = db.prepare('SELECT id, name, area, phone FROM active_clients').all();
  const predictions = [];

  for (const c of clients) {
    const orders = db.prepare('SELECT order_date FROM orders WHERE active_client_id = ? ORDER BY order_date ASC').all(c.id);
    if (orders.length < 2) continue;

    const gaps = [];
    for (let i = 1; i < orders.length; i++) {
      const d1 = new Date(orders[i - 1].order_date);
      const d2 = new Date(orders[i].order_date);
      gaps.push((d2 - d1) / (1000 * 60 * 60 * 24));
    }
    const avgGapDays = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const lastOrderDate = new Date(orders[orders.length - 1].order_date);
    const daysSinceLastOrder = Math.round((new Date() - lastOrderDate) / (1000 * 60 * 60 * 24));
    const expectedNextOrderIn = Math.round(avgGapDays - daysSinceLastOrder);

    // Flag as "due soon" or "overdue" if we're within 20% of their typical gap or past it
    if (daysSinceLastOrder >= avgGapDays * 0.8) {
      predictions.push({
        client_id: c.id, name: c.name, area: c.area, phone: c.phone,
        avg_gap_days: Math.round(avgGapDays),
        days_since_last_order: daysSinceLastOrder,
        status: daysSinceLastOrder >= avgGapDays ? 'overdue' : 'due_soon',
        expected_next_order_in_days: expectedNextOrderIn,
      });
    }
  }

  predictions.sort((a, b) => (a.status === 'overdue' ? -1 : 1) - (b.status === 'overdue' ? -1 : 1));
  res.json(predictions);
});

// ── 8. Weekly Digest — AI summary of the week's visits, orders, and targets ──
router.post('/weekly-digest', async (req, res) => {
  if (!ai.isConfigured()) return res.json({ success: false, error: 'OpenAI not configured. Go to Settings → AI Features.' });

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const visitsLogged = db.prepare(`SELECT COUNT(*) c FROM visit_logs WHERE date(visit_date) >= date(?)`).get(weekAgo).c;
  const newClients = db.prepare(`SELECT COUNT(*) c FROM visit_clients WHERE date(created_at) >= date(?)`).get(weekAgo).c;
  const converted = db.prepare(`SELECT COUNT(*) c FROM active_clients WHERE date(created_at) >= date(?) AND converted_from_visit_id IS NOT NULL`).get(weekAgo).c;
  const orders = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(total_amount),0) v FROM orders WHERE date(order_date) >= date(?)`).get(weekAgo);
  const waSent = db.prepare(`SELECT COUNT(*) c FROM wa_log WHERE date(created_at) >= date(?) AND status IN ('sent','delivered','read')`).get(weekAgo).c;
  const waFailed = db.prepare(`SELECT COUNT(*) c FROM wa_log WHERE date(created_at) >= date(?) AND status = 'failed'`).get(weekAgo).c;
  const topAreas = db.prepare(`SELECT area, COUNT(*) c FROM visit_logs vl JOIN visit_clients vc ON vc.id = vl.client_id AND vl.client_table='visit_clients' WHERE date(vl.visit_date) >= date(?) AND vc.area IS NOT NULL GROUP BY vc.area ORDER BY c DESC LIMIT 5`).all(weekAgo);

  const dataText = `
Visits logged this week: ${visitsLogged}
New prospects added: ${newClients}
Prospects converted to active clients: ${converted}
Orders placed: ${orders.c}, total value ₹${orders.v}
WhatsApp messages sent: ${waSent}, failed: ${waFailed}
Top areas visited: ${topAreas.map(a => `${a.area} (${a.c})`).join(', ') || 'none'}
  `.trim();

  const result = await ai.chat([
    { role: 'system', content: 'You write a brief, friendly weekly business digest (under 120 words) for the owner of a Surat textile wholesale trading business, based on their CRM activity numbers. Plain text, no markdown. Mention what went well and one area that may need attention, in a natural conversational tone.' },
    { role: 'user', content: dataText },
  ], { maxTokens: 300 });

  res.json(result);
});

module.exports = router;
