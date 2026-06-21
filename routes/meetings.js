// routes/meetings.js
const express = require('express');
const db = require('../db/init');

const router = express.Router();

router.get('/', (req, res) => {
  const { from, to, status } = req.query;
  let sql = 'SELECT * FROM meetings WHERE 1=1';
  const params = [];
  if (from) { sql += ' AND date(meeting_date) >= date(?)'; params.push(from); }
  if (to) { sql += ' AND date(meeting_date) <= date(?)'; params.push(to); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY meeting_date ASC, meeting_time ASC';
  res.json(db.prepare(sql).all(...params));
});

router.post('/', (req, res) => {
  const { client_name, phone, area, meeting_date, meeting_time, notes, status, source_type, source_id } = req.body;
  if (!client_name || !meeting_date) return res.status(400).json({ error: 'client_name and meeting_date required' });
  const info = db.prepare(`INSERT INTO meetings (client_name, phone, area, meeting_date, meeting_time, notes, status, source_type, source_id)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(client_name, phone || '', area || '', meeting_date, meeting_time || '', notes || '', status || 'Scheduled', source_type || 'manual', source_id || null);
  res.status(201).json(db.prepare('SELECT * FROM meetings WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/:id', (req, res) => {
  const { client_name, phone, area, meeting_date, meeting_time, notes, status } = req.body;
  db.prepare(`UPDATE meetings SET client_name=?, phone=?, area=?, meeting_date=?, meeting_time=?, notes=?, status=?, updated_at=datetime('now') WHERE id=?`)
    .run(client_name, phone, area, meeting_date, meeting_time, notes, status, req.params.id);
  res.json(db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM meetings WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
