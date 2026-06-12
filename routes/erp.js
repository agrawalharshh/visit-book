// ERP routes — no auth required (same-domain internal tool)
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../models/db');

async function ensureErpTables() {
  await run(`CREATE TABLE IF NOT EXISTS erp_data (
    id TEXT PRIMARY KEY,
    table_name TEXT NOT NULL UNIQUE,
    data TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  await run(`CREATE TABLE IF NOT EXISTS sm_data (
    id TEXT PRIMARY KEY,
    table_name TEXT UNIQUE NOT NULL,
    data TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
}

ensureErpTables().catch(e => console.error('ERP/SM table init error:', e.message));

// ── ERP: GET single table ─────────────────────────────
router.get('/erp/:table', async (req, res) => {
  try {
    await ensureErpTables();
    const row = await get('SELECT data FROM erp_data WHERE table_name = ?', [req.params.table]);
    if (!row) return res.json([]);
    try { res.json(JSON.parse(row.data)); } catch { res.json([]); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ERP: POST (save) single table ────────────────────
router.post('/erp/:table', async (req, res) => {
  try {
    await ensureErpTables();
    const body = req.body;
    const data = JSON.stringify(
      Array.isArray(body) ? body :
      (body && typeof body === 'object') ? body : []
    );
    const existing = await get('SELECT id FROM erp_data WHERE table_name = ?', [req.params.table]);
    if (existing) {
      await run(
        "UPDATE erp_data SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE table_name = ?",
        [data, req.params.table]
      );
    } else {
      await run(
        'INSERT INTO erp_data (id, table_name, data) VALUES (?, ?, ?)',
        [uuidv4(), req.params.table, data]
      );
    }
    res.json({ ok: true });
  } catch(e) { console.error('ERP POST error:', e.message); res.status(500).json({ error: e.message }); }
});

// ── ERP: GET all tables at once ───────────────────────
router.get('/erp-all', async (req, res) => {
  try {
    await ensureErpTables();
    const rows = await all('SELECT table_name, data FROM erp_data');
    const result = {};
    rows.forEach(r => {
      try { result[r.table_name] = JSON.parse(r.data); } catch { result[r.table_name] = []; }
    });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SM: GET single table ──────────────────────────────
router.get('/sm/:table', async (req, res) => {
  try {
    await ensureErpTables();
    const row = await get('SELECT data FROM sm_data WHERE table_name = ?', [req.params.table]);
    if (!row) return res.json([]);
    try { res.json(JSON.parse(row.data)); } catch { res.json([]); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SM: POST (save) single table ─────────────────────
router.post('/sm/:table', async (req, res) => {
  try {
    await ensureErpTables();
    const data = JSON.stringify(req.body);
    const existing = await get('SELECT id FROM sm_data WHERE table_name = ?', [req.params.table]);
    if (existing) {
      await run("UPDATE sm_data SET data=?,updated_at=CURRENT_TIMESTAMP WHERE table_name=?", [data, req.params.table]);
    } else {
      await run('INSERT INTO sm_data (id,table_name,data) VALUES (?,?,?)', [uuidv4(), req.params.table, data]);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SM: GET all tables ────────────────────────────────
router.get('/sm-all', async (req, res) => {
  try {
    await ensureErpTables();
    const rows = await all('SELECT table_name, data FROM sm_data');
    const result = {};
    rows.forEach(r => { try { result[r.table_name] = JSON.parse(r.data); } catch { result[r.table_name] = []; } });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
