// db/libsql-wrapper.js
// Database layer using libSQL (https://github.com/tursodatabase/libsql-client-ts),
// a SQLite-compatible engine with a SYNCHRONOUS API matching better-sqlite3 exactly
// (db.exec, db.prepare().run()/.get()/.all(), db.transaction()) — so every route file
// written against that API works completely unchanged.
//
// CURRENT MODE: local-file-only. Turso cloud sync is supported by this wrapper but
// is intentionally disabled at the db/init.js level after a previously-connected
// Turso database had incompatible legacy data that caused repeated corruption
// issues. See db/init.js for the full explanation and how to safely re-enable it
// with a fresh Turso database in the future.
//
// TWO MODES (this class supports both, controlled by what db/init.js passes in):
// - Turso enabled (tursoUrl + tursoToken both provided): embedded replica mode.
//   Local file is a cache; Turso is durable. Survives every redeploy.
// - Turso disabled (either is null): local-file-only mode — works immediately with
//   no external dependency, but data does not survive a Render free-tier redeploy.

const fs = require('fs');
const path = require('path');
const Database = require('libsql');

class Statement {
  constructor(wrapper, sql) {
    this.wrapper = wrapper;
    this.sql = sql;
    this.stmt = wrapper.db.prepare(sql);
  }

  run(...params) {
    const result = this.stmt.run(...params);
    if (!this.wrapper._inTransaction) this.wrapper.scheduleSync();
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }

  get(...params) {
    const row = this.stmt.get(...params);
    return row ? stripMetadata(row) : row;
  }

  all(...params) {
    return this.stmt.all(...params).map(stripMetadata);
  }
}

// libsql attaches an internal `_metadata` field (query timing info) to every result
// row — useful for debugging the driver itself, but it has no business leaking into
// API responses sent to the frontend, so it's stripped at the wrapper boundary.
function stripMetadata(row) {
  if (row && Object.prototype.hasOwnProperty.call(row, '_metadata')) {
    const { _metadata, ...clean } = row;
    return clean;
  }
  return row;
}

class LibsqlWrapper {
  constructor(filePath, tursoUrl, tursoToken) {
    this.filePath = filePath;
    this.backupDir = path.join(path.dirname(filePath), 'backups');
    this.tursoUrl = tursoUrl;
    this.tursoToken = tursoToken;
    this.isTursoEnabled = !!(tursoUrl && tursoToken);
    this.db = null;
    this._inTransaction = false;
    this._syncTimer = null;
    this._lastBackupAt = 0;
  }

  async init() {
    try { fs.mkdirSync(path.dirname(this.filePath), { recursive: true }); } catch (e) { /* exists */ }
    try { fs.mkdirSync(this.backupDir, { recursive: true }); } catch (e) { /* exists */ }

    if (this.isTursoEnabled) {
      this.db = new Database(this.filePath, {
        syncUrl: this.tursoUrl,
        authToken: this.tursoToken,
      });
      // Pull the latest data from Turso BEFORE this app starts serving requests —
      // critical on Render free tier, since the local file was just wiped by the
      // redeploy and starts empty; without this sync, every fresh deploy would look
      // like total data loss even though Turso still has everything safe.
      try {
        await this.db.sync();
        console.log('✓ Synced database from Turso (cloud) successfully');
      } catch (err) {
        console.error('⚠️ Initial Turso sync failed — will retry in the background:', err.message);
        // Don't throw: still usable in local-replica mode, and scheduleSync will retry.
      }
    } else {
      console.warn('ℹ️ Running in LOCAL-FILE-ONLY mode (Turso connectivity is intentionally disabled — see db/init.js).');
      console.warn('⚠️ On Render free tier this means DATA WILL BE LOST on every redeploy or restart.');
      console.warn('ℹ️ To re-enable persistent storage, set up a fresh Turso database and update db/init.js — see README.md.');
      this.db = new Database(this.filePath);
    }
    return this;
  }

  pragma() { /* no-op — kept for API-compatibility with earlier wrapper versions */ }

  exec(sql) {
    this.db.exec(sql);
    this.scheduleSync();
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  transaction(fn) {
    return (...args) => {
      const tx = this.db.transaction(fn);
      this._inTransaction = true;
      try {
        const result = tx(...args);
        this._inTransaction = false;
        this.scheduleSync();
        return result;
      } catch (err) {
        this._inTransaction = false;
        throw err;
      }
    };
  }

  // Pushes local writes up to Turso. Debounced slightly so a burst of writes (like a
  // bulk import) triggers one sync instead of hundreds, while still keeping the gap
  // small enough that almost nothing would be lost even in a worst-case crash.
  scheduleSync() {
    if (!this.isTursoEnabled) return;
    if (this._syncTimer) clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(() => this.syncNow(), 400);
  }

  async syncNow() {
    if (!this.isTursoEnabled) return;
    if (this._syncTimer) { clearTimeout(this._syncTimer); this._syncTimer = null; }
    try {
      await this.db.sync();
    } catch (err) {
      console.error('⚠️ Turso sync failed (will retry on next write):', err.message);
    }
  }

  // Manual backup snapshot — exports the local replica file to the backups/ folder.
  // Note: with Turso enabled this is a secondary safety net; Turso itself is already
  // the durable copy. This local snapshot is still useful for offline/manual recovery.
  forceBackup() {
    try {
      const buffer = fs.readFileSync(this.filePath);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(path.join(this.backupDir, `backup-${stamp}.sqlite`), buffer);
      this._pruneOldBackups();
      return buffer;
    } catch (err) {
      console.error('Backup failed:', err.message);
      return Buffer.from('');
    }
  }

  _pruneOldBackups() {
    try {
      const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
      for (const f of fs.readdirSync(this.backupDir)) {
        const full = path.join(this.backupDir, f);
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) fs.unlinkSync(full);
      }
    } catch (e) { /* non-fatal */ }
  }

  exportBuffer() {
    try { return fs.readFileSync(this.filePath); } catch (e) { return Buffer.from(''); }
  }
}

module.exports = { LibsqlWrapper };
