/**
 * build-paquete.js — Arma `dist/PAQUETE-OTRO-PC/` para llevarlo a otra PC.
 *
 * Toma una FOTO online (WAL-safe) de la base de trabajo `reportes.db` y la
 * limpia para que el paquete sea una "maestra" lista para sincronizar:
 *
 *   - Conserva: usuarios, areas, user_areas, horarios (schedules /
 *     schedule_days / user_schedules) y la configuracion de dispositivos.
 *   - Elimina: TODO el historial de asistencias.
 *   - Reinicia devices.last_records = 0 para que la primera sincronizacion
 *     descargue el historial completo del biometrico.
 *
 * Ademas copia el ejecutable ya compilado y deja la base en journal_mode
 * DELETE (un solo archivo, sin sidecars -wal/-shm).
 *
 * Uso:  npm run paquete
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'reportes.db');
const EXE = path.join(ROOT, 'dist', 'ZKTecoReportes.exe');
const PKG_DIR = path.join(ROOT, 'dist', 'PAQUETE-OTRO-PC');
const DST_DB = path.join(PKG_DIR, 'reportes.db');

function log(...a) { console.log(' ', ...a); }

async function main() {
    if (!fs.existsSync(SRC_DB)) {
        console.error('  No existe reportes.db (la base de trabajo).');
        process.exit(1);
    }
    if (!fs.existsSync(EXE)) {
        console.error('  No existe el ejecutable. Compilalo primero:');
        console.error('    npx pkg . --output "dist\\ZKTecoReportes.exe"');
        process.exit(1);
    }

    fs.mkdirSync(PKG_DIR, { recursive: true });

    // 1) Foto online de la base de trabajo (sin bloquear al servidor).
    log('Copiando la base de trabajo (backup online)...');
    const src = new Database(SRC_DB, { readonly: true });
    await src.backup(DST_DB);
    src.close();

    // 2) Limpieza sobre la copia: sin asistencias y con sync desde cero.
    log('Limpiando el historial de asistencias y reiniciando last_records...');
    const db = new Database(DST_DB);
    db.exec(`
        DELETE FROM attendance;
        UPDATE devices SET last_records = 0, last_sync_at = NULL;
    `);
    const resumen = {
        usuarios: db.prepare('SELECT COUNT(DISTINCT user_id) n FROM users').get().n,
        areas: db.prepare('SELECT COUNT(*) n FROM areas').get().n,
        asignados: db.prepare('SELECT COUNT(*) n FROM user_areas').get().n,
        horarios: db.prepare('SELECT COUNT(*) n FROM schedules').get().n,
        horarios_asignados: db.prepare('SELECT COUNT(*) n FROM user_schedules').get().n,
        asistencias: db.prepare('SELECT COUNT(*) n FROM attendance').get().n,
    };
    // Deja un solo archivo (sin -wal/-shm) para poder copiarlo suelto.
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.pragma('journal_mode = DELETE');
    db.close();

    // 3) Copiar el ejecutable ya compilado.
    log('Copiando ZKTecoReportes.exe...');
    fs.copyFileSync(EXE, path.join(PKG_DIR, 'ZKTecoReportes.exe'));

    log('');
    log('Paquete listo en dist/PAQUETE-OTRO-PC/');
    log(`  usuarios:            ${resumen.usuarios}`);
    log(`  areas:               ${resumen.areas}`);
    log(`  usuarios con area:   ${resumen.asignados}`);
    log(`  horarios:            ${resumen.horarios}`);
    log(`  usuarios con horario:${resumen.horarios_asignados}`);
    log(`  asistencias:         ${resumen.asistencias} (debe ser 0)`);
}

main().catch(e => { console.error('  Error:', e.message); process.exit(1); });
