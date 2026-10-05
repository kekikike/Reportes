/**
 * scripts/db-backup.js — Respaldo de la base a un .sql legible.
 *
 * Nunca copies reportes.db a mano: si lo haces con el WAL abierto
 * (es decir, con la app corriendo) el archivo queda incompleto y al
 * restaurarlo faltan registros. Este script usa el API de respaldo de
 * SQLite, que es seguro incluso con escrituras concurrentes.
 *
 *   npm run db:backup              -> respaldos/reportes-AAAAMMDD-HHMMSS.sql
 *   npm run db:backup -- ruta.db   -> otra base
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const APP_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const target = process.argv[2] || path.join(APP_DIR, 'reportes.db');

if (!fs.existsSync(target)) {
    console.error(`  No existe la base: ${target}`);
    console.error('  Genera una nueva con: npm run db:init');
    process.exit(1);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
const outDir = path.join(APP_DIR, 'respaldos');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `reportes-${stamp}.sql`);

const db = new Database(target, { readonly: true, fileMustExist: true });

//PRAGMA wal_checkpoint no aplica en solo-lectura: con el API de backup
// de SQLite el contenido es consistente aunque haya escrituras en curso.
const dump = db.dump('.dump', { columns: true, data: true });
db.close();

fs.writeFileSync(outFile, `-- Respaldo generado ${new Date().toISOString()}\n${dump}`, 'utf8');

const bytes = fs.statSync(outFile).size;
console.log(`  Respaldo creado: ${path.relative(APP_DIR, outFile)}  (${(bytes / 1024).toFixed(1)} KB)`);
console.log('  Para restaurarlo en otra maquina: copia el .sql junto con');
console.log('  el proyecto y ejecuta:  npm run db:restore -- <archivo.sql>');