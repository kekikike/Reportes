/**
 * scripts/db-doctor.js — Diagnostico de la base.
 *
 *   npm run db:doctor
 *
 * Dice si la base esta sana, si le falta alguna tabla del esquema actual
 * y si hay datos. Pensado para responder rapido a "pull limpio, ahora
 * que?" sin tener que abrir el SQLite a mano.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { SCHEMA_SQL, DEFAULT_DEVICE } = require('../db-init');

const APP_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const target = process.argv[2] || path.join(APP_DIR, 'reportes.db');

const EXPECTED = ['attendance', 'departments', 'devices', 'users'];

console.log(`\n  Base: ${target}\n`);

if (!fs.existsSync(target)) {
    console.log('  [FALTA] No existe todavia. Es normal en un pull recien hecho.');
    console.log('          Se crea sola al arrancar (npm start) o con: npm run db:init\n');
    process.exit(0);
}

const sizeKb = (fs.statSync(target).size / 1024).toFixed(1);
console.log(`  Tamano: ${sizeKb} KB`);

let db;
try {
    db = new Database(target, { readonly: true, fileMustExist: true });
} catch (e) {
    console.log(`  [ERROR] No se pudo abrir: ${e.message}`);
    process.exit(1);
}

// Integridad
const integ = db.pragma('integrity_check', { simple: true });
console.log(`  Integridad: ${integ === 'ok' ? 'OK' : 'CORRUPTA -> ' + integ}`);

// Tablas
const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map(r => r.name);
const faltan = EXPECTED.filter(t => !tables.includes(t));
console.log(`  Tablas: ${tables.join(', ') || '(ninguna)'}`);
if (faltan.length) {
    console.log(`  [AVISO] Faltan tablas del esquema actual: ${faltan.join(', ')}`);
    console.log('          Se corrigen solas al arrancar la app (migraciones idempotentes).');
}

// Columnas esperadas en tablas clave
const cols = t => {
    try {
        return db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
    } catch (e) {
        return [];
    }
};
const devCols = cols('devices');
const usrCols = cols('users');
const faltanCols = [
    ...['last_records', 'last_sync_at'].filter(c => devCols.length && !devCols.includes(c))
        .map(c => `devices.${c}`),
    ...['department'].filter(c => usrCols.length && !usrCols.includes(c)).map(c => `users.${c}`),
];
if (faltanCols.length) console.log(`  [AVISO] Columnas pendientes de migracion: ${faltanCols.join(', ')}`);

// Datos
const count = t => {
    try {
        return db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
    } catch (e) {
        return null;
    }
};
const devs = count('devices');
const users = count('users');
const att = count('attendance');
console.log(`\n  Datos:`);
console.log(`    devices:     ${devs}`);
console.log(`    users:       ${users}`);
console.log(`    departments: ${count('departments')}`);
console.log(`    attendance:  ${att}`);

// Dispositivo
try {
    const d = db.prepare('SELECT * FROM devices ORDER BY id LIMIT 1').get();
    if (d) {
        const coincide = d.ip === DEFAULT_DEVICE.ip;
        console.log(`\n  Dispositivo principal: ${d.name} (${d.ip}:${d.port})`);
        if (coincide) console.log('  -> es el de por defecto, aun no sincronizado');
    } else {
        console.log('\n  [AVISO] No hay ningun dispositivo registrado.');
    }
} catch (e) { /* tabla ausente */ }

// Registros con timestamp ISO (bug de una version anterior)
try {
    const z = db.get("SELECT COUNT(*) c FROM attendance WHERE timestamp LIKE '%T%Z'");
    if (z && z.c > 0) console.log(`\n  [AVISO] ${z.c} filas con timestamp ISO obsoleto (se limpian al arrancar)`);
} catch (e) { /* tabla ausente */ }

db.close();

if (!users) {
    console.log('\n  Siguiente paso: la base esta vacia. Arranca la app y usa');
    console.log('  "Sincronizar" para traer usuarios y asistencias del biometrico.\n');
} else {
    console.log('\n  Base lista con datos.\n');
}