/**
 * db-init.js — Esquema, migraciones y semilla de la base de datos.
 *
 * Este modulo es la UNICA fuente de verdad del esquema. Lo usan:
 *   - app.js            -> bootstrap() al arrancar el servidor
 *   - node db-init.js   -> genera la BD base (`npm run db:init`)
 *
 * Se mantiene en un archivo aparte (y no embebido en app.js) para que el
 * esquema sea versionable y la BD base se pueda regenerar de forma
 * identica a como la crea la app en tiempo de ejecucion.
 *
 * Todo es idempotente: se puede ejecutar N veces sobre la misma BD sin
 * duplicar nada y sin perder datos existentes.
 */

const path = require('path');
const SQLiteDB = require('./sqlitedb');

// ----------------------------------------------------------------
//  Esquema base
// ----------------------------------------------------------------
const SCHEMA_SQL = `
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

    -- Areas de la empresa (antes "departamentos").
    CREATE TABLE IF NOT EXISTS areas (
        code TEXT PRIMARY KEY,
        name TEXT,
        updated_at TEXT
    );

    -- Relacion LOCAL usuario <-> area. Vive en esta base y NO se pisa con la
    -- sincronizacion del biometrico: es la fuente de verdad de a que area
    -- pertenece cada usuario. La PRIMARY KEY sobre user_id garantiza que un
    -- usuario este en UNA sola area; un area puede tener muchos usuarios.
    CREATE TABLE IF NOT EXISTS user_areas (
        user_id TEXT PRIMARY KEY,
        area_code TEXT,
        updated_at TEXT
    );

    -- Horarios: plantilla semanal con nombre. Un empleado tiene a lo sumo un
    -- horario; un horario puede estar asignado a varios empleados.
    CREATE TABLE IF NOT EXISTS schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        tolerance_min INTEGER DEFAULT 1,
        updated_at TEXT
    );

    -- Bloques de un horario: cada dia de la semana (1=Lunes .. 7=Domingo)
    -- puede tener su propia hora de inicio/fin. Esto permite horarios
    -- dinamicos (distintas horas cada dia).
    CREATE TABLE IF NOT EXISTS schedule_days (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_id INTEGER NOT NULL,
        weekday INTEGER NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        UNIQUE(schedule_id, weekday)
    );

    -- Relacion LOCAL usuario <-> horario (un horario por empleado). Vive en
    -- esta base y NO se pisa al sincronizar con el biometrico.
    CREATE TABLE IF NOT EXISTS user_schedules (
        user_id TEXT PRIMARY KEY,
        schedule_id INTEGER,
        updated_at TEXT
    );

    -- Historial versionado de la asignacion de horario. Cada fila guarda una
    -- FOTO del horario vigente desde valid_from (fecha/hora local). Asi los
    -- dias anteriores conservan el horario que tenian y los cambios no
    -- reescriben el pasado. schedule_id NULL = sin horario desde ese momento.
    CREATE TABLE IF NOT EXISTS user_schedule_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        schedule_id INTEGER,
        schedule_name TEXT,
        tolerance_min INTEGER,
        days_json TEXT,
        valid_from TEXT NOT NULL,
        created_at TEXT
    );

    -- Justificaciones de asistencia. Una justificacion convierte una falta en
    -- permiso y un atraso / salida temprana en "con permiso".
    --   tipo: 'falta' | 'atraso' | 'salida_temprana'
    -- La clave (usuario, fecha, tipo) garantiza una sola justificacion por
    -- incidencia y dia.
    CREATE TABLE IF NOT EXISTS justifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        date TEXT NOT NULL,
        tipo TEXT NOT NULL,
        reason TEXT,
        created_at TEXT,
        UNIQUE(user_id, date, tipo)
    );

    -- Metadatos internos (marcadores de migraciones de un solo uso).
    CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
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
    CREATE INDEX IF NOT EXISTS idx_user_areas_area ON user_areas(area_code);
    CREATE INDEX IF NOT EXISTS idx_sched_days   ON schedule_days(schedule_id);
    CREATE INDEX IF NOT EXISTS idx_user_scheds  ON user_schedules(schedule_id);
    CREATE INDEX IF NOT EXISTS idx_user_sched_hist ON user_schedule_history(user_id, valid_from);
    CREATE INDEX IF NOT EXISTS idx_just_user    ON justifications(user_id);
    CREATE INDEX IF NOT EXISTS idx_just_date    ON justifications(date);
`;

/** Dispositivo por defecto: ZKTeco K40 de la oficina. */
const DEFAULT_DEVICE = {
    name: 'Biométrico K40',
    ip: '192.168.118.172',
    port: 4370,
    password: 0,
};

// ----------------------------------------------------------------
//  Migraciones incrementales
//
//  Añadir aqui las nuevas, en orden. Para que el esquema de una BD
//  antigua converja al actual hay que ejecutarlas SIEMPRE, no solo en
//  BD nuevas.
// ----------------------------------------------------------------
function migrate(db) {
    // Sincronizacion incremental: indice del ultimo ATTLOG leido.
    const devCols = db.all('PRAGMA table_info(devices)');
    if (!devCols.some(c => c.name === 'last_records')) {
        db.exec('ALTER TABLE devices ADD COLUMN last_records INTEGER DEFAULT 0');
    }
    if (!devCols.some(c => c.name === 'last_sync_at')) {
        db.exec('ALTER TABLE devices ADD COLUMN last_sync_at TEXT');
    }

    // El biometrico expone el group_id (codigo) de cada empleado en esta
    // columna. Se conserva como referencia del equipo, pero la relacion
    // local usuario<->area vive en `user_areas` (ver abajo).
    const userCols = db.all('PRAGMA table_info(users)');
    if (!userCols.some(c => c.name === 'department')) {
        db.exec('ALTER TABLE users ADD COLUMN department TEXT');
    }

    // ---- Renombrado "departments" -> "areas" ------------------------
    // Las BD anteriores guardaban las areas en `departments`; se copian a
    // `areas` y se elimina la tabla vieja (operacion idempotente).
    const tablas = db.all("SELECT name FROM sqlite_master WHERE type='table'");
    const existeTabla = (n) => tablas.some(t => t.name === n);
    if (existeTabla('departments')) {
        db.exec('INSERT OR IGNORE INTO areas (code, name, updated_at) SELECT code, name, updated_at FROM departments');
        db.exec('DROP TABLE departments');
    }

    // ---- Relacion local usuario <-> area ----------------------------
    // Migracion de un solo uso: las asignaciones historicas vivian en
    // users.department. Se copian a user_areas y se marca en `meta` para no
    // rehacerlo nunca mas (asi borrar un area a proposito no se deshace al
    // reiniciar). A partir de aqui manda SOLO user_areas.
    const sembrado = db.get("SELECT value FROM meta WHERE key = 'user_areas_seeded'");
    if (!sembrado) {
        const ahora = new Date().toISOString();
        db.run(
            `INSERT OR IGNORE INTO user_areas (user_id, area_code, updated_at)
             SELECT user_id, department, ?
             FROM users
             WHERE department IS NOT NULL AND department <> ''`,
            ahora
        );
        db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('user_areas_seeded', ?)", ahora);
    }

    // Garantiza que todo codigo referenciado en user_areas exista en areas
    // (por si la relacion llego de una BD donde la tabla de areas no estaba).
    db.exec("INSERT OR IGNORE INTO areas (code, name, updated_at) SELECT DISTINCT area_code, NULL, datetime('now') FROM user_areas WHERE area_code IS NOT NULL AND area_code <> ''");

    // ---- Historial de horarios --------------------------------------
    // Las BD anteriores guardaban una sola asignacion por empleado. Se
    // siembra esa asignacion como vigente desde el inicio de los tiempos
    // para que el pasado se siga evaluando con el horario actual. Los
    // cambios posteriores agregan una nueva foto sin tocar los dias previos.
    const sinHistorial = db.all(
        `SELECT us.user_id, us.schedule_id
           FROM user_schedules us
          WHERE us.schedule_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM user_schedule_history h WHERE h.user_id = us.user_id)`
    );
    for (const us of sinHistorial) {
        const s = db.get('SELECT name, tolerance_min FROM schedules WHERE id = ?', us.schedule_id);
        const days = Object.create(null);
        for (const d of db.all('SELECT weekday, start_time, end_time FROM schedule_days WHERE schedule_id = ?', us.schedule_id)) {
            days[Number(d.weekday)] = { start: d.start_time, end: d.end_time };
        }
        db.run(
            `INSERT INTO user_schedule_history
                (user_id, schedule_id, schedule_name, tolerance_min, days_json, valid_from, created_at)
             VALUES (?, ?, ?, ?, ?, '2000-01-01 00:00:00', ?)`,
            us.user_id,
            us.schedule_id,
            s ? s.name : '',
            s ? (Number(s.tolerance_min) || 1) : 1,
            JSON.stringify(days),
            new Date().toISOString()
        );
    }

    // Limpieza de timestamps ISO con sufijo 'Z' que dejo una version
    // anterior. Solo corre si quedan filas: es un no-op en BD sanas.
    const { c } = db.get("SELECT COUNT(*) AS c FROM attendance WHERE timestamp LIKE '%T%Z'");
    if (c > 0) db.exec("DELETE FROM attendance WHERE timestamp LIKE '%T%Z'");
}

/**
 * Registra el dispositivo por defecto si no existe.
 * NO siembra usuarios ni asistencias: ese roster llega del sincronizado
 * con el biometrico, no del repositorio.
 */
function seedDefaultDevice(db) {
    const existing = db.get('SELECT * FROM devices WHERE ip = ?', DEFAULT_DEVICE.ip);
    if (existing) return false;
    db.run(
        'INSERT INTO devices (name, ip, port, password) VALUES (?, ?, ?, ?)',
        [DEFAULT_DEVICE.name, DEFAULT_DEVICE.ip, DEFAULT_DEVICE.port, DEFAULT_DEVICE.password]
    );
    return true;
}

/**
 * Crea la base si no existe y la deja al dia (esquema + migraciones +
 * semilla). Devuelve informacion util para diagnostico.
 */
function initDatabase(file, { seed = true, verbose = false } = {}) {
    const isNew = !require('fs').existsSync(file);
    const db = new SQLiteDB(file);
    db.init();

    db.exec(SCHEMA_SQL);
    migrate(db);
    const seeded = seed ? seedDefaultDevice(db) : false;
    db.save();

    const info = {
        file,
        isNew,
        seeded,
        tables: db.all(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).map(r => r.name),
    };

    // Contrato estable: info.db es la conexion e info.close() la cierra,
    // exista o no `verbose` (asi el CLI y db-base.js no se rompen).
    info.db = db;
    let closed = false;
    info.close = () => {
        if (closed) return;
        closed = true;
        db.close();
    };
    return info;
}

// ----------------------------------------------------------------
//  CLI:  node db-init.js [ruta/archivo.db] [--reset]
// ----------------------------------------------------------------
if (require.main === module) {
    const args = process.argv.slice(2);
    const reset = args.includes('--reset');
    const target = args.find(a => !a.startsWith('--')) || path.join(__dirname, 'reportes.db');
    const fs = require('fs');

    if (reset && fs.existsSync(target)) {
        for (const suffix of ['', '-wal', '-shm']) {
            const p = target + suffix;
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }
        console.log(`  BD eliminada: ${path.basename(target)}`);
    }

    const res = initDatabase(target, { verbose: true });
    console.log(`  BD base lista: ${res.file}`);
    console.log(`    ${res.isNew ? 'creada desde cero' : 'actualizada (se conservaron los datos)'}`);
    console.log(`    tablas: ${res.tables.join(', ')}`);
    console.log(`    dispositivo por defecto: ${DEFAULT_DEVICE.ip}:${DEFAULT_DEVICE.port}`);
    console.log('');
    console.log('  Siguiente paso: npm start  (o npm run dev)');
}

module.exports = { SCHEMA_SQL, DEFAULT_DEVICE, initDatabase, migrate, seedDefaultDevice };