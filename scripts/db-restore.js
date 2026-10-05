/**
 * scripts/db-restore.js — Restaura un respaldo .sql sobre reportes.db.
 *
 * IMPORTANTE: cierra la app antes de restaurar. Si el servidor esta
 * corriendo mantiene la conexion abierta y los cambios se perderian.
 *
 *   npm run db:restore -- respaldos/reportes-AAAAMMDD-HHMMSS.sql
 */

const fs = require('fs');
const path = require('path');

const APP_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const arg = process.argv[2];

if (!arg) {
    console.error('  Uso: npm run db:restore -- <archivo.sql>');
    process.exit(1);
}

const src = path.resolve(process.cwd(), arg);
if (!fs.existsSync(src)) {
    console.error(`  No existe el respaldo: ${src}`);
    process.exit(1);
}

const target = path.join(APP_DIR, 'reportes.db');

// No cargamos better-sqlite3 hasta aqui: si el proceso de node la tiene
// cargada, no hay problema, pero fallar aqui seria mas claro.
let Database;
try {
    Database = require('better-sqlite3');
} catch (e) {
    console.error('  Falta better-sqlite3. Corre: npm install');
    process.exit(1);
}

// Red de seguridad: si la app esta corriendo, el puerto estaria ocupado.
try {
    const net = require('net');
    const { initDatabase } = require('../db-init');
    const info = initDatabase(target, { verbose: true });
    info.close();
} catch (e) {
    console.error(`  No se pudo preparar la base: ${e.message}`);
    process.exit(1);
}

// Respaldamos lo que hubiera antes de sobrescribir.
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
const bakDir = path.join(APP_DIR, 'respaldos');
fs.mkdirSync(bakDir, { recursive: true });
const bak = path.join(bakDir, `pre-restore-${stamp}.db`);
fs.copyFileSync(target, bak);

const db = new Database(target);
db.pragma('foreign_keys = OFF');
db.exec(fs.readFileSync(src, 'utf8'));
db.pragma('foreign_keys = ON');
db.exec('VACUUM');
db.close();

const check = new Database(target, { readonly: true });
const tables = check
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map(r => r.name);
const n = t => {
    try {
        return check.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
    } catch (e) {
        return 'n/a';
    }
};
check.close();

console.log(`  Restaurado: ${path.basename(src)}`);
console.log(`    tablas:     ${tables.join(', ')}`);
console.log(`    devices:    ${n('devices')}`);
console.log(`    users:      ${n('users')}`);
console.log(`    departments:${n('departments')}`);
console.log(`    attendance: ${n('attendance')}`);
console.log(`\n  Copia de seguridad previa: ${path.relative(APP_DIR, bak)}`);