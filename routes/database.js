const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../models/db');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// ── INIT TABLES ───────────────────────────────────────────
async function ensureTables() {
  await run(`CREATE TABLE IF NOT EXISTS db_suppliers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, city TEXT, contact TEXT, phone TEXT,
    categories TEXT DEFAULT '[]', gst TEXT, color TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  await run(`CREATE TABLE IF NOT EXISTS db_products (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, supplier TEXT, category TEXT,
    rate REAL DEFAULT 0, weight TEXT, moq INTEGER DEFAULT 0,
    colours TEXT DEFAULT '[]', notes TEXT, images TEXT DEFAULT '[]',
    srno INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
}
ensureTables().catch(e => console.error('DB tables error:', e.message));

const parseS = r => r ? { ...r, categories: safeJ(r.categories, []) } : null;
const parseP = r => r ? { ...r, colours: safeJ(r.colours, []), images: safeJ(r.images, []) } : null;
const safeJ = (s, f) => { try { return JSON.parse(s); } catch { return f; } };

/* ── SUPPLIERS ───────────────────────────────────────────── */
router.get('/suppliers', async (req, res) => {
  try { res.json((await all('SELECT * FROM db_suppliers ORDER BY created_at DESC')).map(parseS)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/suppliers', async (req, res) => {
  try {
    const { name, city='', contact='', phone='', categories=[], gst='', color='' } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const id = uuidv4();
    await run('INSERT INTO db_suppliers (id,name,city,contact,phone,categories,gst,color) VALUES (?,?,?,?,?,?,?,?)',
      [id, name, city, contact, phone, JSON.stringify(categories), gst, color]);
    res.status(201).json({ id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/suppliers/:id', async (req, res) => {
  try {
    const { name, city='', contact='', phone='', categories=[], gst='', color='' } = req.body;
    await run("UPDATE db_suppliers SET name=?,city=?,contact=?,phone=?,categories=?,gst=?,color=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
      [name, city, contact, phone, JSON.stringify(categories), gst, color, req.params.id]);
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

/* ── PRODUCTS ────────────────────────────────────────────── */
router.get('/products', async (req, res) => {
  try { res.json((await all('SELECT * FROM db_products ORDER BY srno ASC, created_at DESC')).map(parseP)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/products', async (req, res) => {
  try {
    const { name, supplier, category, rate=0, weight='', moq=0, colours=[], notes='', images=[], srno=0 } = req.body;
    if (!name || !supplier || !category) return res.status(400).json({ error: 'Name, supplier, category required' });
    const id = uuidv4();
    await run('INSERT INTO db_products (id,name,supplier,category,rate,weight,moq,colours,notes,images,srno) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [id, name, supplier, category, rate, weight, moq, JSON.stringify(colours), notes, JSON.stringify(images), srno]);
    res.status(201).json({ id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/products/:id', async (req, res) => {
  try {
    const { name, supplier, category, rate=0, weight='', moq=0, colours=[], notes='', images=[], srno=0 } = req.body;
    await run("UPDATE db_products SET name=?,supplier=?,category=?,rate=?,weight=?,moq=?,colours=?,notes=?,images=?,srno=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
      [name, supplier, category, rate, weight, moq, JSON.stringify(colours), notes, JSON.stringify(images), srno, req.params.id]);
    res.json({ message: 'Updated' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/products/:id', async (req, res) => {
  try { await run('DELETE FROM db_products WHERE id=?', [req.params.id]); res.json({ message: 'Deleted' }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
