// db/libsql-wrapper.js
// Database layer using libSQL (https://github.com/tursodatabase/libsql-client-ts),
// a SQLite-compatible engine with a SYNCHRONOUS API matching better-sqlite3 exactly
// (db.exec, db.prepare().run()/.get()/.all(), db.transaction()) — so every route file
// written against that API works completely unchanged.
//
// WHY THIS REPLACED THE OLD LOCAL-FILE-ONLY APPROACH:
// Render's free tier has NO persistent disk — the entire filesystem is wiped on every
// deploy and on every restart (which happens automatically after ~15 min idle on free
// tier). A purely local SQLite file, however durably written, is still erased on every
// redeploy. The fix is to make Turso (a free, always-on, SQLite-compatible cloud DB)
// the actual source of truth, while still using a local file as a fast embedded
// replica — reads and writes feel instant and synchronous, while libSQL handles
// syncing that local file with Turso's cloud copy in the background.
//
// TWO MODES:
// - Turso configured (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN env vars set): embedded
//   replica mode. Local file is a cache; Turso is durable. Survives every redeploy.
// - Turso NOT configured: falls back to local-file-only mode (today's behavior) so
//   the app still boots and works before Turso is set up — this is also what avoids
//   the chicken-and-egg problem of needing the database to be up before you could
//   ever type Turso credentials into a Settings page stored IN that database.

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
      console.warn('⚠️ TURSO_DATABASE_URL / TURSO_AUTH_TOKEN not set — running in LOCAL-FILE-ONLY mode.');
      console.warn('⚠️ On Render free tier this means DATA WILL BE LOST on every redeploy or restart.');
      console.warn('⚠️ See README.md "Persistent Storage Setup" to fix this permanently (takes 5 minutes, free).');
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
