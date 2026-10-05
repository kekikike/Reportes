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

    // El biometrico solo expone el group_id (codigo), no el nombre.
    const userCols = db.all('PRAGMA table_info(users)');
    if (!userCols.some(c => c.name === 'department')) {
        db.exec('ALTER TABLE users ADD COLUMN department TEXT');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_users_department ON users(department)');

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