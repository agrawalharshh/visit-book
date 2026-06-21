// db/sqljs-wrapper.js
// A thin synchronous-style wrapper around sql.js (pure WASM SQLite, no native build needed)
// that mimics the better-sqlite3 API surface used throughout this project:
//   db.exec(sql)
//   db.prepare(sql).run(...params)
//   db.prepare(sql).get(...params)
//   db.prepare(sql).all(...params)
//   db.transaction(fn)(arg)
//
// DURABILITY: every write saves to disk IMMEDIATELY (no debounce window where data
// could be lost to a crash/restart) using an atomic write-temp-then-rename so a
// process kill mid-write can never leave a half-written, corrupted database file.
// A rolling set of timestamped backup snapshots is also kept (see backups()).

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

function loadWasmBuffer() {
  // sql.js ships its .wasm file inside node_modules/sql.js/dist/sql-wasm.wasm
  return fs.readFileSync(path.join(require.resolve('sql.js/dist/sql-wasm.wasm')));
}

class Statement {
  constructor(wrapper, sql) {
    this.wrapper = wrapper;
    this.sql = sql;
  }

  run(...params) {
    const db = this.wrapper.db;
    const stmt = db.prepare(this.sql);
    try {
      stmt.bind(params);
      stmt.step();
    } finally {
      stmt.free();
    }
    const changes = db.getRowsModified();
    let lastInsertRowid = null;
    if (/^\s*insert/i.test(this.sql)) {
      const res = db.exec('SELECT last_insert_rowid() AS id');
      if (res.length && res[0].values.length) lastInsertRowid = res[0].values[0][0];
    }
    // Inside a transaction(), the transaction wrapper itself saves once after COMMIT —
    // saving after every individual statement too would mean N disk writes for an
    // N-row bulk import instead of 1, and (worse) could persist a partially-committed
    // state if read between two statements of the same transaction.
    if (!this.wrapper._inTransaction) this.wrapper.saveNow();
    return { changes, lastInsertRowid };
  }

  get(...params) {
    const rows = this.all(...params);
    return rows[0] || undefined;
  }

  all(...params) {
    const db = this.wrapper.db;
    const stmt = db.prepare(this.sql);
    const out = [];
    try {
      stmt.bind(params);
      while (stmt.step()) {
        out.push(stmt.getAsObject());
      }
    } finally {
      stmt.free();
    }
    return out;
  }
}

class SqlJsWrapper {
  constructor(filePath) {
    this.filePath = filePath;
    this.backupDir = path.join(path.dirname(filePath), 'backups');
    this.db = null;
    this._writeQueue = Promise.resolve(); // serializes saveNow() calls so concurrent requests never race on the same file
    this._lastBackupAt = 0;
  }

  async init() {
    const SQL = await initSqlJs({ wasmBinary: loadWasmBuffer() });
    if (fs.existsSync(this.filePath)) {
      const fileBuffer = fs.readFileSync(this.filePath);
      let loaded = null;
      try {
        loaded = new SQL.Database(fileBuffer);
        // sql.js's constructor does NOT validate the SQLite file format — garbage
        // bytes load "successfully" and only fail on the first real query. Force
        // that validation now, immediately, rather than letting it surface later
        // as a confusing failure deep inside some unrelated route.
        loaded.exec("SELECT name FROM sqlite_master LIMIT 1");
        this.db = loaded;
      } catch (err) {
        // The main file is unreadable/corrupted (e.g. a crash mid-write before this
        // durability fix existed, or a manually edited/truncated file). Fall back to
        // the most recent backup snapshot rather than starting from an empty database
        // and silently losing everything.
        console.error('⚠️ Main database file failed to load, attempting recovery from backup:', err.message);
        const recovered = this._loadLatestBackup(SQL);
        if (recovered) {
          this.db = recovered;
          console.log('✓ Recovered database from latest backup snapshot');
        } else {
          throw new Error('Database file is corrupted and no backup snapshot is available. Manual recovery required — do not delete the corrupted file before getting help.');
        }
      }
    } else {
      this.db = new SQL.Database();
    }
    try { fs.mkdirSync(this.backupDir, { recursive: true }); } catch (e) { /* already exists */ }
    return this;
  }

  _loadLatestBackup(SQL) {
    try {
      const files = fs.readdirSync(this.backupDir).filter(f => f.endsWith('.sqlite')).sort().reverse();
      for (const f of files) {
        try {
          const buf = fs.readFileSync(path.join(this.backupDir, f));
          const candidate = new SQL.Database(buf);
          candidate.exec("SELECT name FROM sqlite_master LIMIT 1"); // validate this backup too
          return candidate;
        } catch (e) {
          continue; // this backup is also bad — try the next older one
        }
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  pragma() { /* no-op, sql.js doesn't need WAL/foreign_keys pragmas the same way */ }

  exec(sql) {
    this.db.exec(sql);
    this.saveNow();
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  transaction(fn) {
    return (...args) => {
      this.db.exec('BEGIN');
      this._inTransaction = true;
      try {
        const result = fn(...args);
        this._inTransaction = false;
        this.db.exec('COMMIT');
        this.saveNow();
        return result;
      } catch (err) {
        this._inTransaction = false;
        this.db.exec('ROLLBACK');
        throw err;
      }
    };
  }

  // Atomic write: write to a temp file, then rename over the real path. A rename
  // on the same filesystem is atomic at the OS level, so readers/crashes never see
  // a half-written file — they see either the old version or the new one, never both.
  saveNow() {
    const data = this.db.export();
    const buffer = Buffer.from(data);
    const tmpPath = this.filePath + '.tmp-' + process.pid;
    // Serialize writes through a queue: with 2-3 users hitting the API concurrently,
    // overlapping saveNow() calls must not race on the same temp file / rename.
    this._writeQueue = this._writeQueue.then(() => {
      fs.writeFileSync(tmpPath, buffer);
      fs.renameSync(tmpPath, this.filePath);
      this._maybeBackup(buffer);
    }).catch(err => {
      console.error('⚠️ Database save failed:', err);
    });
    return this._writeQueue;
  }

  // Keeps a rolling timestamped snapshot at most once every 10 minutes, plus
  // prunes anything older than 14 days so the backups folder doesn't grow forever.
  _maybeBackup(buffer) {
    const now = Date.now();
    if (now - this._lastBackupAt < 10 * 60 * 1000) return;
    this._lastBackupAt = now;
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(path.join(this.backupDir, `backup-${stamp}.sqlite`), buffer);
      const cutoff = now - 14 * 24 * 60 * 60 * 1000;
      for (const f of fs.readdirSync(this.backupDir)) {
        const full = path.join(this.backupDir, f);
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) fs.unlinkSync(full);
      }
    } catch (e) {
      console.error('⚠️ Backup snapshot failed (main save still succeeded):', e.message);
    }
  }

  // Forces an immediate timestamped backup regardless of the 10-minute throttle —
  // used by the manual "Download Backup" button and before risky bulk operations.
  forceBackup() {
    const data = this.db.export();
    const buffer = Buffer.from(data);
    this._lastBackupAt = 0;
    this._maybeBackup(buffer);
    return buffer;
  }

  exportBuffer() {
    return Buffer.from(this.db.export());
  }
}

module.exports = { SqlJsWrapper };
