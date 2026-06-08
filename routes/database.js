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
