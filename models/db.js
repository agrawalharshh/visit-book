const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// On Render free tier, use /tmp which is always writable
const DB_PATH = process.env.DB_PATH || '/tmp/visitbook.db';

// Make sure directory exists
const dir = path.dirname(path.resolve(DB_PATH));
if (!fs.existsSync(dir)) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch(e) {}
}

let db = null;
let SQL = null;

function persist() {
  if (db) {
    try {
      const data = db.export();
      fs.writeFileSync(DB_PATH, Buffer.from(data));
    } catch(e) {
      console.error('Could not save db:', e.message);
    }
  }
}

setInterval(persist, 10000);

async function initDb() {
  SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
    console.log('✅ Loaded existing database from', DB_PATH);
  } else {
    db = new SQL.Database();
    console.log('✅ Created new database at', DB_PATH);
  }
  initSchema();
  persist();
  return db;
}

function getDb() {
  if (!db) throw new Error('DB not initialized. Call initDb() first.');
  return db;
}

function run(sql, params = []) {
  try {
    db.run(sql, params);
    return { changes: db.getRowsModified() };
  } catch(e) {
    console.error('DB run error:', e.message, sql);
    throw e;
  }
}

function get(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row;
    }
    stmt.free();
    return undefined;
  } catch(e) {
    console.error('DB get error:', e.message);
    return undefined;
  }
}

function all(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  } catch(e) {
    console.error('DB all error:', e.message);
    return [];
  }
}

function exec(sql) {
  try { db.run(sql); } catch(e) { console.error('DB exec error:', e.message); }
}

function initSchema() {
  exec(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );`);
  exec(`CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY, date TEXT, visit TEXT DEFAULT 'No',
      company TEXT, client TEXT, client2 TEXT, phone TEXT, phone2 TEXT,
      address TEXT, remarks TEXT, followup TEXT, followup2 TEXT,
      converted TEXT DEFAULT 'No', converted_by TEXT, sample TEXT DEFAULT 'No',
      grade TEXT, agent TEXT, visit_count INTEGER DEFAULT 0,
      visit_notes TEXT DEFAULT '[]', reminder_sent_date TEXT,
      created_by TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );`);
  exec(`CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY, company TEXT NOT NULL, client TEXT, phone TEXT,
      address TEXT, notes TEXT, grade TEXT, assigned_to TEXT,
      source TEXT DEFAULT 'manual', entry_id TEXT, orders TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );`);
  exec(`CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY, date TEXT, time TEXT, company TEXT, client TEXT,
      phone TEXT, location TEXT, agenda TEXT, status TEXT DEFAULT 'Scheduled',
      entry_id TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );`);
  exec(`CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, steps TEXT DEFAULT '[]',
      enrollments TEXT DEFAULT '[]', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );`);
  exec(`CREATE TABLE IF NOT EXISTS swa_data (
      id TEXT PRIMARY KEY, company TEXT, client TEXT, phone TEXT, address TEXT,
      remarks TEXT, status TEXT DEFAULT 'Pending', wa_sent TEXT DEFAULT 'No',
      selected INTEGER DEFAULT 0, selected_date TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );`);
  exec(`CREATE TABLE IF NOT EXISTS wa_log (
      id TEXT PRIMARY KEY, timestamp TEXT DEFAULT (datetime('now')),
      company TEXT, client TEXT, phone TEXT, type TEXT,
      status TEXT DEFAULT 'sent', message_preview TEXT
  );`);
  exec(`CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now'))
  );`);

  // Create default admin if none exists
  const userCount = get('SELECT COUNT(*) as c FROM users');
  if (!userCount || parseInt(userCount.c) === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    run('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)',
      [uuidv4(), 'admin', hash, 'admin']);
    console.log('✅ Default admin created: admin / admin123');
  }
}

module.exports = { initDb, getDb, run, get, all, exec, persist };
