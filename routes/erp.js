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


// ═══════════════════════════════════════════════════════════════
// REAL-TIME SYNC: SSE (Server-Sent Events)
// All connected clients get notified when any device saves data
// ═══════════════════════════════════════════════════════════════
const sseClients = new Set();

// SSE endpoint - clients connect here to receive real-time updates
router.get('/erp-sync-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Send initial connection message
  res.write('data: {"type":"connected"}\n\n');

  sseClients.add(res);

  // Keep alive ping every 25 seconds
  const keepAlive = setInterval(() => {
    res.write(':ping\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  });
});

// Broadcast to all SSE clients when data changes
function broadcastDataChange(table) {
  const msg = JSON.stringify({ type: 'data_changed', table, ts: new Date().toISOString() });
  const dead = [];
  sseClients.forEach(client => {
    try { client.write('data: ' + msg + '\n\n'); }
    catch(e) { dead.push(client); }
  });
  dead.forEach(c => sseClients.delete(c));
}


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
    // Broadcast to all other connected SSE clients that data changed
    const senderId = req.headers['x-client-id'] || '';
    broadcastDataChange(req.params.table);
    res.json({ ok: true });
  } catch(e) { console.error('ERP POST error:', e.message); res.status(500).json({ error: e.message }); }
});

// ── ERP: GET latest change timestamp (lightweight poll endpoint) ──
// Returns only the max updated_at — client uses this to detect changes
// without downloading full data. ~50 bytes per poll.
router.get('/erp-ping', async (req, res) => {
  try {
    await ensureErpTables();
    const row = await get('SELECT MAX(updated_at) as ts FROM erp_data');
    res.json({ ts: row ? row.ts : null });
  } catch(e) { res.status(500).json({ ts: null }); }
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

// ════════════════════════════════════════════════════════
// SSE — Server-Sent Events for real-time multi-device sync
// Each connected browser holds an open SSE connection.
// When any client saves data, server broadcasts to ALL others.
// ════════════════════════════════════════════════════════

const sseClients = new Map(); // clientId -> res

// SSE endpoint — browser connects here on load and keeps connection open
router.get('/erp-events', (req, res) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  const clientId = Date.now() + '-' + Math.random().toString(36).slice(2);
  sseClients.set(clientId, res);
  console.log(`SSE client connected: ${clientId} (total: ${sseClients.size})`);

  // Send a welcome ping so client knows it's connected
  res.write(`event: connected\ndata: ${JSON.stringify({ clientId, clients: sseClients.size })}\n\n`);

  // Keep-alive ping every 25 seconds (prevents proxy/firewall timeouts)
  const keepAlive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch(e) {}
  }, 25000);

  // Clean up when client disconnects
  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(clientId);
    console.log(`SSE client disconnected: ${clientId} (total: ${sseClients.size})`);
  });
});

// Helper: broadcast data-changed event to all SSE clients EXCEPT the sender
// broadcastChange replaced by SSE broadcastDataChange


// Export router + SSE helpers
module.exports = router;
router.broadcastChange = broadcastChange;
router.sseClients = sseClients;
