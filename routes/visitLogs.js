// routes/visitLogs.js
const express = require('express');
const db = require('../db/init');

const router = express.Router();

// Get all visit logs for a given client (either table)
router.get('/', (req, res) => {
  const { client_id, client_table } = req.query;
  if (!client_id || !client_table) return res.status(400).json({ error: 'client_id and client_table required' });
  const logs = db.prepare(`SELECT * FROM visit_logs WHERE client_id = ? AND client_table = ? ORDER BY visit_date DESC, id DESC`)
    .all(client_id, client_table);
  res.json(logs);
});

// Log a new visit — adds a row to visit_logs AND updates the parent record's
// last_visit / follow_up_date / lead_status / remarks (remarks = latest snapshot,
// full history stays in visit_logs).
router.post('/', (req, res) => {
  const { client_id, client_table, visit_date, next_follow_up_date, lead_status, remarks } = req.body;
  if (!client_id || !client_table || !visit_date) {
    return res.status(400).json({ error: 'client_id, client_table and visit_date are required' });
  }
  const table = client_table === 'active_clients' ? 'active_clients' : 'visit_clients';

  const info = db.prepare(`INSERT INTO visit_logs (client_id, client_table, visit_date, next_follow_up_date, lead_status, remarks)
    VALUES (?, ?, ?, ?, ?, ?)`).run(client_id, table, visit_date, next_follow_up_date || null, lead_status || null, remarks || '');

  // Keep the parent row's quick-glance fields in sync with the latest log entry
  if (table === 'visit_clients') {
    const sets = [`last_visit = ?`, `updated_at = datetime('now')`];
    const vals = [visit_date];
    if (next_follow_up_date !== undefined) { sets.push('follow_up_date = ?'); vals.push(next_follow_up_date || null); }
    if (lead_status) { sets.push('lead_status = ?'); vals.push(lead_status); }
    if (remarks !== undefined) { sets.push('remarks = ?'); vals.push(remarks); }
    vals.push(client_id);
    db.prepare(`UPDATE visit_clients SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  } else {
    const sets = [`updated_at = datetime('now')`];
    const vals = [];
    if (remarks !== undefined) { sets.push('remarks = ?'); vals.push(remarks); }
    vals.push(client_id);
    db.prepare(`UPDATE active_clients SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  const log = db.prepare('SELECT * FROM visit_logs WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(log);
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM visit_logs WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Convert a Visit Client → Active Client ──
// Deletes the visit_clients row, creates a fresh active_clients row, and re-points
// all of its visit_logs rows at the new active_clients id so history travels with it.
router.post('/convert/:visitClientId', (req, res) => {
  const visitClientId = parseInt(req.params.visitClientId);
  const vc = db.prepare('SELECT * FROM visit_clients WHERE id = ?').get(visitClientId);
  if (!vc) return res.status(404).json({ error: 'Visit client not found' });

  const { monthly_value } = req.body || {};

  const tx = db.transaction(() => {
    const info = db.prepare(`INSERT INTO active_clients (name, area, address, landmark, location, phone, business, monthly_value, status, remarks, converted_from_visit_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Active', ?, ?)`)
      .run(vc.name, vc.area, vc.address, vc.landmark, vc.location, vc.phone, vc.business, monthly_value || 0, vc.remarks, vc.id);
    const newActiveId = info.lastInsertRowid;

    // Re-point visit history to the new active client record
    db.prepare(`UPDATE visit_logs SET client_id = ?, client_table = 'active_clients' WHERE client_id = ? AND client_table = 'visit_clients'`)
      .run(newActiveId, visitClientId);

    // Re-point any scheduled meetings sourced from this visit client too
    db.prepare(`UPDATE meetings SET source_id = ?, source_type = 'active_client' WHERE source_id = ? AND source_type = 'visit_client'`)
      .run(newActiveId, visitClientId);

    db.prepare('DELETE FROM visit_clients WHERE id = ?').run(visitClientId);

    return newActiveId;
  });

  const newActiveId = tx();
  const newRecord = db.prepare('SELECT * FROM active_clients WHERE id = ?').get(newActiveId);
  res.status(201).json(newRecord);
});

module.exports = router;
