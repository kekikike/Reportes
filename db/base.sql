-- ============================================================
--  Esquema base de la base de datos  (GENERADO AUTOMATICAMENTE)
--  No editar a mano: cambiar db-init.js y correr el script db:dump
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        ip TEXT NOT NULL,
        port INTEGER DEFAULT 4370,
        password INTEGER DEFAULT 0,
        active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS users (
        device_id INTEGER,
        uid INTEGER,
        user_id TEXT,
        name TEXT,
        privilege INTEGER DEFAULT 0,
        synced_at TEXT,
        PRIMARY KEY (device_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS departments (
        code TEXT PRIMARY KEY,
        name TEXT,
        updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id INTEGER,
        user_id TEXT,
        name TEXT,
        timestamp TEXT,
        status INTEGER,
        punch INTEGER,
        synced_at TEXT,
        UNIQUE(device_id, user_id, timestamp)
    );

    CREATE INDEX IF NOT EXISTS idx_att_timestamp ON attendance(timestamp);
    CREATE INDEX IF NOT EXISTS idx_att_device   ON attendance(device_id);
    CREATE INDEX IF NOT EXISTS idx_att_user     ON attendance(user_id);
