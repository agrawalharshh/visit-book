// routes/crud.js — generic CRUD factory used by visit_clients, active_clients, meetings
const express = require('express');
const db = require('../db/init');
const { can } = require('../middleware/auth');

// columns: array of column names allowed to be written (besides id, created_at, updated_at)
// onCreate(row): optional hook called after a new row is inserted, for side effects
//   like seeding visit_logs with the client's initial remarks so nothing typed on
//   the very first Add Client form is ever silently lost once a later visit is logged.
// editPermission/deletePermission: permission names required for write/delete ops —
//   the router this is mounted on already gates GET with view_data, but POST/PUT/DELETE
//   need their own (stricter) checks since "can see records" and "can change records"
//   are different rights under this app's role model.
function makeCrudRouter(table, columns, onCreate, editPermission = 'edit_data', deletePermission = 'delete_data') {
  const router = express.Router();

  function requireEdit(req, res, next) {
    if (!can(req.user.role, editPermission)) return res.status(403).json({ error: `Your role (${req.user.role}) cannot edit this data.` });
    next();
  }
  function requireDelete(req, res, next) {
    if (!can(req.user.role, deletePermission)) return res.status(403).json({ error: `Your role (${req.user.role}) cannot delete records.` });
    next();
  }

  router.get('/', (req, res) => {
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY id DESC`).all();
    res.json(rows);
  });

  router.get('/:id', (req, res) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  });

  router.post('/', requireEdit, (req, res) => {
    const data = req.body;
    const cols = columns.filter(c => data[c] !== undefined);
    if (!cols.length) return res.status(400).json({ error: 'No valid fields' });
    const placeholders = cols.map(() => '?').join(',');
    const stmt = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`);
    const info = stmt.run(...cols.map(c => data[c]));
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(info.lastInsertRowid);
    if (onCreate) { try { onCreate(row); } catch (e) { console.error(`onCreate hook failed for ${table}:`, e); } }
    res.status(201).json(row);
  });

  router.put('/:id', requireEdit, (req, res) => {
    const data = req.body;
    const cols = columns.filter(c => data[c] !== undefined);
    if (!cols.length) return res.status(400).json({ error: 'No valid fields' });
    const setClause = cols.map(c => `${c} = ?`).join(', ');
    const stmt = db.prepare(`UPDATE ${table} SET ${setClause}, updated_at = datetime('now') WHERE id = ?`);
    stmt.run(...cols.map(c => data[c]), req.params.id);
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  });

  router.delete('/:id', requireDelete, (req, res) => {
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(req.params.id);
    res.json({ success: true });
  });

  // Bulk import (used by CSV/Excel import on frontend)
  router.post('/bulk-import', requireEdit, (req, res) => {
    const rows = req.body.rows || [];
    let added = 0, updated = 0;
    const findStmt = db.prepare(`SELECT id FROM ${table} WHERE name = ? AND area = ?`);
    const insertCols = columns;
    const insertStmt = db.prepare(`INSERT INTO ${table} (${insertCols.join(',')}) VALUES (${insertCols.map(() => '?').join(',')})`);
    const updateStmt = db.prepare(`UPDATE ${table} SET ${insertCols.map(c => c + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`);

    const tx = db.transaction((rows) => {
      for (const rec of rows) {
        if (!rec.name) continue;
        const existing = findStmt.get(rec.name, rec.area || '');
        const vals = insertCols.map(c => {
          if (rec[c] !== undefined && rec[c] !== '') return rec[c];
          if (c === 'status') return table === 'visit_clients' ? 'Prospect' : 'Active';
          if (c === 'lead_status') return 'Cold';
          return '';
        });
        if (existing) {
          updateStmt.run(...vals, existing.id);
          updated++;
        } else {
          insertStmt.run(...vals);
          added++;
        }
      }
    });
    tx(rows);
    res.json({ added, updated });
  });

  return router;
}

module.exports = makeCrudRouter;
