// routes/executives.js
const express = require('express');
const db = require('../db/init');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM sales_executives ORDER BY active DESC, name ASC').all());
});

router.post('/', (req, res) => {
  const { name, phone } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const info = db.prepare('INSERT INTO sales_executives (name, phone, active) VALUES (?, ?, 1)').run(name.trim(), (phone || '').trim());
  res.status(201).json(db.prepare('SELECT * FROM sales_executives WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/:id', (req, res) => {
  const { name, phone, active } = req.body;
  db.prepare('UPDATE sales_executives SET name = COALESCE(?, name), phone = COALESCE(?, phone), active = COALESCE(?, active) WHERE id = ?')
    .run(name, phone, active === undefined ? undefined : (active ? 1 : 0), req.params.id);
  res.json(db.prepare('SELECT * FROM sales_executives WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req, res) => {
  // Soft-delete (deactivate) rather than hard-delete, since active_clients.converted_by
  // may reference this executive — we don't want historical attribution to break.
  db.prepare('UPDATE sales_executives SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
