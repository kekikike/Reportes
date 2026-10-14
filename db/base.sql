-- ============================================================
--  BD BASE del sistema de reportes  (GENERADO AUTOMATICAMENTE)
--
--  Contiene: esquema completo + el dispositivo por defecto.
--  NO contiene datos reales de la empresa.
--
--  Para cambiar el esquema: editar db-init.js y correr
--  el script npm run db:dump. No editar este archivo a mano.
-- ============================================================
CREATE TABLE devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        ip TEXT NOT NULL,
        port INTEGER DEFAULT 4370,
        password INTEGER DEFAULT 0,
        active INTEGER DEFAULT 1
    , last_records INTEGER DEFAULT 0, last_sync_at TEXT);
CREATE TABLE sqlite_sequence(name,seq);
CREATE TABLE users (
        device_id INTEGER,
        uid INTEGER,
        user_id TEXT,
        name TEXT,
        privilege INTEGER DEFAULT 0,
        synced_at TEXT, department TEXT,
        PRIMARY KEY (device_id, user_id)
    );
CREATE TABLE areas (
        code TEXT PRIMARY KEY,
        name TEXT,
        updated_at TEXT
    );
CREATE TABLE user_areas (
        user_id TEXT PRIMARY KEY,
        area_code TEXT,
        updated_at TEXT
    );
CREATE TABLE schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        tolerance_min INTEGER DEFAULT 1,
        updated_at TEXT
    );
CREATE TABLE schedule_days (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_id INTEGER NOT NULL,
        weekday INTEGER NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        UNIQUE(schedule_id, weekday)
    );
CREATE TABLE user_schedules (
        user_id TEXT PRIMARY KEY,
        schedule_id INTEGER,
        updated_at TEXT
    );
CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT
    );
CREATE TABLE attendance (
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
CREATE INDEX idx_att_timestamp ON attendance(timestamp);
CREATE INDEX idx_att_device   ON attendance(device_id);
CREATE INDEX idx_att_user     ON attendance(user_id);
CREATE INDEX idx_user_areas_area ON user_areas(area_code);
CREATE INDEX idx_sched_days   ON schedule_days(schedule_id);
CREATE INDEX idx_user_scheds  ON user_schedules(schedule_id);