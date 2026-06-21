// routes/targets.js — weekly tonnage targets per sales executive, with shortfall rollover
const express = require('express');
const db = require('../db/init');

const router = express.Router();

// Returns the Monday (ISO date) of the week containing the given date
function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay(); // 0 = Sunday
  const diff = (day === 0 ? -6 : 1) - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().split('T')[0];
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

// Sums actual tons fulfilled by a given executive within [weekStart, weekStart+6],
// computed from Orders' line items where unit='tons' (kg lines are converted /1000).
function actualTonsForWeek(executiveId, weekStart) {
  const weekEnd = addDays(weekStart, 6);
  const rows = db.prepare(`
    SELECT oi.qty, oi.unit
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN active_clients ac ON ac.id = o.active_client_id
    WHERE ac.converted_by = ?
      AND date(o.order_date) BETWEEN date(?) AND date(?)
  `).all(executiveId, weekStart, weekEnd);
  return rows.reduce((sum, r) => sum + (r.unit === 'tons' ? r.qty : r.qty / 1000), 0);
}

// Set/update a target for a given executive + week. Creating this week's target
// automatically pulls forward any shortfall from the previous week as rollover_tons.
router.post('/', (req, res) => {
  const { executive_id, week_start, target_tons, notes } = req.body;
  if (!executive_id || !week_start) return res.status(400).json({ error: 'executive_id and week_start required' });
  const monday = mondayOf(week_start);
  const prevMonday = addDays(monday, -7);

  const prevTarget = db.prepare('SELECT * FROM weekly_targets WHERE executive_id = ? AND week_start = ?').get(executive_id, prevMonday);
  let rollover = 0;
  if (prevTarget) {
    const prevTotal = prevTarget.target_tons + (prevTarget.rollover_tons || 0);
    const prevActual = actualTonsForWeek(executive_id, prevMonday);
    rollover = Math.max(0, prevTotal - prevActual);
  }

  const upsert = db.prepare(`INSERT INTO weekly_targets (executive_id, week_start, target_tons, rollover_tons, notes)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(executive_id, week_start) DO UPDATE SET target_tons = excluded.target_tons, notes = excluded.notes`);
  upsert.run(executive_id, monday, parseFloat(target_tons) || 0, rollover, notes || '');

  const saved = db.prepare('SELECT * FROM weekly_targets WHERE executive_id = ? AND week_start = ?').get(executive_id, monday);
  res.status(201).json(saved);
});

// Get the target + actual + rollover picture for one executive's week (or current week if omitted)
router.get('/', (req, res) => {
  const { executive_id, week_start } = req.query;
  if (!executive_id) return res.status(400).json({ error: 'executive_id required' });
  const monday = mondayOf(week_start || new Date().toISOString().split('T')[0]);
  const target = db.prepare('SELECT * FROM weekly_targets WHERE executive_id = ? AND week_start = ?').get(executive_id, monday);
  const actual = actualTonsForWeek(executive_id, monday);
  const targetTons = target ? target.target_tons : 0;
  const rolloverTons = target ? (target.rollover_tons || 0) : 0;
  const totalDue = targetTons + rolloverTons;
  res.json({
    executive_id: parseInt(executive_id), week_start: monday,
    target_tons: targetTons, rollover_tons: rolloverTons, total_due: totalDue,
    actual_tons: Math.round(actual * 100) / 100,
    remaining_tons: Math.round(Math.max(0, totalDue - actual) * 100) / 100,
    achieved_pct: totalDue > 0 ? Math.round((actual / totalDue) * 1000) / 10 : 0,
  });
});

// Full board: every active executive's current-week picture in one call (for the Reports/Targets page)
router.get('/board', (req, res) => {
  const { week_start } = req.query;
  const monday = mondayOf(week_start || new Date().toISOString().split('T')[0]);
  const execs = db.prepare('SELECT * FROM sales_executives WHERE active = 1 ORDER BY name').all();
  const board = execs.map(ex => {
    const target = db.prepare('SELECT * FROM weekly_targets WHERE executive_id = ? AND week_start = ?').get(ex.id, monday);
    const actual = actualTonsForWeek(ex.id, monday);
    const targetTons = target ? target.target_tons : 0;
    const rolloverTons = target ? (target.rollover_tons || 0) : 0;
    const totalDue = targetTons + rolloverTons;
    return {
      target_id: target ? target.id : null,
      executive_id: ex.id, executive_name: ex.name, week_start: monday,
      target_tons: targetTons, rollover_tons: rolloverTons, total_due: totalDue,
      actual_tons: Math.round(actual * 100) / 100,
      remaining_tons: Math.round(Math.max(0, totalDue - actual) * 100) / 100,
      achieved_pct: totalDue > 0 ? Math.round((actual / totalDue) * 1000) / 10 : 0,
      has_target: !!target,
    };
  });
  res.json({ week_start: monday, board });
});

// Delete a target entry entirely for a given executive+week
router.delete('/', (req, res) => {
  const { executive_id, week_start } = req.query;
  if (!executive_id || !week_start) return res.status(400).json({ error: 'executive_id and week_start required' });
  const monday = mondayOf(week_start);
  db.prepare('DELETE FROM weekly_targets WHERE executive_id = ? AND week_start = ?').run(executive_id, monday);
  res.json({ success: true });
});

// Reset a target's tons back to 0 but KEEP the row, so future weeks' rollover
// math still has something to read (a deleted row reads as "no target ever set",
// which is different from "target was met/zeroed out").
router.post('/:id/reset', (req, res) => {
  const row = db.prepare('SELECT * FROM weekly_targets WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Target not found' });
  db.prepare('UPDATE weekly_targets SET target_tons = 0, rollover_tons = 0 WHERE id = ?').run(req.params.id);
  res.json(db.prepare('SELECT * FROM weekly_targets WHERE id = ?').get(req.params.id));
});

module.exports = router;
