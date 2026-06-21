// routes/reports.js
const express = require('express');
const db = require('../db/init');

const router = express.Router();

router.get('/summary', (req, res) => {
  const { from, to } = req.query;
  const dateFrom = from || '1970-01-01';
  const dateTo = to || '2999-12-31';

  const visitClientCount = db.prepare('SELECT COUNT(*) c FROM visit_clients').get().c;
  const activeClientCount = db.prepare('SELECT COUNT(*) c FROM active_clients').get().c;

  const visitsInRange = db.prepare(`SELECT COUNT(*) c FROM visit_clients WHERE date(last_visit) BETWEEN date(?) AND date(?)`).get(dateFrom, dateTo).c;

  const followupsPending = db.prepare(`SELECT COUNT(*) c FROM visit_clients WHERE follow_up_date IS NOT NULL AND follow_up_date != '' AND date(follow_up_date) <= date('now')`).get().c;

  const meetingsInRange = db.prepare(`SELECT COUNT(*) c FROM meetings WHERE date(meeting_date) BETWEEN date(?) AND date(?)`).get(dateFrom, dateTo).c;
  const meetingsDone = db.prepare(`SELECT COUNT(*) c FROM meetings WHERE status='Done' AND date(meeting_date) BETWEEN date(?) AND date(?)`).get(dateFrom, dateTo).c;
  const meetingsScheduled = db.prepare(`SELECT COUNT(*) c FROM meetings WHERE status='Scheduled' AND date(meeting_date) BETWEEN date(?) AND date(?)`).get(dateFrom, dateTo).c;

  const waSent = db.prepare(`SELECT COUNT(*) c FROM wa_log WHERE status IN ('sent','delivered','read') AND date(created_at) BETWEEN date(?) AND date(?)`).get(dateFrom, dateTo).c;
  const waDelivered = db.prepare(`SELECT COUNT(*) c FROM wa_log WHERE status IN ('delivered','read') AND date(created_at) BETWEEN date(?) AND date(?)`).get(dateFrom, dateTo).c;
  const waRead = db.prepare(`SELECT COUNT(*) c FROM wa_log WHERE status='read' AND date(created_at) BETWEEN date(?) AND date(?)`).get(dateFrom, dateTo).c;
  const waFailed = db.prepare(`SELECT COUNT(*) c FROM wa_log WHERE status='failed' AND date(created_at) BETWEEN date(?) AND date(?)`).get(dateFrom, dateTo).c;

  const byArea = db.prepare(`SELECT area, COUNT(*) c FROM visit_clients WHERE area IS NOT NULL AND area != '' GROUP BY area ORDER BY c DESC LIMIT 10`).all();
  const byStatus = db.prepare(`SELECT status, COUNT(*) c FROM visit_clients GROUP BY status`).all();
  const waByDay = db.prepare(`SELECT date(created_at) d, COUNT(*) c FROM wa_log WHERE date(created_at) BETWEEN date(?) AND date(?) GROUP BY date(created_at) ORDER BY d ASC`).all(dateFrom, dateTo);
  const monthlyValueTotal = db.prepare(`SELECT COALESCE(SUM(monthly_value),0) v FROM active_clients`).get().v;

  res.json({
    visitClientCount, activeClientCount, visitsInRange, followupsPending,
    meetingsInRange, meetingsDone, meetingsScheduled,
    waSent, waDelivered, waRead, waFailed,
    byArea, byStatus, waByDay, monthlyValueTotal,
  });
});

module.exports = router;
