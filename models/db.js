const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

let client = null;

async function initDb() {
  let url   = (process.env.TURSO_DATABASE_URL || '').trim();
  const token = (process.env.TURSO_AUTH_TOKEN || '').trim();

  // Auto-fix common URL mistakes
  if (url) {
    // Remove trailing slash
    url = url.replace(/\/+$/, '');
    // Fix https:// → libsql://
    url = url.replace(/^https:\/\//, 'libsql://');
    url = url.replace(/^http:\/\//, 'libsql://');
    // If someone copied wss:// format
    url = url.replace(/^wss:\/\//, 'libsql://');
  }

  if (url && token) {
    console.log('🔗 Connecting to Turso:', url);
    client = createClient({ url, authToken: token });
    console.log('✅ Turso client created');
  } else {
    console.log('⚠️  No Turso credentials — using /tmp (data resets on restart)');
    console.log('   Set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN in Render for permanent data');
    client = createClient({ url: 'file:/tmp/visitbook.db' });
  }

  await initSchema();
  return client;
}

async function initSchema() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY, date TEXT, visit TEXT DEFAULT 'No',
      company TEXT, client TEXT, client2 TEXT, phone TEXT, phone2 TEXT,
      address TEXT, remarks TEXT, followup TEXT, followup2 TEXT,
      converted TEXT DEFAULT 'No', converted_by TEXT, sample TEXT DEFAULT 'No',
      grade TEXT, agent TEXT, visit_count INTEGER DEFAULT 0,
      visit_notes TEXT DEFAULT '[]', reminder_sent_date TEXT,
      created_by TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY, company TEXT NOT NULL, client TEXT, phone TEXT,
      address TEXT, notes TEXT, grade TEXT, assigned_to TEXT,
      source TEXT DEFAULT 'manual', entry_id TEXT, orders TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY, date TEXT, time TEXT, company TEXT, client TEXT,
      phone TEXT, location TEXT, agenda TEXT, status TEXT DEFAULT 'Scheduled',
      entry_id TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS swa_data (
      id TEXT PRIMARY KEY, company TEXT, client TEXT, phone TEXT, address TEXT,
      remarks TEXT, status TEXT DEFAULT 'Pending', wa_sent TEXT DEFAULT 'No',
      selected INTEGER DEFAULT 0, selected_date TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS wa_log (
      id TEXT PRIMARY KEY, timestamp TEXT DEFAULT (datetime('now')),
      company TEXT, client TEXT, phone TEXT, type TEXT,
      status TEXT DEFAULT 'sent', message_preview TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now'))
    )`,
  ];

  // Run each table creation one by one so we can see which one fails
  for (const sql of statements) {
    try {
      await client.execute(sql);
    } catch(e) {
      console.error('❌ Table creation failed:', e.message);
      console.error('SQL was:', sql.substring(0, 80));
      throw e;
    }
  }

  // Seed default admin
  try {
    const res = await client.execute('SELECT COUNT(*) as c FROM users');
    const count = parseInt(res.rows[0]?.c || res.rows[0]?.[0] || 0);
    if (count === 0) {
      const hash = bcrypt.hashSync('admin123', 10);
      await client.execute({
        sql: 'INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)',
        args: [uuidv4(), 'admin', hash, 'admin']
      });
      console.log('✅ Default admin created: admin / admin123');
    } else {
      console.log(`✅ Database ready — ${count} user(s) found`);
    }
  } catch(e) {
    console.error('❌ Admin seed error:', e.message);
    throw e;
  }

  console.log('✅ All tables ready');
}

async function run(sql, params = []) {
  try {
    const result = await client.execute({ sql, args: params });
    return { changes: result.rowsAffected };
  } catch(e) {
    console.error('DB run error:', e.message);
    throw e;
  }
}

async function get(sql, params = []) {
  try {
    const result = await client.execute({ sql, args: params });
    if (!result.rows || result.rows.length === 0) return undefined;
    return rowToObj(result.rows[0], result.columns);
  } catch(e) {
    console.error('DB get error:', e.message);
    return undefined;
  }
}

async function all(sql, params = []) {
  try {
    const result = await client.execute({ sql, args: params });
    if (!result.rows) return [];
    return result.rows.map(r => rowToObj(r, result.columns));
  } catch(e) {
    console.error('DB all error:', e.message);
    return [];
  }
}

function rowToObj(row, columns) {
  const obj = {};
  if (Array.isArray(row)) {
    columns.forEach((col, i) => { obj[col] = row[i]; });
  } else {
    columns.forEach(col => { obj[col] = row[col]; });
  }
  return obj;
}

module.exports = { initDb, run, get, all };
