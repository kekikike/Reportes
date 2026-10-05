/**
 * sqlitedb.js — Capa de acceso a datos SQLite usando better-sqlite3 (nativo).
 * Mucho más rápido que sql.js (WebAssembly) y sin límites de memoria.
 */
const Database = require('better-sqlite3');
const path = require('path');

class SQLiteDB {
    constructor(file) {
        this.file = file;
        this.db = null;
    }

    init() {
        this.db = new Database(this.file);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        return this;
    }

    _norm(p) {
        if (p == null) return [];
        if (Array.isArray(p)) {
            if (p.length === 1 && Array.isArray(p[0])) p = p[0];
            return p.map(v => (v === undefined ? null : v));
        }
        const o = Object.create(null);
        for (const k of Object.keys(p)) o['$' + k] = p[k] == null ? null : p[k];
        return o;
    }

    _stmt(sql) {
        try {
            return this.db.prepare(sql);
        } catch (e) {
            throw new Error(`SQL inválida: ${sql} | ${e.message}`);
        }
    }

    prepare(sql) {
        const self = this;
        const stmt = this._stmt(sql);
        return {
            all(...params) { return stmt.all(...self._norm(params)); },
            get(...params) { return stmt.get(...self._norm(params)); },
            run(...params) {
                const info = stmt.run(...self._norm(params));
                return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
            },
        };
    }

    all(sql, ...params) {
        return this._stmt(sql).all(...this._norm(params));
    }

    get(sql, ...params) {
        return this._stmt(sql).get(...this._norm(params));
    }

    run(sql, ...params) {
        const info = this._stmt(sql).run(...this._norm(params));
        return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
    }

    exec(sql) {
        this.db.exec(sql);
    }

    transaction(fn) {
        return this.db.transaction(fn);
    }

    pragma(sql) {
        return this.db.pragma(sql, { simple: true });
    }

    save() {
        try { this.db.pragma('wal_checkpoint(PASSIVE)'); } catch (e) {}
    }

    close() {
        try { if (this.db) this.db.close(); } catch (e) {}
    }
}

module.exports = SQLiteDB;