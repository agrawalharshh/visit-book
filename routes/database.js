const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../models/db');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// Tables created at server startup (in db.js initSchema)
// These are additional tables for the product database

const safeJ = (s, f) => { try { return JSON.parse(s); } catch { return Array.isArray(f) ? f : f; } };
const parseS = r => !r ? null : { ...r, categories: safeJ(r.categories, []) };
const parseP = r => !r ? null : { ...r, colours: safeJ(r.colours, []), images: safeJ(r.images, []) };

/* ── SUPPLIERS ─────────────────────────────────────── */
router.get('/suppliers', async (req, res) => {
  try {
    await run(`CREATE TABLE IF NOT EXISTS db_suppliers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, city TEXT DEFAULT '',
      contact TEXT DEFAULT '', phone TEXT DEFAULT '',
      categories TEXT DEFAULT '[]', gst TEXT DEFAULT '', color TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    const rows = await all('SELECT * FROM db_suppliers ORDER BY created_at DESC');
    res.json(rows.map(parseS));
  } catch(e) { console.error('GET suppliers:', e.message); res.status(500).json({ error: e.message }); }
});

router.post('/suppliers', async (req, res) => {
  try {
    await run(`CREATE TABLE IF NOT EXISTS db_suppliers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, city TEXT DEFAULT '',
      contact TEXT DEFAULT '', phone TEXT DEFAULT '',
      categories TEXT DEFAULT '[]', gst TEXT DEFAULT '', color TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    const { name, city='', contact='', phone='', categories=[], gst='', color='' } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Supplier name required' });
    const id = uuidv4();
    await run(
      'INSERT INTO db_suppliers (id,name,city,contact,phone,categories,gst,color) VALUES (?,?,?,?,?,?,?,?)',
      [id, name.trim(), city, contact, phone, JSON.stringify(Array.isArray(categories) ? categories : []), gst, color]
    );
    console.log('✅ Supplier added:', name, id);
    res.status(201).json({ id });
  } catch(e) { console.error('POST supplier error:', e.message); res.status(500).json({ error: e.message }); }
});

router.put('/suppliers/:id', async (req, res) => {
  try {
    const { name='', city='', contact='', phone='', categories=[], gst='', color='' } = req.body;
    await run(
      "UPDATE db_suppliers SET name=?,city=?,contact=?,phone=?,categories=?,gst=?,color=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
      [name, city, contact, phone, JSON.stringify(Array.isArray(categories) ? categories : []), gst, color, req.params.id]
    );
    res.json({ message: 'Updated' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/suppliers/:id', async (req, res) => {
  try {
    await run('DELETE FROM db_suppliers WHERE id=?', [req.params.id]);
    await run('DELETE FROM db_products WHERE supplier=?', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ── PRODUCTS ──────────────────────────────────────── */
router.get('/products', async (req, res) => {
  try {
    await run(`CREATE TABLE IF NOT EXISTS db_products (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, supplier TEXT DEFAULT '',
      category TEXT DEFAULT '', rate REAL DEFAULT 0, weight TEXT DEFAULT '',
      moq INTEGER DEFAULT 0, colours TEXT DEFAULT '[]', notes TEXT DEFAULT '',
      images TEXT DEFAULT '[]', srno INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    const rows = await all('SELECT * FROM db_products ORDER BY srno ASC, created_at ASC');
    res.json(rows.map(parseP));
  } catch(e) { console.error('GET products:', e.message); res.status(500).json({ error: e.message }); }
});

router.post('/products', async (req, res) => {
  try {
    await run(`CREATE TABLE IF NOT EXISTS db_products (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, supplier TEXT DEFAULT '',
      category TEXT DEFAULT '', rate REAL DEFAULT 0, weight TEXT DEFAULT '',
      moq INTEGER DEFAULT 0, colours TEXT DEFAULT '[]', notes TEXT DEFAULT '',
      images TEXT DEFAULT '[]', srno INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    const { name, supplier, category, rate=0, weight='', moq=0, colours=[], notes='', images=[], srno=0 } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Product name required' });
    if (!supplier) return res.status(400).json({ error: 'Supplier required' });
    if (!category) return res.status(400).json({ error: 'Category required' });
    const id = uuidv4();
    await run(
      'INSERT INTO db_products (id,name,supplier,category,rate,weight,moq,colours,notes,images,srno) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [id, name.trim(), supplier, category, parseFloat(rate)||0, weight, parseInt(moq)||0,
       JSON.stringify(Array.isArray(colours) ? colours : []), notes,
       JSON.stringify(Array.isArray(images) ? images : []), parseInt(srno)||0]
    );
    res.status(201).json({ id });
  } catch(e) { console.error('POST product error:', e.message); res.status(500).json({ error: e.message }); }
});

router.put('/products/:id', async (req, res) => {
  try {
    const { name='', supplier='', category='', rate=0, weight='', moq=0, colours=[], notes='', images=[], srno=0 } = req.body;
    await run(
      "UPDATE db_products SET name=?,supplier=?,category=?,rate=?,weight=?,moq=?,colours=?,notes=?,images=?,srno=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
      [name, supplier, category, parseFloat(rate)||0, weight, parseInt(moq)||0,
       JSON.stringify(Array.isArray(colours) ? colours : []), notes,
       JSON.stringify(Array.isArray(images) ? images : []), parseInt(srno)||0, req.params.id]
    );
    res.json({ message: 'Updated' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/products/:id', async (req, res) => {
  try { await run('DELETE FROM db_products WHERE id=?', [req.params.id]); res.json({ message: 'Deleted' }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

/* ── ERP DATA ──────────────────────────────────────── */

async function ensureErpTables() {
  const tables = [
    `CREATE TABLE IF NOT EXISTS erp_data (
      id TEXT PRIMARY KEY,
      table_name TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
  ];
  for (const sql of tables) {
    try { await run(sql); } catch(e) { console.error('ERP table error:', e.message); }
  }
}
ensureErpTables().catch(e => console.error('ERP init error:', e.message));

// GET /api/erp/:table
router.get('/erp/:table', async (req, res) => {
  try {
    await ensureErpTables();
    const row = await get('SELECT data FROM erp_data WHERE table_name = ?', [req.params.table]);
    if (!row) return res.json([]);
    try { res.json(JSON.parse(row.data)); } catch { res.json([]); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/erp/:table  — saves full array
router.post('/erp/:table', async (req, res) => {
  try {
    await ensureErpTables();
    const body = req.body;
    // Handle both arrays and objects
    const data = JSON.stringify(Array.isArray(body) ? body : (typeof body === 'object' ? body : []));
    const existing = await get('SELECT id FROM erp_data WHERE table_name = ?', [req.params.table]);
    if (existing) {
      await run("UPDATE erp_data SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE table_name = ?",
        [data, req.params.table]);
    } else {
      const { v4: uuidv4 } = require('uuid');
      await run('INSERT INTO erp_data (id, table_name, data) VALUES (?, ?, ?)',
        [uuidv4(), req.params.table, data]);
    }
    res.json({ ok: true });
  } catch(e) { console.error('POST erp error:', e.message); res.status(500).json({ error: e.message }); }
});

// GET /api/erp-all — get all tables at once
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
