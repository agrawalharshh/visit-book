// db/sqljs-wrapper.js
// A thin synchronous-style wrapper around sql.js (pure WASM SQLite, no native build needed)
// that mimics the better-sqlite3 API surface used throughout this project:
//   db.exec(sql)
//   db.prepare(sql).run(...params)
//   db.prepare(sql).get(...params)
//   db.prepare(sql).all(...params)
//   db.transaction(fn)(arg)
//
// Persistence: the whole DB lives in memory (sql.js) and is flushed to a .sqlite file
// on disk after every write, debounced slightly so bulk imports don't thrash disk I/O.

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
    this.wrapper.scheduleSave();
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
    this.db = null;
    this._saveTimer = null;
  }

  async init() {
    const SQL = await initSqlJs({ wasmBinary: loadWasmBuffer() });
    if (fs.existsSync(this.filePath)) {
      const fileBuffer = fs.readFileSync(this.filePath);
      this.db = new SQL.Database(fileBuffer);
    } else {
      this.db = new SQL.Database();
    }
    return this;
  }

  pragma() { /* no-op, sql.js doesn't need WAL/foreign_keys pragmas the same way */ }

  exec(sql) {
    this.db.exec(sql);
    this.scheduleSave();
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  transaction(fn) {
    return (...args) => {
      this.db.exec('BEGIN');
      try {
        const result = fn(...args);
        this.db.exec('COMMIT');
        this.scheduleSave();
        return result;
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    };
  }

  scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveNow(), 150);
  }

  saveNow() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    const data = this.db.export();
    fs.writeFileSync(this.filePath, Buffer.from(data));
  }
}

module.exports = { SqlJsWrapper };
