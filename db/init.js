// db/init.js — creates all tables if they don't exist, seeds defaults
// Uses sql.js (pure WASM SQLite) via sqljs-wrapper so there is NO native compilation
// step — this installs and runs identically on any host (local, Render, etc).
const path = require('path');
const bcrypt = require('bcryptjs');
const { SqlJsWrapper } = require('./sqljs-wrapper');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'visitbook.sqlite');

let dbInstance = null;
let readyPromise = null;

const SCHEMA = `
-- ───────── USERS (simple login) ─────────
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'staff',
  created_at TEXT DEFAULT (datetime('now'))
);

-- ───────── VISIT CLIENTS ─────────
CREATE TABLE IF NOT EXISTS visit_clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  area TEXT,
  address TEXT,
  landmark TEXT,
  location TEXT,
  phone TEXT,
  business TEXT,
  last_visit TEXT,
  status TEXT DEFAULT 'Prospect',
  remarks TEXT,
  follow_up_date TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ───────── ACTIVE CLIENTS ─────────
CREATE TABLE IF NOT EXISTS active_clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  area TEXT,
  address TEXT,
  landmark TEXT,
  location TEXT,
  phone TEXT,
  business TEXT,
  monthly_value REAL DEFAULT 0,
  status TEXT DEFAULT 'Active',
  remarks TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ───────── MEETINGS ─────────
CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_name TEXT NOT NULL,
  phone TEXT,
  area TEXT,
  meeting_date TEXT NOT NULL,
  meeting_time TEXT,
  notes TEXT,
  status TEXT DEFAULT 'Scheduled',
  source_type TEXT,
  source_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ───────── SWA DATA (imported pending list) ─────────
CREATE TABLE IF NOT EXISTS swa_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sr TEXT,
  company TEXT,
  client TEXT,
  phone TEXT,
  address TEXT,
  remarks TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ───────── SWA SELECTED (moved + sent) ─────────
CREATE TABLE IF NOT EXISTS swa_selected (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sr TEXT,
  company TEXT,
  client TEXT,
  phone TEXT,
  address TEXT,
  remarks TEXT,
  sent_to_number TEXT,
  batch_id TEXT,
  wa_log_id INTEGER,
  moved_at TEXT DEFAULT (datetime('now'))
);

-- ───────── WHATSAPP TEMPLATES (cache of Meta-approved templates) ─────────
CREATE TABLE IF NOT EXISTS wa_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_name TEXT NOT NULL,
  language TEXT DEFAULT 'en',
  category TEXT,
  body_text TEXT,
  variable_count INTEGER DEFAULT 0,
  status TEXT,
  raw_json TEXT,
  synced_at TEXT DEFAULT (datetime('now'))
);

-- ───────── WHATSAPP LOG (every send attempt) ─────────
CREATE TABLE IF NOT EXISTS wa_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_number TEXT NOT NULL,
  client_name TEXT,
  template_name TEXT,
  variables_json TEXT,
  rendered_message TEXT,
  wa_message_id TEXT,
  status TEXT DEFAULT 'pending',
  error_message TEXT,
  source_page TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ───────── APP SETTINGS (WA credentials, key-value) ─────────
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

async function init() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    const wrapper = new SqlJsWrapper(DB_PATH);
    await wrapper.init();
    wrapper.exec(SCHEMA);

    const userCount = wrapper.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    if (userCount === 0) {
      const hash = bcrypt.hashSync('admin123', 10);
      wrapper.prepare('INSERT INTO users (name, username, password_hash, role) VALUES (?, ?, ?, ?)')
        .run('Admin', 'admin', hash, 'admin');
      wrapper.saveNow();
      console.log('✓ Seeded default user: username=admin password=admin123 (change this after first login)');
    }

    dbInstance = wrapper;
    return wrapper;
  })();
  return readyPromise;
}

function getDb() {
  if (!dbInstance) {
    throw new Error('Database not initialized yet — call init() and await it before using getDb()');
  }
  return dbInstance;
}

// Proxy object so existing code written as `const db = require('../db/init')`
// followed by `db.prepare(...).run(...)` keeps working unchanged — every property
// access forwards to the real, ready dbInstance once init() has resolved.
// `init` and `getDb` are handled directly (not forwarded) so they can be called
// before the real database instance exists.
const dbProxy = new Proxy({}, {
  get(_target, prop) {
    if (prop === 'init') return init;
    if (prop === 'getDb') return getDb;
    if (prop === 'then') return undefined; // prevent accidental thenable detection
    const real = getDb();
    const value = real[prop];
    return typeof value === 'function' ? value.bind(real) : value;
  },
});

module.exports = dbProxy;
