// db/init.js — creates all tables if they don't exist, seeds defaults
// Uses libSQL (see db/libsql-wrapper.js) so the database survives Render's free-tier
// ephemeral filesystem by syncing with Turso (free, always-on, SQLite-compatible).
const path = require('path');
const bcrypt = require('bcryptjs');
const { LibsqlWrapper } = require('./libsql-wrapper');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'visitbook.sqlite');
const TURSO_URL = process.env.TURSO_DATABASE_URL || null;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || null;

let dbInstance = null;
let readyPromise = null;

const SCHEMA = `
-- ───────── USERS (login + role-based access) ─────────
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'data_entry',     -- admin | data_entry | crm | mis | ea
  active INTEGER DEFAULT 1,
  must_change_password INTEGER DEFAULT 0,
  failed_login_count INTEGER DEFAULT 0,
  locked_until TEXT,                  -- ISO datetime; account login blocked until this passes
  created_by INTEGER,                 -- FK -> users.id (which admin created this account)
  last_login_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ───────── LOGIN AUDIT LOG (every attempt, success or failure) ─────────
CREATE TABLE IF NOT EXISTS login_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  success INTEGER NOT NULL,
  ip_address TEXT,
  reason TEXT,                        -- e.g. 'wrong_password', 'account_locked', 'account_inactive', 'success'
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

-- ───────── WHATSAPP PAGE DEFAULTS (preset template/mapping/number per page) ─────────
-- page_key is one of: visit_clients, active_clients, meetings, followups,
-- swa_move (move-to-one-number), swa_individual (per-row send)
CREATE TABLE IF NOT EXISTS wa_page_defaults (
  page_key TEXT PRIMARY KEY,
  template_name TEXT,
  language TEXT DEFAULT 'en',
  variable_mapping_json TEXT,            -- JSON: {"1": "name", "2": "area", ...} or for swa pages, field names
  default_number TEXT,                   -- used by followups / swa_move, which target a fixed number rather than the client's own
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ───────── WHATSAPP WEBHOOK EVENTS (raw log for the Webhook Health sheet) ─────────
CREATE TABLE IF NOT EXISTS wa_webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,              -- 'verify_attempt' | 'verify_success' | 'verify_failed' | 'status_callback' | 'inbound_message'
  detail TEXT,
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
    const wrapper = new LibsqlWrapper(DB_PATH, TURSO_URL, TURSO_TOKEN);
    await wrapper.init();
    wrapper.exec(SCHEMA);
    reconcileSchema(wrapper);
    runDataFixups(wrapper);

    const userCount = wrapper.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    if (userCount === 0) {
      const hash = bcrypt.hashSync('admin123', 10);
      wrapper.prepare('INSERT INTO users (name, username, password_hash, role) VALUES (?, ?, ?, ?)')
        .run('Admin', 'admin', hash, 'admin');
      await wrapper.syncNow();
      console.log('✓ Seeded default user: username=admin password=admin123 (change this after first login)');
    }

    dbInstance = wrapper;
    return wrapper;
  })();
  return readyPromise;
}

// ── Self-healing schema reconciliation ──
// `CREATE TABLE IF NOT EXISTS` does nothing if a table by that name already exists —
// even if that existing table is missing columns this version of the app expects
// (e.g. a Turso database that already had an older/partial `meetings` or `users`
// table in it before this app ever touched it). Hand-maintaining a list of ALTER
// statements for every column ever added is fragile — exactly this class of bug is
// what caused "no such column: meeting_date" / "no such column: name" in production.
// Instead: parse the column names this app actually expects straight out of the
// SCHEMA string above, compare against what each table actually has via
// PRAGMA table_info, and auto-generate any missing ALTER TABLE ADD COLUMN — so
// drift between "what the code expects" and "what the table has" can never recur
// silently, for any table, including ones added in the future.
function parseExpectedColumns(schemaSql) {
  const tables = {};
  const tableRegex = /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g;
  let match;
  while ((match = tableRegex.exec(schemaSql))) {
    const [, tableName, body] = match;
    const columns = [];
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim().replace(/,$/, '');
      if (!line || line.startsWith('--')) continue;
      if (/^(PRIMARY KEY|FOREIGN KEY|UNIQUE)\s*\(/i.test(line)) continue;
      const colMatch = line.match(/^(\w+)\s+([A-Z]+)/i);
      if (!colMatch) continue;
      const [, colName, colType] = colMatch;
      // Capture a DEFAULT clause if present, so a backfilled column gets a sane
      // value instead of NULL for every pre-existing row. Handles both simple
      // defaults (DEFAULT 0, DEFAULT 'Cold') and function-call defaults that need
      // their own parens preserved (DEFAULT (datetime('now'))).
      let defaultClause = null;
      const parenDefaultMatch = line.match(/DEFAULT\s+(\([^)]*\([^)]*\)[^)]*\)|\([^)]*\))/i);
      const simpleDefaultMatch = line.match(/DEFAULT\s+('[^']*'|\d+)/i);
      if (parenDefaultMatch) defaultClause = parenDefaultMatch[1];
      else if (simpleDefaultMatch) defaultClause = simpleDefaultMatch[1];
      columns.push({ name: colName, type: normalizeType(colType), defaultClause });
    }
    tables[tableName] = columns;
  }
  return tables;
}

function normalizeType(t) {
  const upper = t.toUpperCase();
  if (upper.startsWith('INT')) return 'INTEGER';
  if (upper.startsWith('TEXT') || upper.startsWith('VARCHAR')) return 'TEXT';
  if (upper.startsWith('REAL') || upper.startsWith('FLOAT') || upper.startsWith('DOUBLE')) return 'REAL';
  return 'TEXT';
}

function reconcileSchema(wrapper) {
  const expected = parseExpectedColumns(SCHEMA);
  let totalAdded = 0;

  for (const [tableName, expectedCols] of Object.entries(expected)) {
    let actualCols;
    try {
      actualCols = wrapper.prepare(`PRAGMA table_info(${tableName})`).all().map(c => c.name);
    } catch (e) {
      continue; // table genuinely doesn't exist and CREATE somehow didn't run — skip, not this function's job
    }
    if (!actualCols.length) continue; // table doesn't exist yet, nothing to reconcile

    for (const col of expectedCols) {
      if (col.name === 'id') continue; // primary key, never needs adding after the fact
      if (actualCols.includes(col.name)) continue;

      const defaultSql = col.defaultClause ? ` DEFAULT ${col.defaultClause}` : '';
      const alterSql = `ALTER TABLE ${tableName} ADD COLUMN ${col.name} ${col.type}${defaultSql}`;
      try {
        wrapper.exec(alterSql);
        console.log(`✓ Schema repair: added missing column ${tableName}.${col.name}`);
        totalAdded++;
      } catch (e) {
        console.error(`⚠️ Schema repair failed for ${tableName}.${col.name}:`, e.message);
      }
    }
  }

  if (totalAdded > 0) {
    console.log(`✓ Schema reconciliation complete — ${totalAdded} missing column(s) added.`);
    wrapper.scheduleSync();
  }
}

// Data-level fixups that aren't about missing columns, just stale/invalid values
// from older versions of the app (e.g. a role value that no longer exists).
function runDataFixups(wrapper) {
  try { wrapper.exec(`UPDATE users SET role = 'data_entry' WHERE role = 'staff' OR role IS NULL OR role = ''`); } catch (e) { /* fine */ }
  try { wrapper.exec(`UPDATE users SET active = 1 WHERE active IS NULL`); } catch (e) { /* fine */ }
  wrapper.scheduleSync();
}

function getDb() {
  if (!dbInstance) {
    throw new Error('Database not initialized yet — call init() and await it before using getDb()');
  }
  return dbInstance;
}

// Exposed so an admin-only route can trigger a manual schema repair on demand
// (Settings → Backups → "Repair Database Schema"), without needing a redeploy.
function repairSchemaNow() {
  if (!dbInstance) throw new Error('Database not ready yet');
  let addedCount = 0;
  const originalLog = console.log;
  console.log = (msg) => { if (typeof msg === 'string' && msg.includes('Schema repair: added')) addedCount++; originalLog(msg); };
  try {
    reconcileSchema(dbInstance);
  } finally {
    console.log = originalLog;
  }
  return addedCount;
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
    if (prop === 'repairSchemaNow') return repairSchemaNow;
    if (prop === 'then') return undefined; // prevent accidental thenable detection
    const real = getDb();
    const value = real[prop];
    return typeof value === 'function' ? value.bind(real) : value;
  },
});

module.exports = dbProxy;
