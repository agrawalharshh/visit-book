// routes/followups.js
const express = require('express');
const db = require('../db/init');

const router = express.Router();

// Today's + overdue follow-ups, pulled from visit_clients.follow_up_date
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM visit_clients
    WHERE follow_up_date IS NOT NULL AND follow_up_date != ''
      AND date(follow_up_date) <= date('now')
    ORDER BY date(follow_up_date) ASC
  `).all();
  res.json(rows);
});

// Set / clear a follow-up date on a visit client
router.put('/:clientId', (req, res) => {
  const { follow_up_date } = req.body;
  db.prepare(`UPDATE visit_clients SET follow_up_date=?, updated_at=datetime('now') WHERE id=?`)
    .run(follow_up_date || null, req.params.clientId);
  res.json(db.prepare('SELECT * FROM visit_clients WHERE id = ?').get(req.params.clientId));
});

// Mark done = clear the follow-up date (and optionally bump last_visit to today)
router.post('/:clientId/done', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  db.prepare(`UPDATE visit_clients SET follow_up_date=NULL, last_visit=?, updated_at=datetime('now') WHERE id=?`)
    .run(today, req.params.clientId);
  res.json({ success: true });
});

module.exports = router;
