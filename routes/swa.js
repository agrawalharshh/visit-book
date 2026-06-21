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

// ── Move selected Swa Data rows → Swa Selected, then send WA message to ONE target number ──
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

module.exports = router;
