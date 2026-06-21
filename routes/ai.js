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

module.exports = router;
