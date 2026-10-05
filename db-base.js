/**
 * db-base.js — Genera db/base.sql, la BD base en texto plano.
 *
 * Por que un .sql y no solo el .db: SQLite es binario y no se versiona
 * bien en git (dos personas que regeneran la base producen bytes
 * distintos -> conflicto inutil de resolver). Un .sql es texto, se
 * mergea con sentido y sirve para cualquier herramienta.
 *
 * El .sql se genera REALMENTE creando una base temporal con db-init.js
 * y volcandola, asi que nunca puede quedar desincronizado del esquema
 * que usa la app.
 *
 * Para cambiar el esquema: editar db-init.js, luego correr db:dump.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { initDatabase } = require('./db-init');

const OUT_DIR = path.join(__dirname, 'db');
const OUT_FILE = path.join(OUT_DIR, 'base.sql');

/** Crea una BD efimera con el esquema + semilla y devuelve su volcado. */
function buildBaseSql() {
    const tmp = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'reportes-base-')),
        'base.db'
    );

    // initDatabase aplica esquema + migraciones + dispositivo por defecto.
    const info = initDatabase(tmp, { verbose: true });
    info.close();

    const db = new Database(tmp, { readonly: true, fileMustExist: true });
    // better-sqlite3 no expone .dump(): usar el metodo nativo
    const stmt = db.prepare('SELECT sql FROM sqlite_master WHERE type IN ("table","index") AND sql IS NOT NULL');
    const ddl = stmt.all().map(r => r.sql + ';').join('\n');
    const d2 = db.prepare('SELECT sql FROM sqlite_master WHERE type="trigger" AND sql IS NOT NULL');
    const trig = d2.all().map(r => r.sql + ';').join('\n');
    const dump = [ddl, trig].filter(Boolean).join('\n');
    db.close();

    fs.rmSync(tmp, { force: true });
    fs.rmSync(path.dirname(tmp), { force: true });

    return dump;
}

function generate() {
    const dump = buildBaseSql();
    const header = [
        '-- ============================================================',
        '--  BD BASE del sistema de reportes  (GENERADO AUTOMATICAMENTE)',
        '--',
        '--  Contiene: esquema completo + el dispositivo por defecto.',
        '--  NO contiene datos reales de la empresa.',
        '--',
        '--  Para cambiar el esquema: editar db-init.js y correr',
        '--  el script npm run db:dump. No editar este archivo a mano.',
        '-- ============================================================',
        '',
    ].join('\n');

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_FILE, header + dump, 'utf8');
    return OUT_FILE;
}

if (require.main === module) {
    const file = generate();
    const kb = (fs.statSync(file).size / 1024).toFixed(1);
    console.log(`  ${path.relative(__dirname, file)} generado (${kb} KB)`);
}

module.exports = { generate, buildBaseSql };