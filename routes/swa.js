// routes/swa.js
const express = require('express');
const db = require('../db/init');
const wa = require('../services/whatsapp');

const router = express.Router();

// ── Swa Data ──
router.get('/data', (req, res) => {
  res.json(db.prepare('SELECT * FROM swa_data ORDER BY id DESC').all());
});

router.post('/data', (req, res) => {
  const { sr, company, client, phone, address, remarks } = req.body;
  const info = db.prepare('INSERT INTO swa_data (sr, company, client, phone, address, remarks) VALUES (?,?,?,?,?,?)')
    .run(sr || '', company || '', client || '', phone || '', address || '', remarks || '');
  res.status(201).json(db.prepare('SELECT * FROM swa_data WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/data/:id', (req, res) => {
  const { sr, company, client, phone, address, remarks } = req.body;
  db.prepare('UPDATE swa_data SET sr=?, company=?, client=?, phone=?, address=?, remarks=? WHERE id=?')
    .run(sr, company, client, phone, address, remarks, req.params.id);
  res.json(db.prepare('SELECT * FROM swa_data WHERE id = ?').get(req.params.id));
});

router.delete('/data/:id', (req, res) => {
  db.prepare('DELETE FROM swa_data WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Bulk import (from CSV/Excel: SR, COMPANY, CLIENT, PHONE, ADDRESS, REMARKS)
router.post('/data/bulk-import', (req, res) => {
  const rows = req.body.rows || [];
  const insert = db.prepare('INSERT INTO swa_data (sr, company, client, phone, address, remarks) VALUES (?,?,?,?,?,?)');
  const tx = db.transaction((rows) => {
    let count = 0;
    for (const r of rows) {
      if (!r.client && !r.company) continue;
      insert.run(r.sr || '', r.company || '', r.client || '', r.phone || '', r.address || '', r.remarks || '');
      count++;
    }
    return count;
  });
  const count = tx(rows);
  res.json({ added: count });
});

// ── Move selected Swa Data rows → Swa Selected, then send ONE WA message to ONE target number ──
// (e.g. sending a consolidated lead list to your dispatch/team number)
router.post('/move-and-send', async (req, res) => {
  const { ids, targetNumber, templateName, language, messageOverrideVariables } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids[] required' });
  if (!targetNumber) return res.status(400).json({ error: 'targetNumber required' });
  if (!templateName) return res.status(400).json({ error: 'templateName required' });

  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM swa_data WHERE id IN (${placeholders})`).all(...ids);
  if (!rows.length) return res.status(404).json({ error: 'No matching rows found' });

  const batchId = 'batch_' + Date.now();

  // Build a readable list to send as a template variable (e.g. {{1}} = summary text)
  const listText = rows.map((r, i) =>
    `${i + 1}. ${r.company || '-'} | ${r.client || '-'} | ${r.phone || '-'} | ${r.address || '-'} | ${r.remarks || '-'}`
  ).join('\n');

  const variables = messageOverrideVariables && messageOverrideVariables.length
    ? messageOverrideVariables
    : [String(rows.length), listText];

  const sendResult = await wa.sendTemplateMessage({
    toRaw: targetNumber,
    templateName,
    language,
    variables,
    clientName: `Swa batch (${rows.length} rows)`,
    sourcePage: 'swa_selected',
  });

  const insertSel = db.prepare(`INSERT INTO swa_selected (sr, company, client, phone, address, remarks, sent_to_number, batch_id, wa_log_id)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const deleteData = db.prepare('DELETE FROM swa_data WHERE id = ?');

  const tx = db.transaction((rows) => {
    for (const r of rows) {
      insertSel.run(r.sr, r.company, r.client, r.phone, r.address, r.remarks, targetNumber, batchId, sendResult.logId || null);
      deleteData.run(r.id);
    }
  });
  tx(rows);

  res.json({ success: sendResult.success, moved: rows.length, batchId, sendResult });
});

// ── Move selected Swa Data rows → Swa Selected, sending EACH row its OWN message
//    to its OWN phone number (e.g. 5 rows selected → 5 separate WhatsApp sends).
//    fieldMapping maps template variable position -> swa_data column name, e.g.
//    { "1": "company", "2": "client", "3": "phone" } fills {{1}},{{2}},{{3}}. ──
router.post('/move-and-send-individual', async (req, res) => {
  const { ids, templateName, language, fieldMapping } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids[] required' });
  if (!templateName) return res.status(400).json({ error: 'templateName required' });
  if (!fieldMapping || !Object.keys(fieldMapping).length) return res.status(400).json({ error: 'fieldMapping required, e.g. {"1":"company","2":"phone"}' });

  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM swa_data WHERE id IN (${placeholders})`).all(...ids);
  if (!rows.length) return res.status(404).json({ error: 'No matching rows found' });
  if (rows.some(r => !r.phone)) {
    return res.status(400).json({ error: 'One or more selected rows has no phone number — every row needs a phone to send individually.' });
  }

  const batchId = 'batch_' + Date.now();
  const varPositions = Object.keys(fieldMapping).map(Number).sort((a, b) => a - b);
  const insertSel = db.prepare(`INSERT INTO swa_selected (sr, company, client, phone, address, remarks, sent_to_number, batch_id, wa_log_id)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const deleteData = db.prepare('DELETE FROM swa_data WHERE id = ?');

  const results = [];
  for (const r of rows) {
    const variables = varPositions.map(pos => r[fieldMapping[pos]] ?? r[fieldMapping[String(pos)]] ?? '');
    const sendResult = await wa.sendTemplateMessage({
      toRaw: r.phone, templateName, language, variables,
      clientName: r.client || r.company, sourcePage: 'swa_selected',
    });
    insertSel.run(r.sr, r.company, r.client, r.phone, r.address, r.remarks, r.phone, batchId, sendResult.logId || null);
    deleteData.run(r.id);
    results.push({ id: r.id, client: r.client, phone: r.phone, ...sendResult });
    await new Promise(resolve => setTimeout(resolve, 250)); // gentle pacing, avoid hitting Meta rate limits
  }

  const failCount = results.filter(r => !r.success).length;
  res.json({ success: failCount === 0, moved: rows.length, sent: rows.length - failCount, failed: failCount, batchId, results });
});

// ── Swa Selected ──
router.get('/selected', (req, res) => {
  res.json(db.prepare('SELECT * FROM swa_selected ORDER BY id DESC').all());
});

router.delete('/selected/:id', (req, res) => {
  db.prepare('DELETE FROM swa_selected WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Move a selected row back to Swa Data (undo)
router.post('/selected/:id/restore', (req, res) => {
  const row = db.prepare('SELECT * FROM swa_selected WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('INSERT INTO swa_data (sr, company, client, phone, address, remarks) VALUES (?,?,?,?,?,?)')
    .run(row.sr, row.company, row.client, row.phone, row.address, row.remarks);
  db.prepare('DELETE FROM swa_selected WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── AI: auto-sort all Swa Selected rows by area, parsed from their address field ──
// Surat-area trade addresses are messy free text ("Ring Road opp Hotel X", "Katargam
// Char Rasta near...", etc.) so a simple keyword match misses a lot. This sends rows
// in batches to OpenAI, asking it to extract just the locality/area name for each.
router.post('/selected/ai-sort-by-area', async (req, res) => {
  const ai = require('../services/openai');
  if (!ai.isConfigured()) {
    return res.status(400).json({ error: 'OpenAI not configured. Go to Settings → AI Features and add your API key.' });
  }
  const rows = db.prepare(`SELECT id, address FROM swa_selected WHERE ai_area IS NULL OR ai_area = ''`).all();
  if (!rows.length) return res.json({ success: true, updated: 0, message: 'Nothing to sort — every row already has an area.' });

  const BATCH_SIZE = 25;
  let updated = 0;
  const updateStmt = db.prepare('UPDATE swa_selected SET ai_area = ? WHERE id = ?');

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const listText = batch.map(r => `${r.id}: ${r.address || '(no address)'}`).join('\n');
    const result = await ai.chat([
      {
        role: 'system',
        content: 'You extract just the locality/area name (e.g. "Varachha", "Katargam", "Ring Road", "Adajan") from messy Indian trade addresses, for a Surat textile business. Respond with STRICT JSON only: an object mapping each input id to its area string, e.g. {"12": "Varachha", "13": "Katargam"}. If an address is empty or no area can be determined, use "Unknown". No markdown, no explanation.',
      },
      { role: 'user', content: listText },
    ], { maxTokens: 1000 });

    if (!result.success) continue; // skip this batch on failure, rest of sort still proceeds
    try {
      const cleaned = result.text.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      const tx = db.transaction((entries) => {
        for (const [id, area] of entries) {
          updateStmt.run(area || 'Unknown', id);
          updated++;
        }
      });
      tx(Object.entries(parsed));
    } catch (e) {
      continue; // malformed AI response for this batch — skip, don't crash the whole sort
    }
  }

  res.json({ success: true, updated, total: rows.length });
});

module.exports = router;
