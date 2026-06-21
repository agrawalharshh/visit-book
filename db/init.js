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
-- Note: landmark/business/location columns are kept in the DB schema for backward
-- compatibility with any existing data, but are no longer shown in the Add/Edit form.
CREATE TABLE IF NOT EXISTS visit_clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  company TEXT,
  area TEXT,
  address TEXT,
  landmark TEXT,
  location TEXT,
  phone TEXT,
  business TEXT,
  last_visit TEXT,
  status TEXT DEFAULT 'Prospect',
  lead_status TEXT DEFAULT 'Cold',
  remarks TEXT,
  follow_up_date TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ───────── VISIT LOGS (one client can have many — "Log a Visit" history) ─────────
CREATE TABLE IF NOT EXISTS visit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,           -- points at visit_clients.id OR active_clients.id
  client_table TEXT NOT NULL DEFAULT 'visit_clients',  -- 'visit_clients' | 'active_clients' — which table client_id refers to
  visit_date TEXT NOT NULL,
  next_follow_up_date TEXT,
  lead_status TEXT,                     -- Hot / Cold / Converted snapshot at the time of this log
  remarks TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ───────── SALES EXECUTIVES (managed staff list — separate from login accounts) ─────────
CREATE TABLE IF NOT EXISTS sales_executives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ───────── ACTIVE CLIENTS ─────────
CREATE TABLE IF NOT EXISTS active_clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  company TEXT,
  area TEXT,
  address TEXT,
  landmark TEXT,
  location TEXT,
  phone TEXT,
  business TEXT,
  monthly_value REAL DEFAULT 0,
  status TEXT DEFAULT 'Active',
  grade TEXT,                            -- A / B / C customer ranking
  converted_by INTEGER,                  -- FK -> sales_executives.id
  remarks TEXT,
  converted_from_visit_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ───────── ORDERS (Active Clients only) ─────────
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  active_client_id INTEGER NOT NULL,
  bill_no TEXT,
  order_date TEXT NOT NULL,
  total_amount REAL DEFAULT 0,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ───────── ORDER ITEMS (line items per order: product, qty, rate, amount, unit) ─────────
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  product TEXT,
  qty REAL DEFAULT 0,
  unit TEXT DEFAULT 'kg',                -- 'kg' | 'tons' — lets target tracking sum to real tonnage
  rate REAL DEFAULT 0,
  amount REAL DEFAULT 0
);

-- ───────── WEEKLY TARGETS (per sales executive, tonnage, with shortfall rollover) ─────────
CREATE TABLE IF NOT EXISTS weekly_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  executive_id INTEGER NOT NULL,         -- FK -> sales_executives.id
  week_start TEXT NOT NULL,              -- ISO date (Monday) marking the start of the target week
  target_tons REAL NOT NULL DEFAULT 0,   -- this week's own target, before rollover is added
  rollover_tons REAL DEFAULT 0,          -- shortfall carried in from the previous week
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(executive_id, week_start)
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
  ai_area TEXT,                          -- area name the AI extracted from the address field
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
  retry_count INTEGER DEFAULT 0,
  next_retry_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ───────── WHATSAPP REPLIES (inbound messages from clients, via webhook) ─────────
CREATE TABLE IF NOT EXISTS wa_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_number TEXT NOT NULL,
  message_text TEXT,
  wa_message_id TEXT,
  in_reply_to_log_id INTEGER,            -- best-effort link back to wa_log.id this is a reply to
  read_by_user INTEGER DEFAULT 0,
  received_at TEXT DEFAULT (datetime('now'))
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
    runMigrations(wrapper);

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

// Adds columns introduced after the original CREATE TABLE statements, for databases
// that were created by an earlier version of this app. Safe to run on every boot —
// each ALTER is wrapped so an "already exists" error is silently ignored.
function runMigrations(wrapper) {
  const alters = [
    `ALTER TABLE visit_clients ADD COLUMN lead_status TEXT DEFAULT 'Cold'`,
    `ALTER TABLE visit_clients ADD COLUMN company TEXT`,
    `ALTER TABLE active_clients ADD COLUMN converted_from_visit_id INTEGER`,
    `ALTER TABLE active_clients ADD COLUMN company TEXT`,
    `ALTER TABLE active_clients ADD COLUMN grade TEXT`,
    `ALTER TABLE active_clients ADD COLUMN converted_by INTEGER`,
    `ALTER TABLE order_items ADD COLUMN unit TEXT DEFAULT 'kg'`,
    `ALTER TABLE swa_selected ADD COLUMN ai_area TEXT`,
    `ALTER TABLE wa_log ADD COLUMN retry_count INTEGER DEFAULT 0`,
    `ALTER TABLE wa_log ADD COLUMN next_retry_at TEXT`,
  ];
  for (const sql of alters) {
    try { wrapper.exec(sql); } catch (e) { /* column already exists — fine */ }
  }
  wrapper.saveNow();
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
