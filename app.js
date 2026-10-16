/**
 * reportes/app.js — Aplicación Express.js para reportes biométricos ZKTeco.
 * Sustituto ligero de BioTime Attendance.
 *
 * Iniciar:  node app.js
 * Web:      http://localhost:3000
 * API:      http://localhost:3000/api/attendance?desde=2026-01-01&hasta=2026-01-31
 */

const express = require('express');
const ExcelJS = require('exceljs');
const PDFDocument = require('./pdfgen');
const path    = require('path');
const cors    = require('cors');
const ZKDevice = require('./zk-client');

const app = express();
const IS_PKG = !!process.pkg;
const APP_DIR = IS_PKG ? path.dirname(process.execPath) : __dirname;
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// El navegador pide /favicon.ico automaticamente. La interfaz ya declara su
// icono en linea, pero por si acaso respondemos 204 (sin contenido) en vez de
// un 404 ruidoso en la consola.
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ----------------------------------------------------------------
//  Base de datos SQLite (historial local)
// ----------------------------------------------------------------
const { initDatabase } = require('./db-init');

/**
 * Proxy diferido: las rutas se registran antes de que exista la conexion,
 * pero `db` solo se materializa en bootstrap(). Todas las llamadas se
 * reenvian a la instancia real.
 */
let _db = null;
const db = new Proxy({}, {
    get(_t, prop) {
        if (!_db) throw new Error('La base de datos aun no esta inicializada (falta bootstrap)');
        const v = _db[prop];
        return typeof v === 'function' ? v.bind(_db) : v;
    },
});

async function bootstrap() {
    const info = initDatabase(path.join(APP_DIR, 'reportes.db'));
    _db = info.db;

    // Limpieza única de nombres heredados del biométrico:
    //   ';' -> espacio, 'Ñ'/'ñ' -> 'N', colapsa espacios.
    // Corrige registros ya guardados (ej: "IÑIGUEZ" o "JUAN;PEREZ").
    try {
        const clean = (s) => String(s || '')
            .replace(/;/g, ' ')
            .replace(/[Ññ]/g, 'N')
            .replace(/\uFFFD/g, 'N')
            .replace(/\s+/g, ' ')
            .trim();
        for (const tabla of ['users', 'attendance']) {
            const filas = db.all(`SELECT rowid AS rid, name FROM ${tabla}`);
            for (const f of filas) {
                const limpio = clean(f.name);
                if (limpio !== f.name) {
                    db.run(`UPDATE ${tabla} SET name = ? WHERE rowid = ?`, [limpio, f.rid]);
                }
            }
        }
        db.save();
    } catch (e) {
        console.warn('Aviso limpieza de nombres:', e.message);
    }
}

// Normaliza nombres para vista/exportes: ';' -> espacio, Ñ/ñ -> N,
// colapsa espacios y limpia caracteres de relleno del biométrico.
function _cleanNameView(s) {
    return String(s || '')
        .replace(/;/g, ' ')
        .replace(/[Ññ]/g, 'N')
        .replace(/\uFFFD/g, 'N') // carácter de reemplazo (Ñ mal decodificada)
        .replace(/\s+/g, ' ')
        .trim();
}

function deviceConfig() {
    const d = db.get('SELECT * FROM devices ORDER BY id LIMIT 1');
    return {
        ip:       (d && d.ip)       || '192.168.118.172',
        port:     (d && d.port)     || 4370,
        password: (d && d.password) || 0,
    };
}

function setDeviceConfig(ip, port, password) {
    const cleanIp = String(ip || '').trim();
    if (!cleanIp) return;
    const cp = parseInt(port) || 4370;
    const pw = (password !== undefined && password !== null) ? password : 0;
    const existing = db.get('SELECT * FROM devices ORDER BY id LIMIT 1');
    if (existing) {
        db.run('UPDATE devices SET name = ?, ip = ?, port = ?, password = ? WHERE id = ?', ['Biométrico ' + cleanIp, cleanIp, cp, pw, existing.id]);
    } else {
        db.run('INSERT INTO devices (name, ip, port, password) VALUES (?, ?, ?, ?)', ['Biométrico ' + cleanIp, cleanIp, cp, pw]);
    }
    db.save();
}

// ----------------------------------------------------------------
//  Areas
//
//  La relacion usuario <-> area es LOCAL: vive en la tabla `user_areas`
//  (una area por usuario, un area puede tener varios usuarios) y NO se
//  pisa al sincronizar con el biometrico. El equipo solo aporta el codigo
//  de area (group_id), que se registra en `areas` para que el usuario le
//  asigne un nombre desde la interfaz.
// ----------------------------------------------------------------
function areaNameMap() {
    const map = Object.create(null);
    for (const r of db.all('SELECT code, name FROM areas')) {
        if (r.name) map[r.code] = r.name;
    }
    return map;
}

// { user_id -> { codigo, nombre } } tomando la relacion local guardada.
function userAreaMap() {
    const map = Object.create(null);
    const names = areaNameMap();
    for (const r of db.all('SELECT user_id, area_code FROM user_areas WHERE area_code IS NOT NULL')) {
        if (!r.area_code) continue;
        map[r.user_id] = {
            codigo: r.area_code,
            nombre: names[r.area_code] || r.area_code,
        };
    }
    return map;
}

// Registra un codigo recien leido del equipo (sin pisar el nombre ya
// asignado localmente).
function _registrarArea(codigo) {
    if (codigo === null || codigo === undefined || codigo === '') return;
    db.run('INSERT OR IGNORE INTO areas (code, name, updated_at) VALUES (?, NULL, ?)',
        String(codigo), new Date().toISOString());
}

// ----------------------------------------------------------------
//  Horarios
//
//  Un horario es una plantilla semanal: para cada dia (1=Lunes .. 7=Domingo)
//  define una hora de inicio y fin. Un empleado se asigna a UN horario.
//  Hay atraso cuando la entrada del dia supera la hora de inicio mas la
//  tolerancia (1 minuto por defecto: si inicia 08:30, hasta 08:30:59 es
//  normal; 08:31:00 o mas es atraso).
// ----------------------------------------------------------------
function _hhmmToSec(t) {
    const p = String(t || '').split(':').map(Number);
    return (p[0] || 0) * 3600 + (p[1] || 0) * 60 + (p[2] || 0);
}

// Dia ISO de la semana: 1=Lunes .. 7=Domingo.
function _isoWeekday(isoDate) {
    const p = String(isoDate || '').slice(0, 10).split('-').map(Number);
    if (!p[0] || !p[1] || !p[2]) return 0;
    const wd = new Date(p[0], p[1] - 1, p[2]).getDay(); // 0=Domingo
    return wd === 0 ? 7 : wd;
}

// Carga horarios + dias + asignaciones en un solo paso.
function loadSchedules() {
    const scheds = Object.create(null);
    for (const s of db.all('SELECT id, name, tolerance_min FROM schedules')) {
        scheds[s.id] = {
            id: s.id,
            name: s.name,
            tolerance_min: Number(s.tolerance_min) || 1,
            days: Object.create(null),
        };
    }
    for (const d of db.all('SELECT schedule_id, weekday, start_time, end_time FROM schedule_days')) {
        const s = scheds[d.schedule_id];
        if (s) s.days[Number(d.weekday)] = { start: d.start_time, end: d.end_time };
    }
    const userSched = Object.create(null);
    for (const r of db.all('SELECT user_id, schedule_id FROM user_schedules WHERE schedule_id IS NOT NULL')) {
        userSched[r.user_id] = r.schedule_id;
    }
    return { scheds, userSched };
}

// Justificaciones del periodo: { 'user_id|date|tipo' -> reason }.
function loadJustifications(desde, hasta) {
    const map = Object.create(null);
    let where = '1=1';
    const params = [];
    if (desde) { where += ' AND date >= ?'; params.push(String(desde).slice(0, 10)); }
    if (hasta) { where += ' AND date <= ?'; params.push(String(hasta).slice(0, 10)); }
    for (const r of db.prepare(`SELECT user_id, date, tipo, reason FROM justifications WHERE ${where}`).all(...params)) {
        map[r.user_id + '|' + r.date + '|' + r.tipo] = r.reason || '';
    }
    return map;
}

// Fecha local de hoy (YYYY-MM-DD), sin desfase UTC.
function _todayIso() {
    const d = new Date();
    const p = x => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Evalua una jornada (entrada/salida) contra el horario del empleado.
// Devuelve null si no hay horario/dia aplicable para esa fecha.
function _evalHorario(entrada, salida, fecha, schedule) {
    if (!schedule) return null;
    const day = schedule.days[_isoWeekday(fecha)];
    if (!day || !day.start || !day.end) return null;
    const startSec = _hhmmToSec(day.start);
    const endSec   = _hhmmToSec(day.end);
    const overnight = endSec <= startSec;
    const tol      = (Number(schedule.tolerance_min) || 1) * 60;

    let late = false, retrasoMin = 0;
    if (entrada) {
        const entSec = _hhmmToSec(String(entrada).slice(11, 19));
        if (entSec > startSec + tol - 1) {
            late = true;
            retrasoMin = Math.max(0, Math.floor((entSec - startSec) / 60));
        }
    }

    let early = false, salidaMin = 0;
    if (salida) {
        const salSec = _hhmmToSec(String(salida).slice(11, 19));
        const finSec = overnight ? endSec + 86400 : endSec;
        const salRel = overnight ? salSec + 86400 : salSec;
        if (salRel < finSec - (tol - 1)) {
            early = true;
            salidaMin = Math.max(0, Math.floor((finSec - salRel) / 60));
        }
    }

    return {
        esperado: String(day.start).slice(0, 5),
        esperado_salida: String(day.end).slice(0, 5),
        late, retrasoMin, early, salidaMin,
    };
}

// ¿Ya terminó el horario de ese día? Se usa para no marcar falta de forma
// anticipada: la falta solo se considera cuando el turno ya pasó.
function _horarioPasado(fecha, day, hoy) {
    if (fecha < hoy) return true;   // día anterior: el turno ya terminó
    if (fecha > hoy) return false;  // día futuro: todavía no aplica
    // Hoy: solo si ya pasó la hora de fin. Los nocturnos terminan al día
    // siguiente, así que hoy aún no han terminado.
    const startSec = _hhmmToSec(day.start);
    const endSec   = _hhmmToSec(day.end);
    if (endSec <= startSec) return false;
    const ahora = new Date();
    const ahoraSec = ahora.getHours() * 3600 + ahora.getMinutes() * 60 + ahora.getSeconds();
    return ahoraSec > endSec;
}

// ----------------------------------------------------------------
//  Jornadas por empleado: cada día (o turno que cruza medianoche)
//  genera una fila con su ENTRADA y SALIDA.
// ----------------------------------------------------------------
function _ts(t) {
    return Date.parse(String(t).replace(' ', 'T'));
}

function _addDays(iso, n) {
    const parts = String(iso).split('-').map(Number);
    const d = new Date(parts[0], parts[1] - 1, parts[2] + n);
    const p = x => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Construye las jornadas de cada usuario: UNA fila por usuario y día.
// La lógica es local a cada día, sin cruces de medianoche ni inferencias:
// un turno nocturno se resuelve en el módulo de Asistencia, que sí conoce
// el horario del empleado.
//   - ENTRADA = primera marca del día.
//   - SALIDA  = última marca del día (null si solo hay una marca).
// Elige la entrada y la salida de un día. Las marcas MANUALES (device_id = 0,
// cargadas desde la ventana secreta) mandan por encima de las del biométrico:
// si se corrigió la entrada o la salida, esa corrección es la que se ve en
// Entradas/Salidas (y en Asistencia).
function _pickJornada(marks) {
    const manEnt = marks.filter(m => Number(m.device_id) === 0 && Number(m.punch) !== 1);
    const manSal = marks.filter(m => Number(m.device_id) === 0 && Number(m.punch) === 1);
    let entrada = manEnt.length ? manEnt[manEnt.length - 1].timestamp
                               : (marks.length ? marks[0].timestamp : null);
    let salida = manSal.length ? manSal[manSal.length - 1].timestamp
                              : (marks.length > 1 ? marks[marks.length - 1].timestamp : null);
    if (entrada && salida && _ts(salida) <= _ts(entrada)) salida = null;
    const conNombre = marks.find(m => m.name && String(m.name).trim());
    return { entrada, salida, name: conNombre ? conNombre.name : '' };
}

function _buildJornadas(punches) {
    const perUser = Object.create(null);
    for (const p of punches) (perUser[p.user_id] = perUser[p.user_id] || []).push(p);

    const out = [];
    for (const uid of Object.keys(perUser)) {
        const byDate = Object.create(null);
        for (const p of perUser[uid]) {
            const d = String(p.timestamp).slice(0, 10);
            (byDate[d] = byDate[d] || []).push(p);
        }

        for (const d of Object.keys(byDate).sort()) {
            const marks = byDate[d].sort((a, b) => _ts(a.timestamp) - _ts(b.timestamp));
            const j = _pickJornada(marks);
            out.push({
                date: d,
                user_id: uid,
                name: j.name,
                entrada: j.entrada,
                salida: j.salida,
                marcaciones: marks.length,
                inferida: 0,
            });
        }
    }
    return out;
}

// Consulta las marcaciones del periodo y arma las jornadas.
// Incluye un día extra para capturar salidas que cruzan medianoche.
// opts.area : filtra por código o nombre de área.
//             'sin' / '-' = empleados sin área asignada.
function getJornadas({ desde, hasta, q, users, user_id, orden, area }) {
    if (!desde) desde = '2000-01-01';
    if (!hasta) hasta = '2099-12-31';

    let where = 'timestamp >= ? AND timestamp <= ?';
    const params = [desde + ' 00:00:00', hasta + ' 23:59:59'];

    if (user_id) { where += ' AND user_id = ?'; params.push(user_id); }
    if (q && q.trim()) {
        where += ' AND (name LIKE ? COLLATE NOCASE OR user_id LIKE ?)';
        params.push('%' + q.trim() + '%', '%' + q.trim() + '%');
    }
    if (users) {
        const list = String(users).split(',').map(s => s.trim()).filter(Boolean);
        if (list.length) {
            where += ` AND user_id IN (${list.map(() => '?').join(',')})`;
            params.push(...list);
        }
    }

    const punches = db.prepare(
        `SELECT user_id, name, timestamp, punch, status, device_id FROM attendance WHERE ${where} ORDER BY user_id, timestamp`
    ).all(...params);

    // El área es un atributo local del empleado: se resuelve desde la tabla
    // `user_areas` (relación persistida que no se pisa al sincronizar).
    const dept = userAreaMap();
    const filtroDept = String(area || '').trim();

    // Horarios: para saber si la entrada/salida respeta el horario.
    const sched = loadSchedules();
    const hoy = _todayIso();

    const justif = loadJustifications(desde, hasta);
    let rows = _buildJornadas(punches).map(j => {
        const d = dept[j.user_id];
        const fecha = (j.entrada || '').slice(0, 10);
        const ev = _evalHorario(j.entrada, j.salida, fecha, sched.scheds[sched.userSched[j.user_id]]);
        const jAtraso = justif[j.user_id + '|' + fecha + '|atraso'];
        const jSalida = justif[j.user_id + '|' + fecha + '|salida_temprana'];
        // Un atraso/salida justificada deja de contarse (pasa a "con permiso").
        const late  = !!(ev && ev.late)  && !jAtraso;
        const early = !!(ev && ev.early) && !jSalida;

        const motivos = [];
        if (jAtraso) motivos.push({ tipo: 'atraso', reason: jAtraso, hora: (j.entrada || '').slice(11, 16) });
        if (jSalida) motivos.push({ tipo: 'salida_temprana', reason: jSalida, hora: (j.salida || '').slice(11, 16) });

        const partes = [];
        if (late) partes.push('Atraso');
        if (early) partes.push('Salida temprana');
        const estado = partes.length ? partes.join(' + ') : (motivos.length ? 'Con permiso' : 'Presente');

        return {
            date: fecha,
            user_id: j.user_id,
            name: _cleanNameView(j.name),
            area: d ? d.nombre : '',
            area_codigo: d ? d.codigo : '',
            entrada: j.entrada,
            salida: j.salida,
            marcaciones: j.marcaciones,
            inferida: j.inferida || 0,
            hora_esperada: ev ? ev.esperado : '',
            esperado_salida: ev ? ev.esperado_salida : '',
            atraso: late,
            salida_temprana: early,
            falta: false,
            permiso: motivos.length > 0,
            color: motivos.length ? 'green' : '',
            estado,
            justificado: !!jAtraso,
            justificada_falta: false,
            justificada_atraso: !!jAtraso,
            justificada_salida: !!jSalida,
            motivo: motivos.map(m => m.reason).join(' | '),
            motivos,
            retraso_min: late ? ev.retrasoMin : 0,
            retraso_seg: late ? ev.retrasoMin * 60 : 0,
            salida_min: early ? ev.salidaMin : 0,
        };
    });

    // Faltas: días de horario SIN marcas (validado SOLO con el horario del
    // empleado). Se evalúan desde la asignación del horario y hasta hoy; una
    // falta justificada se convierte en "Permiso" (verde).
    const yaVistos = new Set(rows.map(r => r.user_id + '|' + r.date));
    const nombres = Object.create(null);
    if (Object.keys(sched.userSched).length) {
        for (const u of db.all('SELECT user_id, MAX(name) AS name FROM users GROUP BY user_id')) {
            nombres[u.user_id] = _cleanNameView(u.name);
        }
    }
    const filtroQ = String(q || '').trim().toLowerCase();
    const listaUsers = users ? String(users).split(',').map(s => s.trim()).filter(Boolean) : null;
    const pisoGlobal = _addDays(hoy, -400); // techo de seguridad (máx. ~400 días)
    const MAX_DIAS = 400;

    for (const uid of Object.keys(sched.userSched)) {
        if (user_id && String(uid) !== String(user_id)) continue;
        if (listaUsers && listaUsers.length && !listaUsers.includes(uid)) continue;
        if (filtroQ) {
            const nm = String(nombres[uid] || '').toLowerCase();
            if (!nm.includes(filtroQ) && !String(uid).toLowerCase().includes(filtroQ)) continue;
        }

        const sch = sched.scheds[sched.userSched[uid]];
        if (!sch) continue;

        let d = desde;
        if (d < pisoGlobal) d = pisoGlobal;

        const dpt = dept[uid];
        let n = 0;
        for (; d <= hasta && d <= hoy && n < MAX_DIAS; d = _addDays(d, 1), n++) {
            const day = sch.days[_isoWeekday(d)];
            if (!day || !day.start || !day.end) continue;
            if (!_horarioPasado(d, day, hoy)) continue;
            if (yaVistos.has(uid + '|' + d)) continue;

            const jFalta = justif[uid + '|' + d + '|falta'];
            const motivos = jFalta ? [{ tipo: 'falta', reason: jFalta, hora: null }] : [];
            rows.push({
                date: d,
                user_id: uid,
                name: nombres[uid] || uid,
                area: dpt ? dpt.nombre : '',
                area_codigo: dpt ? dpt.codigo : '',
                entrada: null,
                salida: null,
                marcaciones: 0,
                inferida: 0,
                hora_esperada: String(day.start).slice(0, 5),
                esperado_salida: String(day.end).slice(0, 5),
                atraso: false,
                salida_temprana: false,
                falta: !jFalta,
                permiso: !!jFalta,
                color: jFalta ? 'green' : 'red',
                estado: jFalta ? 'Permiso' : 'Falta',
                justificado: false,
                justificada_falta: !!jFalta,
                justificada_atraso: false,
                justificada_salida: false,
                motivo: jFalta || '',
                motivos,
                retraso_min: 0,
                retraso_seg: 0,
                salida_min: 0,
            });
        }
    }

    if (filtroDept) {
        const sinDept = ['sin', '-', 'ninguno', 'null'].includes(filtroDept.toLowerCase());
        rows = rows.filter(r => {
            if (sinDept) return !r.area;
            return String(r.area).toLowerCase() === filtroDept.toLowerCase()
                || String(r.area_codigo).toLowerCase() === filtroDept.toLowerCase();
        });
    }

    return rows
        .filter(j => j.date >= desde && j.date <= hasta)
        .sort((a, b) => {
            if (a.date !== b.date) return a.date < b.date ? -1 : 1;
            // 'entrada': orden por hora de entrada, del mas temprano al mas
            // tarde dentro de cada dia. Sin entrada (null) siempre al final.
            if (orden === 'entrada') {
                const ta = a.entrada ? _ts(a.entrada) : Infinity;
                const tb = b.entrada ? _ts(b.entrada) : Infinity;
                if (ta !== tb) return ta - tb;
            }
            return String(a.user_id).localeCompare(String(b.user_id));
        });
}

// ----------------------------------------------------------------
//  Atrasos: resumen por persona y detalle por dia.
//  Reutiliza getJornadas (que ya marca `atraso` en cada jornada).
// ----------------------------------------------------------------
function getRetrasos({ desde, hasta, q, area, user_id }) {
    const rows = getJornadas({ desde, hasta, q, area, user_id });
    const detalle = rows.filter(r => r.atraso).map(r => ({
        date: r.date,
        user_id: r.user_id,
        name: r.name,
        area: r.area,
        area_codigo: r.area_codigo,
        hora_esperada: r.hora_esperada,
        entrada: r.entrada,
        salida: r.salida,
        retraso_min: r.retraso_min,
        retraso_seg: r.retraso_seg,
    }));

    const mapa = Object.create(null);
    for (const r of detalle) {
        if (!mapa[r.user_id]) {
            mapa[r.user_id] = {
                user_id: r.user_id, name: r.name, area: r.area,
                area_codigo: r.area_codigo, retrasos: 0, total_min: 0,
            };
        }
        mapa[r.user_id].retrasos++;
        mapa[r.user_id].total_min += r.retraso_min;
    }
    const resumen = Object.values(mapa)
        .sort((a, b) => b.retrasos - a.retrasos || a.name.localeCompare(b.name, 'es'));

    return { resumen, detalle };
}

// ----------------------------------------------------------------
//  Asistencia: evaluación de cada empleado SEGÚN SU HORARIO.
//
//  Para cada empleado con horario y cada día activo del horario dentro del
//  periodo se determina:
//    - Falta          : no hay marcas ese día                -> justificable (Permiso)
//    - Atraso         : la entrada supera inicio + tolerancia-> justificable (Con permiso)
//    - Salida temprana: la salida es anterior a fin - tolerancia -> justificable (Con permiso)
//
//  Una justificación guardada convierte la incidencia en permiso y deja de
//  contarla como falta / atraso / salida temprana.
// ----------------------------------------------------------------
function _secOf(ts) {
    return _hhmmToSec(String(ts || '').slice(11, 19));
}

function getAsistencia({ desde, hasta, q, area, user_id }) {
    if (!desde) desde = _todayIso().slice(0, 8) + '01';
    if (!hasta) hasta = _todayIso();

    const { scheds, userSched } = loadSchedules();
    const dept = userAreaMap();

    // Un registro por empleado (mismo CI puede vivir en varios equipos).
    const usuarios = db.prepare(
        'SELECT user_id, MAX(name) AS name FROM users GROUP BY user_id'
    ).all();

    // Marcas del periodo (+1 día por si un turno nocturno termina al día siguiente).
    const punches = db.prepare(
        'SELECT user_id, timestamp, punch, device_id FROM attendance WHERE timestamp >= ? AND timestamp <= ? ORDER BY user_id, timestamp'
    ).all(desde + ' 00:00:00', _addDays(hasta, 1) + ' 23:59:59');

    const porUsuario = Object.create(null);
    for (const p of punches) (porUsuario[p.user_id] = porUsuario[p.user_id] || []).push(p);

    const justif = loadJustifications(desde, hasta);
    const filtroQ = String(q || '').trim().toLowerCase();
    const filtroArea = String(area || '').trim();
    const sinArea = ['sin', '-', 'ninguno', 'null'].includes(filtroArea.toLowerCase());
    const hoy = _todayIso();

    // Días del periodo (no se evalúan días futuros).
    const dias = [];
    for (let d = desde; d <= hasta && d <= hoy; d = _addDays(d, 1)) dias.push(d);

    const registros = [];
    const resumen = [];

    for (const u of usuarios) {
        if (user_id && String(u.user_id) !== String(user_id)) continue;
        const sid = userSched[u.user_id];
        if (!sid) continue;
        const sched = scheds[sid];
        if (!sched) continue;

        const areaInfo = dept[u.user_id] || null;
        if (filtroArea) {
            if (sinArea) { if (areaInfo) continue; }
            else if (!areaInfo
                || (String(areaInfo.nombre).toLowerCase() !== filtroArea.toLowerCase()
                    && String(areaInfo.codigo).toLowerCase() !== filtroArea.toLowerCase())) continue;
        }
        const nombre = _cleanNameView(u.name);
        if (filtroQ && !(nombre.toLowerCase().includes(filtroQ)
            || String(u.user_id).toLowerCase().includes(filtroQ))) continue;

        const marcas = porUsuario[u.user_id] || [];
        const tol = (Number(sched.tolerance_min) || 1) * 60;

        const filas = [];
        let diasTrab = 0, faltas = 0, permisos = 0, atrasos = 0, tempranas = 0;
        let minAtr = 0, minSal = 0;

        for (const D of dias) {
            const day = sched.days[_isoWeekday(D)];
            if (!day || !day.start || !day.end) continue;
            diasTrab++;

            const startSec = _hhmmToSec(day.start);
            const endSec   = _hhmmToSec(day.end);
            const overnight = endSec <= startSec;

            // Marcas que pertenecen a este turno.
            let dm;
            if (!overnight) {
                dm = marcas.filter(p => String(p.timestamp).slice(0, 10) === D);
            } else {
                const D1 = _addDays(D, 1);
                dm = marcas.filter(p => {
                    const f = String(p.timestamp).slice(0, 10);
                    if (f === D) return _secOf(p.timestamp) >= startSec;
                    if (f === D1) return _secOf(p.timestamp) <= endSec;
                    return false;
                });
            }

            const _j = _pickJornada(dm);
            const entrada = _j.entrada;
            const salida  = _j.salida;

            const jFalta  = justif[u.user_id + '|' + D + '|falta'];
            const jAtraso = justif[u.user_id + '|' + D + '|atraso'];
            const jSalida = justif[u.user_id + '|' + D + '|salida_temprana'];

            let falta = false, permiso = false;
            let late = false, early = false, retrasoMin = 0, salidaMin = 0;

            if (!entrada) {
                falta   = !jFalta;
                permiso = !!jFalta;
            } else {
                const entSec = _secOf(entrada);
                if (entSec > startSec + tol - 1) {
                    late = true;
                    retrasoMin = Math.max(0, Math.floor((entSec - startSec) / 60));
                }
                if (salida) {
                    const salSec = _secOf(salida);
                    const finSec = overnight ? endSec + 86400 : endSec;
                    const salRel = overnight ? salSec + 86400 : salSec;
                    if (salRel < finSec - (tol - 1)) {
                        early = true;
                        salidaMin = Math.max(0, Math.floor((finSec - salRel) / 60));
                    }
                }
            }

            const atrasoFinal  = late && !jAtraso;
            const salidaFinal  = early && !jSalida;

            let estado;
            if (falta) estado = 'Falta';
            else if (permiso) estado = 'Permiso';
            else {
                const parts = [];
                if (atrasoFinal) parts.push('Atraso');
                if (salidaFinal) parts.push('Salida temprana');
                if (parts.length) estado = parts.join(' + ');
                else if ((late && jAtraso) || (early && jSalida)) estado = 'Con permiso';
                else estado = 'Presente';
            }

            if (falta) faltas++;
            if (permiso) permisos++;
            if (atrasoFinal) { atrasos++; minAtr += retrasoMin; }
            if (salidaFinal) { tempranas++; minSal += salidaMin; }

            const motivos = [];
            if (jFalta)  motivos.push({ tipo: 'falta', reason: jFalta });
            if (jAtraso) motivos.push({ tipo: 'atraso', reason: jAtraso });
            if (jSalida) motivos.push({ tipo: 'salida_temprana', reason: jSalida });

            filas.push({
                date: D,
                user_id: u.user_id,
                name: nombre,
                area: areaInfo ? areaInfo.nombre : '',
                area_codigo: areaInfo ? areaInfo.codigo : '',
                schedule_id: sid,
                schedule_name: sched.name,
                esperado_entrada: String(day.start).slice(0, 5),
                esperado_salida:  String(day.end).slice(0, 5),
                entrada,
                salida,
                estado,
                falta,
                permiso,
                tarde: atrasoFinal,
                salida_temprana: salidaFinal,
                retraso_min: atrasoFinal ? retrasoMin : 0,
                salida_min: salidaFinal ? salidaMin : 0,
                justificada_falta: !!jFalta,
                justificada_atraso: !!jAtraso,
                justificada_salida: !!jSalida,
                motivo: motivos.map(m => m.reason).join(' | '),
                motivos,
            });
        }

        if (!filas.length) continue;
        registros.push(...filas);
        resumen.push({
            user_id: u.user_id,
            name: nombre,
            area: areaInfo ? areaInfo.nombre : '',
            area_codigo: areaInfo ? areaInfo.codigo : '',
            schedule_id: sid,
            schedule_name: sched.name,
            dias: diasTrab,
            faltas,
            permisos,
            atrasos,
            salidas_tempranas: tempranas,
            total_atraso_min: minAtr,
            total_salida_min: minSal,
        });
    }

    resumen.sort((a, b) =>
        (b.faltas + b.atrasos + b.salidas_tempranas) - (a.faltas + a.atrasos + a.salidas_tempranas)
        || a.name.localeCompare(b.name, 'es'));
    registros.sort((a, b) =>
        a.date !== b.date ? (a.date < b.date ? -1 : 1)
        : String(a.name).localeCompare(String(b.name), 'es'));

    return { desde, hasta, resumen, registros };
}

// ----------------------------------------------------------------
//  Sincronizar UN dispositivo: conecta, descarga SOLO los registros
//  nuevos (incremental por dispositivo) y los guarda en SQLite.
//  El user_id del biométrico es el carnet (CI): se identifica por id.
//  Si forceFull=true: ignora last_records y descarga TODO (re-sync completa).
// ----------------------------------------------------------------
async function syncDevice(dev, forceFull = false) {
    const { id: deviceId, ip, port, password } = dev;
    const now = new Date().toISOString();

    let zk = null;
    let zkRetry = null;
    let inserted = 0;
    try {
        zk = new ZKDevice(ip, port, password, 30000);
        await zk.connect();

        const users = await zk.getUsers();

        const userMap = {};
        for (const u of users) {
            userMap[String(u.uid)] = u.name;
        }
        for (const u of users) {
            userMap[u.userId] = u.name;
        }

        if (deviceId) {
            const insU = db.prepare('INSERT OR REPLACE INTO users (device_id, uid, user_id, name, privilege, department, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
            for (const u of users) {
                insU.run(deviceId, u.uid, u.userId, _cleanNameView(u.name), u.privilege, u.department, now);
                _registrarArea(u.department);
            }
        }

        // Descarga SOLO los registros nuevos del dispositivo (desde el
        // ultimo indice ATTLOG sincronizado en last_records).
        const fetchNew = async (conn) => {
            const lastRec = forceFull ? 0 : (Number(dev.last_records) || 0);
            // Timestamp maximo local de ESTE dispositivo para verificar la
            // cola incremental (los nuevos registros no pueden ser menores).
            const maxRow = db.get(
                'SELECT MAX(timestamp) AS m FROM attendance WHERE device_id = ?',
                deviceId || null
            );
            const maxTs = maxRow && maxRow.m
                ? Date.parse(String(maxRow.m).replace(' ', 'T'))
                : 0;

            const result = await conn.getAttendanceSince({
                fromRecord: lastRec > 0 ? lastRec : 0,
                maxTs,
                userMap,
            });
            if (!result || !Array.isArray(result.records)) throw new Error('getAttendanceSince no devolvio registros');
            return result;
        };

        let records;
        let incremental = false;
        let deviceTotal = 0;
        try {
            const result = await fetchNew(zk);
            records = result.records;
            incremental = !!(result.incremental);
            deviceTotal = Number(result.total) || records.length;
            try { await zk.disconnect(); } catch (e) {}
            zk = null;
        } catch (err) {
            // Algunos K40 (firmware UDP) exigen una sesion fresca por stream.
            try { if (zk) await zk.disconnect(); } catch (e) {}
            zk = null;
            zkRetry = new ZKDevice(ip, port, password, 30000);
            await zkRetry.connect();
            try {
                const result = await fetchNew(zkRetry);
                records = result.records;
                incremental = !!(result.incremental);
                deviceTotal = Number(result.total) || records.length;
            } finally {
                try { await zkRetry.disconnect(); } catch (e) {}
                zkRetry = null;
            }
        }

        if (deviceId && records.length > 0) {
            // Transacción para asegurar atomicidad: o se guardan todos o ninguno
            const insA = db.prepare(
                'INSERT OR IGNORE INTO attendance (device_id, user_id, name, timestamp, status, punch, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
            );
            const insertMany = db.transaction((recs) => {
                let count = 0;
                for (const r of recs) {
                    const ts = r.timestamp instanceof Date
                        ? r.timestamp.toISOString()
                        : String(r.timestamp);
                    const info = insA.run(deviceId, r.userId, _cleanNameView(r.name || userMap[r.userId] || ''), ts, r.status, r.punch, now);
                    if (info.changes > 0) count++;
                }
                return count;
            });
            inserted = insertMany(records);

            // Verificación: contar cuántos quedaron realmente en la BD para este device/fecha
            const verifyCount = db.get(
                'SELECT COUNT(*) AS c FROM attendance WHERE device_id = ? AND date(synced_at) = date(?)',
                deviceId, now
            ).c;

            // Registrar el ultimo indice sincronizado SOLO si la inserción fue exitosa
            // Usamos deviceTotal (total en dispositivo) para avanzar el cursor,
            // pero si no se insertó nada, no avanzamos para reintentar en la próxima sync.
            if (inserted > 0 || records.length === 0) {
                db.run(
                    'UPDATE devices SET last_records = ?, last_sync_at = ? WHERE id = ?',
                    deviceTotal, now, deviceId
                );
            }
        }

        const conArea = users.filter(u => u.department).length;
        const areasSinNombre = db.prepare(
            'SELECT COUNT(*) AS n FROM areas WHERE name IS NULL OR name = ?'
        ).get(now).n;

        return {
            success: true,
            device: { id: deviceId, name: dev.name, ip, port },
            users: users.length,
            records: records.length,
            inserted,           // realmente insertados en esta corrida
            incremental,
            deviceRecords: deviceTotal,
            conArea,
            areasSinNombre,
            forceFull,
        };
    } finally {
        try { if (zkRetry) await zkRetry.disconnect(); } catch (e) {}
        try { if (zk) await zk.disconnect(); } catch (e) {}
    }
}

// ----------------------------------------------------------------
//  API: Conectar y sincronizar
//  - Con body.ip  : sincroniza ESE dispositivo (lo agenda si es nuevo).
//  - Sin body.ip  : sincroniza TODOS los dispositivos activos EN
//    PARALELO (Promise.all) para no multiplicar el tiempo de conexion.
//  Ambos biométricos controlan al mismo personal y alimentan el MISMO
//  reporte de asistencia; la descarga es incremental por dispositivo.
//  Opcion forceFull=true: ignora last_records y descarga TODO (re-sync completa).
// ----------------------------------------------------------------
app.post('/api/sync', async (req, res) => {
    const { ip, port, password, forceFull } = req.body || {};
    const now = new Date().toISOString();

    const deviceIp   = (ip && String(ip).trim());
    const devicePort = parseInt(port) || 4370;
    const devicePass = (password !== undefined && password !== null) ? password : 0;
    const force      = forceFull === true;

    try {
        // Sincronizar un dispositivo puntual (ya existente o nuevo).
        if (deviceIp) {
            let dev = db.get('SELECT * FROM devices WHERE ip = ?', deviceIp);
            if (!dev) {
                db.run(
                    'INSERT INTO devices (name, ip, port, password) VALUES (?, ?, ?, ?)',
                    ['Biométrico ' + deviceIp, deviceIp, devicePort, devicePass]
                );
                dev = db.get('SELECT * FROM devices WHERE ip = ?', deviceIp);
            }
            const result = await syncDevice(dev, force);
            db.save();
            res.json({
                success: true,
                message: result.incremental ? 'Sincronizacion incremental completada' : 'Sincronizacion completada',
                ...result,
                timestamp: now,
            });
            return;
        }

        // Sincronizar todos los dispositivos activos al mismo tiempo.
        const devices = db.all('SELECT * FROM devices WHERE active = 1 ORDER BY id');
        if (devices.length === 0) {
            return res.status(400).json({ success: false, error: 'No hay dispositivos activos configurados' });
        }

        const results = await Promise.all(devices.map(async (d) => {
            try {
                return await syncDevice(d, force);
            } catch (err) {
                return {
                    success: false,
                    device: { id: d.id, name: d.name, ip: d.ip, port: d.port },
                    error: err.message,
                };
            }
        }));
        db.save();

        const ok = results.filter(r => r.success);
        const totalUsers   = ok.reduce((a, r) => a + (Number(r.users) || 0), 0);
        const totalRecords = ok.reduce((a, r) => a + (Number(r.records) || 0), 0);

        res.json({
            success: ok.length > 0,
            message: `Sincronizacion completada: ${ok.length}/${results.length} dispositivos OK`,
            devices: results.length,
            results,
            users: totalUsers,
            records: totalRecords,
            timestamp: now,
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ----------------------------------------------------------------
//  API: Estado del dispositivo
// ----------------------------------------------------------------
app.get('/api/device/status', async (req, res) => {
    const cfg = deviceConfig();
    const ip   = (req.query.ip && String(req.query.ip).trim()) || cfg.ip;
    const port = parseInt(req.query.port) || cfg.port;
    const pass = (req.query.password !== undefined && req.query.password !== null) ? parseInt(req.query.password) || 0 : cfg.password;

    const zk = new ZKDevice(ip, port, pass, 10000);
    try {
        await zk.connect();
        const sizes = await zk.readSizes();
        await zk.disconnect();
        res.json({ connected: true, ...sizes });
    } catch (err) {
        res.json({ connected: false, error: err.message });
    }
});

// ----------------------------------------------------------------
//  API: Configuracion del dispositivo a sincronizar
// ----------------------------------------------------------------
app.get('/api/device/config', (req, res) => {
    res.json(deviceConfig());
});

app.post('/api/device/config', (req, res) => {
    const { ip, port, password } = req.body || {};
    if (!ip || !String(ip).trim()) return res.status(400).json({ error: 'ip requerido' });
    setDeviceConfig(ip, port, password);
    res.json(deviceConfig());
});

// ----------------------------------------------------------------
//  API: Usuarios (desde SQLite local) con su area asignada
// ----------------------------------------------------------------
app.get('/api/users', (req, res) => {
    // El mismo carnet (user_id) puede vivir en varios biométricos: se
    // entrega UN solo registro por empleado (se toma el más reciente).
    const rows = db.prepare(
        'SELECT user_id, name, MAX(synced_at) AS synced_at FROM users GROUP BY user_id ORDER BY name COLLATE NOCASE'
    ).all();

    const nombres = areaNameMap();
    const asignaciones = Object.create(null);
    for (const r of db.all('SELECT user_id, area_code FROM user_areas')) {
        asignaciones[r.user_id] = r.area_code;
    }

    // Horario asignado (uno por empleado).
    const schedNames = Object.create(null);
    for (const s of db.all('SELECT id, name FROM schedules')) schedNames[s.id] = s.name;
    const schedAsign = Object.create(null);
    for (const r of db.all('SELECT user_id, schedule_id FROM user_schedules WHERE schedule_id IS NOT NULL')) {
        schedAsign[r.user_id] = r.schedule_id;
    }

    let out = rows.map(r => {
        const code = asignaciones[r.user_id] || '';
        const sid = schedAsign[r.user_id] || null;
        return {
            user_id: r.user_id,
            name: _cleanNameView(r.name),
            synced_at: r.synced_at,
            area_codigo: code,
            area: code ? (nombres[code] || code) : '',
            schedule_id: sid,
            schedule: sid ? (schedNames[sid] || '') : '',
        };
    });

    const dep = String((req.query && req.query.area) || '').trim();
    if (dep) {
        const sinArea = ['sin', '-', 'ninguno', 'null'].includes(dep.toLowerCase());
        out = out.filter(u => sinArea ? !u.area : u.area === dep || u.area_codigo === dep);
    }
    res.json(out);
});

// ----------------------------------------------------------------
//  API: Agregar / subir un usuario al biométrico (K40 Pro)
//
//  Solo se sube lo esencial: CI (código), primer apellido y primer
//  nombre. En el equipo el nombre se guarda como "APELLIDO NOMBRE".
//  El área NO se envía: se asigna después desde la pestaña Áreas
//  (relación local user_areas).
//
//  Si el equipo no acepta el alta, se realiza una sincronización y se
//  informa (pedido: "si no se puede subir, que sincronice").
// ----------------------------------------------------------------
app.post('/api/users/zkteco/add', async (req, res) => {
    const { user_id, apellido, nombre } = req.body || {};
    const userId = String(user_id || '').trim().toUpperCase();
    const ape = String(apellido || '').trim().toUpperCase();
    const nom = String(nombre || '').trim().toUpperCase();

    if (!userId) return res.status(400).json({ success: false, error: 'El CI (código) es obligatorio' });
    if (!ape)    return res.status(400).json({ success: false, error: 'El primer apellido es obligatorio' });
    if (!nom)    return res.status(400).json({ success: false, error: 'El primer nombre es obligatorio' });

    // En el equipo el nombre se guarda como "APELLIDO NOMBRE".
    const nombreEquipo = _cleanNameView(`${ape} ${nom}`);
    const now = new Date().toISOString();

    // 1) Guardar en la BD local: así el usuario aparece de una vez y se le
    //    puede asignar el área desde la pestaña Áreas.
    const dev = db.get('SELECT * FROM devices ORDER BY id LIMIT 1') || {};
    const deviceId = dev.id || 1;
    try {
        db.run(
            'INSERT OR REPLACE INTO users (device_id, uid, user_id, name, privilege, department, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            deviceId, 0, userId, nombreEquipo, 0, null, now
        );
        db.save();
    } catch (e) {}

    // 2) Intentar subirlo al equipo.
    const cfg = deviceConfig();
    const zk = new ZKDevice(
        dev.ip || cfg.ip,
        dev.port || cfg.port,
        (dev.password !== undefined && dev.password !== null) ? dev.password : cfg.password,
        5000
    );
    let subido = false;
    let errorSubida = null;
    try {
        await zk.connect();
        await zk.addUser({ userId, name: nombreEquipo });
        subido = true;
        // Verificación best-effort: confirmar que el equipo ya lo lista.
        try {
            const lista = await zk.getUsers();
            if (!lista.some(u => String(u.userId) === userId)) {
                subido = false;
                errorSubida = 'El equipo respondió pero no registró al usuario';
            }
        } catch (e) { /* si no se puede verificar, se confía en el ACK */ }
        try { await zk.disconnect(); } catch (e) {}
    } catch (err) {
        try { await zk.disconnect(); } catch (e) {}
        errorSubida = err.message;
    }

    // 3) Subida correcta.
    if (subido) {
        return res.json({
            success: true,
            uploaded: true,
            user_id: userId,
            nombre: nombreEquipo,
            message: `Usuario "${nombreEquipo}" subido al biométrico`,
        });
    }

    // 4) No se pudo subir: se sincroniza el equipo (fallback pedido).
    try {
        const result = await syncDevice(dev.id
            ? dev
            : { id: deviceId, name: 'Biométrico', ip: cfg.ip, port: cfg.port, password: cfg.password, last_records: 0 });
        db.save();
        return res.json({
            success: true,
            uploaded: false,
            synced: true,
            user_id: userId,
            nombre: nombreEquipo,
            detail: errorSubida,
            message: `No se pudo subir al biométrico (${errorSubida || 'sin respuesta'}). Se sincronizó el equipo.`,
            sync: { users: result.users, records: result.records },
        });
    } catch (e2) {
        return res.json({
            success: true,
            uploaded: false,
            synced: false,
            user_id: userId,
            nombre: nombreEquipo,
            warning: `No se pudo subir ni sincronizar: ${errorSubida || ''} / ${e2.message}`,
            message: 'Usuario guardado localmente',
        });
    }
});

// ----------------------------------------------------------------
//  API: Asignar / quitar el area de UN usuario (relacion local)
//  Una sola area por usuario: se guarda en user_areas y persiste.
// ----------------------------------------------------------------
app.put('/api/users/:user_id/area', (req, res) => {
    const userId = String(req.params.user_id || '').trim();
    const { area } = req.body || {};
    const code = String(area || '').trim();
    if (!userId) return res.status(400).json({ success: false, error: 'user_id requerido' });

    try {
        if (code === '') {
            db.run('DELETE FROM user_areas WHERE user_id = ?', userId);
        } else {
            _registrarArea(code);
            db.run(
                `INSERT INTO user_areas (user_id, area_code, updated_at) VALUES (?, ?, ?)
                 ON CONFLICT(user_id) DO UPDATE SET area_code = excluded.area_code, updated_at = excluded.updated_at`,
                userId, code, new Date().toISOString()
            );
        }
        db.save();
        res.json({ success: true, user_id: userId, area: code || null });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ----------------------------------------------------------------
//  API: Asignar / quitar el area de VARIOS usuarios (bulk)
// ----------------------------------------------------------------
app.post('/api/users/areas/bulk', (req, res) => {
    const { user_ids, area } = req.body || {};
    const code = String(area || '').trim();

    if (!Array.isArray(user_ids) || user_ids.length === 0) {
        return res.status(400).json({ success: false, error: 'user_ids requerido (array)' });
    }

    try {
        const del = db.prepare('DELETE FROM user_areas WHERE user_id = ?');
        const upsert = db.prepare(
            `INSERT INTO user_areas (user_id, area_code, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET area_code = excluded.area_code, updated_at = excluded.updated_at`
        );
        const now = new Date().toISOString();
        if (code !== '') _registrarArea(code);
        const tx = db.transaction((ids) => {
            let changes = 0;
            for (const uid of ids) {
                if (code === '') changes += del.run(String(uid)).changes;
                else changes += upsert.run(String(uid), code, now).changes;
            }
            return changes;
        });
        const changes = tx(user_ids);
        db.save();
        res.json({ success: true, area: code || null, changes });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ----------------------------------------------------------------
//  API: Areas
//  GET    : codigos leidos del biometrico + nombre asignado + usuarios
//  POST   : crea el area o cambia su nombre
//  DELETE : elimina el area y deja sin area a sus usuarios
// ----------------------------------------------------------------
app.get('/api/areas', (req, res) => {
    const conteo = Object.create(null);
    for (const r of db.all('SELECT area_code, COUNT(*) AS n FROM user_areas WHERE area_code IS NOT NULL GROUP BY area_code')) {
        conteo[r.area_code] = r.n;
    }
    const filas = db.all('SELECT code, name, updated_at FROM areas ORDER BY code COLLATE NOCASE');

    // Incluye tambien los codigos que aun no estan en la tabla (por si la
    // migracion se hizo despues de la primera sync).
    for (const code of Object.keys(conteo)) {
        if (!filas.some(f => f.code === code)) {
            filas.push({ code, name: null, updated_at: null });
        }
    }

    res.json(filas.map(f => ({
        codigo: f.code,
        nombre: f.name || f.code,
        asignado: !!f.name,
        empleados: conteo[f.code] || 0,
    })));
});

app.post('/api/areas', (req, res) => {
    const { code, name } = req.body || {};
    const c = String(code || '').trim();
    const n = String(name || '').trim();
    if (!c) return res.status(400).json({ success: false, error: 'code requerido' });
    db.run(
        'INSERT INTO areas (code, name, updated_at) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at',
        c, n || null, new Date().toISOString()
    );
    db.save();
    res.json({ success: true, codigo: c, nombre: n || c });
});

app.delete('/api/areas/:code', (req, res) => {
    const code = String(req.params.code || '').trim();
    if (!code) return res.status(400).json({ success: false, error: 'code invalido' });
    // Los usuarios del area quedan sin area (la relación se elimina).
    db.run('DELETE FROM user_areas WHERE area_code = ?', code);
    const info = db.run('DELETE FROM areas WHERE code = ?', code);
    db.save();
    res.json({ success: true, changes: info.changes });
});

// ----------------------------------------------------------------
//  API: Horarios
//  GET    : lista de horarios con sus dias y cantidad de empleados
//  POST   : crea (sin id) o actualiza (con id) un horario y sus dias
//  DELETE : elimina el horario y desasigna a sus empleados
//  PUT    : /api/users/:user_id/schedule  -> asignar un horario a un empleado
// ----------------------------------------------------------------
app.get('/api/schedules', (req, res) => {
    const conteo = Object.create(null);
    for (const r of db.all('SELECT schedule_id, COUNT(*) AS n FROM user_schedules WHERE schedule_id IS NOT NULL GROUP BY schedule_id')) {
        conteo[r.schedule_id] = r.n;
    }
    const scheds = db.all('SELECT id, name, tolerance_min FROM schedules ORDER BY name COLLATE NOCASE');
    const days = db.all('SELECT schedule_id, weekday, start_time, end_time FROM schedule_days ORDER BY weekday');

    res.json(scheds.map(s => ({
        id: s.id,
        name: s.name,
        tolerance_min: s.tolerance_min || 1,
        empleados: conteo[s.id] || 0,
        days: days.filter(d => d.schedule_id === s.id).map(d => ({
            weekday: d.weekday,
            start: d.start_time,
            end: d.end_time,
        })),
    })));
});

app.post('/api/schedules', (req, res) => {
    const { id, name, days } = req.body || {};
    const nombre = String(name || '').trim();
    if (!nombre) return res.status(400).json({ success: false, error: 'El nombre del horario es obligatorio' });

    const lista = (Array.isArray(days) ? days : [])
        .map(d => ({
            weekday: Number(d.weekday),
            start: String(d.start || '').slice(0, 5),
            end: String(d.end || '').slice(0, 5),
        }))
        .filter(d => d.weekday >= 1 && d.weekday <= 7 && d.start && d.end);

    try {
        const now = new Date().toISOString();
        const upsert = db.prepare(
            `INSERT INTO schedules (name, tolerance_min, updated_at) VALUES (?, 1, ?)`
        );
        const tx = db.transaction(() => {
            let sid = id ? Number(id) : 0;
            if (sid) {
                db.run('UPDATE schedules SET name = ?, updated_at = ? WHERE id = ?', nombre, now, sid);
            } else {
                sid = upsert.run(nombre, now).lastInsertRowid;
            }
            db.run('DELETE FROM schedule_days WHERE schedule_id = ?', sid);
            const insD = db.prepare('INSERT INTO schedule_days (schedule_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)');
            for (const d of lista) insD.run(sid, d.weekday, d.start, d.end);
            return sid;
        });
        const sid = tx();
        db.save();
        res.json({ success: true, id: sid });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/api/schedules/:id', (req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'id invalido' });
    db.run('DELETE FROM user_schedules WHERE schedule_id = ?', id);
    db.run('DELETE FROM schedule_days WHERE schedule_id = ?', id);
    const info = db.run('DELETE FROM schedules WHERE id = ?', id);
    db.save();
    res.json({ success: true, changes: info.changes });
});

app.put('/api/users/:user_id/schedule', (req, res) => {
    const userId = String(req.params.user_id || '').trim();
    if (!userId) return res.status(400).json({ success: false, error: 'user_id requerido' });
    const { schedule_id } = req.body || {};
    try {
        const sid = (schedule_id === '' || schedule_id === null || schedule_id === undefined) ? null : Number(schedule_id);
        if (!sid) {
            db.run('DELETE FROM user_schedules WHERE user_id = ?', userId);
        } else {
            db.run(
                `INSERT INTO user_schedules (user_id, schedule_id, updated_at) VALUES (?, ?, ?)
                 ON CONFLICT(user_id) DO UPDATE SET schedule_id = excluded.schedule_id, updated_at = excluded.updated_at`,
                userId, sid, new Date().toISOString()
            );
        }
        db.save();
        res.json({ success: true, user_id: userId, schedule_id: sid });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ----------------------------------------------------------------
//  API: Asistencia (con filtros de fecha)
// ----------------------------------------------------------------
app.get('/api/attendance', (req, res) => {
    let { desde, hasta, user_id, device_id, q, page, limit } = req.query;

    page  = parseInt(page) || 1;
    limit = Math.min(parseInt(limit) || 500, 2000);
    const offset = (page - 1) * limit;

    let where = '1=1';
    const params = [];

    if (desde) { where += ' AND timestamp >= ?'; params.push(desde + ' 00:00:00'); }
    if (hasta) { where += ' AND timestamp <= ?'; params.push(hasta + ' 23:59:59'); }
    if (q && q.trim()) {
        where += ' AND (name LIKE ? COLLATE NOCASE OR user_id LIKE ?)';
        params.push('%' + q.trim() + '%', '%' + q.trim() + '%');
    }
    if (user_id) { where += ' AND user_id = ?'; params.push(user_id); }
    if (device_id) { where += ' AND device_id = ?'; params.push(device_id); }

    const total = db.prepare(`SELECT COUNT(*) as n FROM attendance WHERE ${where}`).get(...params).n;
    const rows = db.prepare(
        `SELECT * FROM attendance WHERE ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset).map(r => ({ ...r, name: _cleanNameView(r.name) }));

    res.json({ total, page, limit, records: rows });
});

// ----------------------------------------------------------------
//  API: Empleados con conteo de marcas (para el detalle por nombre)
// ----------------------------------------------------------------
app.get('/api/attendance/users', (req, res) => {
    let { desde, hasta, q } = req.query;
    if (!desde) desde = '2000-01-01';
    if (!hasta) hasta = '2099-12-31';

    let where = '1=1';
    const params = [];
    if (q && q.trim()) {
        where += ' AND (name LIKE ? COLLATE NOCASE OR user_id LIKE ?)';
        params.push('%' + q.trim() + '%', '%' + q.trim() + '%');
    }

    const users = db.prepare(
        `SELECT user_id, name, MAX(synced_at) AS synced_at FROM users WHERE ${where} GROUP BY user_id ORDER BY name COLLATE NOCASE`
    ).all(...params);

    const counts = db.prepare(`
        SELECT user_id, COUNT(*) as n
        FROM attendance
        WHERE DATE(timestamp) BETWEEN ? AND ?
        GROUP BY user_id
    `).all(desde, hasta);

    const cmap = Object.create(null);
    for (const c of counts) cmap[c.user_id] = c.n;

    const nombres = areaNameMap();
    const asignaciones = Object.create(null);
    for (const r of db.all('SELECT user_id, area_code FROM user_areas')) {
        asignaciones[r.user_id] = r.area_code;
    }

    res.json(users.map(u => {
        const code = asignaciones[u.user_id] || '';
        return {
            user_id: u.user_id,
            name: _cleanNameView(u.name),
            marcaciones: cmap[u.user_id] || 0,
            area_codigo: code,
            area: code ? (nombres[code] || code) : '',
        };
    }));
});

// ----------------------------------------------------------------
//  API: Resumen diario por usuario
// ----------------------------------------------------------------
app.get('/api/summary', (req, res) => {
    let { desde, hasta, user_id, q, users, orden, area } = req.query;
    if (!desde) desde = new Date().toISOString().slice(0, 10);
    if (!hasta) hasta = desde;

    res.json({ desde, hasta, records: getJornadas({ desde, hasta, user_id, q, users, orden, area }) });
});

// ----------------------------------------------------------------
//  API: Atrasos
//  GET /api/retrasos          -> resumen por persona (solo con atrasos)
//  GET /api/retrasos/detalle  -> dias con atraso de UN empleado
// ----------------------------------------------------------------
app.get('/api/retrasos', (req, res) => {
    let { desde, hasta, q, area } = req.query;
    if (!desde) desde = '2000-01-01';
    if (!hasta) hasta = '2099-12-31';
    const { resumen } = getRetrasos({ desde, hasta, q, area });
    res.json({ desde, hasta, resumen });
});

app.get('/api/retrasos/detalle', (req, res) => {
    let { desde, hasta, q, area, user_id } = req.query;
    if (!desde) desde = '2000-01-01';
    if (!hasta) hasta = '2099-12-31';
    const { detalle } = getRetrasos({ desde, hasta, q, area, user_id });
    res.json({ user_id: user_id || null, records: detalle });
});

// ----------------------------------------------------------------
//  API: Asistencia (evaluación por horario)
//  GET /api/asistencia  -> { resumen, registros }
// ----------------------------------------------------------------
app.get('/api/asistencia', (req, res) => {
    let { desde, hasta, q, area, user_id } = req.query;
    if (!desde) desde = _todayIso().slice(0, 8) + '01';
    if (!hasta) hasta = _todayIso();
    res.json(getAsistencia({ desde, hasta, q, area, user_id }));
});

// ----------------------------------------------------------------
//  API: Justificaciones
//  POST   : crea/actualiza la justificación (falta / atraso / salida temprana)
//  DELETE : elimina la justificación de una incidencia
// ----------------------------------------------------------------
const TIPOS_JUST = ['falta', 'atraso', 'salida_temprana'];

app.post('/api/justificaciones', (req, res) => {
    const { user_id, date, tipo, reason } = req.body || {};
    const uid = String(user_id || '').trim();
    const d   = String(date || '').trim().slice(0, 10);
    const t   = String(tipo || '').trim();
    const r   = String(reason || '').trim();

    if (!uid || !d || !t) return res.status(400).json({ success: false, error: 'user_id, date y tipo son obligatorios' });
    if (!TIPOS_JUST.includes(t)) return res.status(400).json({ success: false, error: 'tipo inválido' });
    if (!r) return res.status(400).json({ success: false, error: 'Describe el motivo de la justificación' });

    try {
        db.run(
            `INSERT INTO justifications (user_id, date, tipo, reason, created_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(user_id, date, tipo) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at`,
            uid, d, t, r, new Date().toISOString()
        );
        db.save();
        res.json({ success: true, user_id: uid, date: d, tipo: t, reason: r });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/api/justificaciones', (req, res) => {
    const uid = String(req.query.user_id || '').trim();
    const d   = String(req.query.date || '').trim().slice(0, 10);
    const t   = String(req.query.tipo || '').trim();
    if (!uid || !d || !t) return res.status(400).json({ success: false, error: 'user_id, date y tipo son obligatorios' });
    try {
        const info = db.run('DELETE FROM justifications WHERE user_id = ? AND date = ? AND tipo = ?', uid, d, t);
        db.save();
        res.json({ success: true, changes: info.changes });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/justificaciones', (req, res) => {
    let { desde, hasta, user_id } = req.query;
    let where = '1=1';
    const params = [];
    if (desde) { where += ' AND date >= ?'; params.push(String(desde).slice(0, 10)); }
    if (hasta) { where += ' AND date <= ?'; params.push(String(hasta).slice(0, 10)); }
    if (user_id) { where += ' AND user_id = ?'; params.push(String(user_id)); }
    res.json(db.prepare(`SELECT user_id, date, tipo, reason, created_at FROM justifications WHERE ${where} ORDER BY date, user_id`).all(...params));
});

// ----------------------------------------------------------------
//  API: Marcación manual (crea o actualiza entrada/salida)
// ----------------------------------------------------------------
app.post('/api/attendance/manual', (req, res) => {
    const { user_id, date, entrada, salida } = req.body || {};
    const uid = String(user_id || '').trim();
    const d   = String(date || '').trim().slice(0, 10);
    const ent = entrada ? String(entrada).trim() : null;
    const sal = salida ? String(salida).trim() : null;

    if (!uid || !d) return res.status(400).json({ success: false, error: 'user_id y date son obligatorios' });
    if (!ent && !sal) return res.status(400).json({ success: false, error: 'Debe especificar al menos entrada o salida' });

    // Validar formato HH:MM
    const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (ent && !timeRe.test(ent)) return res.status(400).json({ success: false, error: 'Formato de entrada inválido (HH:MM)' });
    if (sal && !timeRe.test(sal)) return res.status(400).json({ success: false, error: 'Formato de salida inválido (HH:MM)' });

    try {
        const urow = db.prepare('SELECT MAX(name) AS name FROM users WHERE user_id = ?').get(uid);
        const nombre = urow && urow.name ? urow.name : '';

        const existing = db.prepare(
            'SELECT id, punch, timestamp FROM attendance WHERE user_id = ? AND date(timestamp) = ? AND device_id = 0 ORDER BY timestamp'
        ).all(uid, d);

        const nowIso = new Date().toISOString();
        // Las marcas manuales imitan a las del biométrico: status = 1 (verificación).
        const insertar = (punch, ts) => db.run(
            'INSERT INTO attendance (device_id, user_id, name, timestamp, status, punch, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            0, uid, nombre, ts, 1, punch, nowIso
        );
        const actualizar = (id, ts) => db.run(
            'UPDATE attendance SET timestamp = ?, status = 1, name = ? WHERE id = ?', ts, nombre, id
        );

        if (ent) {
            const e = existing.find(x => Number(x.punch) !== 1);
            if (e) actualizar(e.id, `${d} ${ent}:00`); else insertar(0, `${d} ${ent}:00`);
        }
        if (sal) {
            const s = existing.find(x => Number(x.punch) === 1);
            if (s) actualizar(s.id, `${d} ${sal}:00`); else insertar(1, `${d} ${sal}:00`);
        }

        db.save();
        res.json({ success: true, user_id: uid, date: d, entrada: ent, salida: sal });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ----------------------------------------------------------------
//  API: Dispositivos configurados
// ----------------------------------------------------------------
app.get('/api/devices', (req, res) => {
    const rows = db.prepare('SELECT * FROM devices').all();
    res.json(rows);
});

app.post('/api/devices', (req, res) => {
    const { name, ip, port, password } = req.body;
    if (!name || !ip) return res.status(400).json({ error: 'name e ip son requeridos' });
    const r = db.prepare('INSERT INTO devices (name, ip, port, password) VALUES (?, ?, ?, ?)')
              .run(name, ip, port || 4370, password || 0);
    db.save();
    res.json({ id: r.lastInsertRowid });
});

// Eliminar un dispositivo junto con sus usuarios y marcaciones.
app.delete('/api/devices/:id', (req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'id invalido' });
    db.run('DELETE FROM attendance WHERE device_id = ?', id);
    db.run('DELETE FROM users WHERE device_id = ?', id);
    // Limpieza: al borrar los usuarios de un equipo tambien se van sus
    // relaciones locales (area, horario, justificaciones). Sin esto quedan
    // registros huerfanos que inflan los conteos.
    db.run('DELETE FROM user_areas     WHERE user_id NOT IN (SELECT user_id FROM users)');
    db.run('DELETE FROM user_schedules WHERE user_id NOT IN (SELECT user_id FROM users)');
    db.run('DELETE FROM justifications WHERE user_id NOT IN (SELECT user_id FROM users)');
    const info = db.run('DELETE FROM devices WHERE id = ?', id);
    db.save();
    res.json({ success: true, changes: info.changes });
});

// Activar / desactivar un dispositivo (los inactivos no se sincronizan).
app.post('/api/devices/:id/toggle', (req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'id invalido' });
    const d = db.get('SELECT * FROM devices WHERE id = ?', id);
    if (!d) return res.status(404).json({ error: 'no existe' });
    db.run('UPDATE devices SET active = ? WHERE id = ?', d.active ? 0 : 1, id);
    db.save();
    res.json({ success: true, active: d.active ? 0 : 1 });
});

// Actualizar configuracion de un dispositivo (nombre, ip, puerto, clave).
app.post('/api/devices/:id/config', (req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'id invalido' });
    const d = db.get('SELECT * FROM devices WHERE id = ?', id);
    if (!d) return res.status(404).json({ error: 'no existe' });
    const { name, ip, port, password } = req.body || {};
    db.run(
        'UPDATE devices SET name = ?, ip = ?, port = ?, password = ? WHERE id = ?',
        (name !== undefined && String(name).trim()) ? String(name).trim() : d.name,
        (ip && String(ip).trim()) ? String(ip).trim() : d.ip,
        (port !== undefined && port !== null) ? (parseInt(port) || d.port) : d.port,
        (password !== undefined && password !== null) ? password : d.password,
        id
    );
    db.save();
    res.json({ success: true, device: db.get('SELECT * FROM devices WHERE id = ?', id) });
});

// ----------------------------------------------------------------
//  API: Exportar CSV
// ----------------------------------------------------------------
app.get('/api/export/csv', (req, res) => {
    let { desde, hasta, q, users, area, orden } = req.query;
    if (!desde) desde = '2000-01-01';
    if (!hasta) hasta = '2099-12-31';

    const detallado = !!(q && q.trim()) || !!(users && String(users).trim());
    const rows = getJornadas({ desde, hasta, q, users, area, orden });
    const fmtDate  = d => d ? d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4) : '';
    const q2 = s => '"' + String(s || '').replace(/"/g, '""') + '"';

    const cols = ['CI', 'Nombre', 'Área', 'Entrada', 'Salida', 'Estado'];
    if (detallado) cols.push('Marcaciones');

    const linea = (r) => {
        const c = [r.user_id, q2(r.name), q2(r.area)];
        c.push((r.entrada || '').slice(11, 19), (r.salida || '').slice(11, 19));
        c.push(q2(r.estado || ''));
        if (detallado) c.push(r.marcaciones);
        return c.join(',');
    };

    let csv = '\uFEFF' + cols.join(',');
    let fecha = null;
    for (const r of rows) {
        if (r.date !== fecha) {
            fecha = r.date;
            csv += '\n' + fmtDate(fecha);
        }
        csv += '\n' + linea(r);
    }

    const filename = `asistencia_${desde}_${hasta}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
});

// ----------------------------------------------------------------
//  API: Exportar Excel
// ----------------------------------------------------------------
app.get('/api/export/excel', async (req, res) => {
    let { desde, hasta, q, users, area, orden } = req.query;
    if (!desde) desde = '2000-01-01';
    if (!hasta) hasta = '2099-12-31';

    const detallado = !!(q && q.trim()) || !!(users && String(users).trim());
    const fmtDate = d => d ? d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4) : '';
    const rows = getJornadas({ desde, hasta, q, users, area, orden });

    const cols = [
        { header: 'CI', key: 'user_id', width: 14 },
        { header: 'Nombre', key: 'name', width: 30 },
        { header: 'Área', key: 'area', width: 22 },
        { header: 'Entrada', key: 'entrada', width: 12 },
        { header: 'Salida', key: 'salida', width: 12 },
        { header: 'Estado', key: 'estado', width: 18 },
    ];
    if (detallado) cols.push({ header: 'Marcaciones', key: 'marcaciones', width: 12 });
    const ncols = cols.length;

    const mapped = rows.map(r => ({
        date: fmtDate(r.date),
        user_id: r.user_id,
        name: r.name,
        area: r.area || '',
        entrada: (r.entrada || '').slice(11, 19),
        salida: (r.salida || '').slice(11, 19),
        estado: r.estado || '',
        marcaciones: r.marcaciones,
    }));

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Asistencia');
    ws.columns = cols;

    const estiloHeader = row => {
        row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    };
    const estiloFecha = row => {
        row.font = { bold: true, color: { argb: 'FF1E3A8A' } };
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2FF' } };
    };

    estiloHeader(ws.getRow(1));
    let fecha = null;
    for (const r of mapped) {
        if (r.date !== fecha) {
            fecha = r.date;
            ws.addRow([fecha, ...Array(ncols - 1).fill('')]);
            ws.mergeCells(ws.rowCount, 1, ws.rowCount, ncols);
            estiloFecha(ws.getRow(ws.rowCount));
        }
        ws.addRow(cols.map(c => r[c.key]));
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="asistencia_${desde}_${hasta}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
});

// ----------------------------------------------------------------
//  API: Exportar PDF
// ----------------------------------------------------------------
app.get('/api/export/pdf', (req, res) => {
    let { desde, hasta, q, users, area, orden } = req.query;
    if (!desde) desde = '2000-01-01';
    if (!hasta) hasta = '2099-12-31';

    const detallado = !!(q && q.trim()) || !!(users && String(users).trim());
    const fmtDate = d => d ? d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4) : '';

    const rows = getJornadas({ desde, hasta, q, users, area, orden });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="asistencia_${desde}_${hasta}.pdf"`);

    const headers = ['CI', 'Nombre', 'Área', 'Entrada', 'Salida', 'Estado'];
    const widths  = [80, 210, 130, 150, 150, 130];
    if (detallado) { headers.push('Marc.'); widths.push(60); }

    const items = [];
    let prevFecha = null;
    for (const r of rows) {
        if (r.date !== prevFecha) {
            prevFecha = r.date;
            items.push({ type: 'date', text: fmtDate(r.date) });
        }
        const cells = [r.user_id, r.name || '', r.area || '-'];
        cells.push((r.entrada || '').slice(11, 19), (r.salida || '').slice(11, 19));
        cells.push(r.estado || '');
        if (detallado) cells.push(String(r.marcaciones));
        items.push({ type: 'row', cells });
    }

    res.end(PDFDocument({
        title: 'Reporte de Entrada y Salida',
        subtitle: `Periodo: ${desde} al ${hasta}  |  Registros: ${rows.length}`,
        headers, widths, items,
    }));
});

// ----------------------------------------------------------------
//  API: Exportar a Excel los atrasos
//  - /api/export/retrasos/excel          -> resumen por persona
//  - /api/export/retrasos-detalle/excel  -> dias de UN empleado
// ----------------------------------------------------------------
const _estiloCabeceraAtrasos = (row) => {
    row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFB91C1C' } };
};

app.get('/api/export/retrasos/excel', async (req, res) => {
    let { desde, hasta, q, area } = req.query;
    if (!desde) desde = '2000-01-01';
    if (!hasta) hasta = '2099-12-31';

    const { resumen } = getRetrasos({ desde, hasta, q, area });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Atrasos');
    ws.columns = [
        { header: 'CI',          key: 'user_id',  width: 16 },
        { header: 'Nombre',      key: 'name',     width: 32 },
        { header: 'Área',        key: 'area',     width: 22 },
        { header: 'Atrasos',     key: 'retrasos', width: 12 },
        { header: 'Total (min)', key: 'total_min',width: 14 },
    ];
    _estiloCabeceraAtrasos(ws.getRow(1));
    for (const r of resumen) {
        ws.addRow({ user_id: r.user_id, name: r.name, area: r.area || '', retrasos: r.retrasos, total_min: r.total_min });
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="atrasos_${desde}_${hasta}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
});

app.get('/api/export/retrasos-detalle/excel', async (req, res) => {
    let { desde, hasta, q, area, user_id } = req.query;
    if (!desde) desde = '2000-01-01';
    if (!hasta) hasta = '2099-12-31';

    const { detalle } = getRetrasos({ desde, hasta, q, area, user_id });
    const fmtDate = d => d ? d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4) : '';

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Detalle atrasos');
    ws.columns = [
        { header: 'CI',            key: 'user_id',  width: 16 },
        { header: 'Nombre',        key: 'name',     width: 32 },
        { header: 'Área',          key: 'area',     width: 22 },
        { header: 'Fecha',         key: 'fecha',    width: 14 },
        { header: 'Hora esperada', key: 'esperado', width: 16 },
        { header: 'Entrada',       key: 'entrada',  width: 14 },
        { header: 'Retraso (min)', key: 'retraso',  width: 14 },
    ];
    _estiloCabeceraAtrasos(ws.getRow(1));
    for (const r of detalle) {
        ws.addRow({
            user_id: r.user_id,
            name: r.name,
            area: r.area || '',
            fecha: fmtDate(r.date),
            esperado: r.hora_esperada,
            entrada: (r.entrada || '').slice(11, 19),
            retraso: r.retraso_min,
        });
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="atrasos_detalle_${desde}_${hasta}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
});

// ----------------------------------------------------------------
//  API: Exportar a Excel la asistencia (resumen + detalle por día)
// ----------------------------------------------------------------
app.get('/api/export/asistencia/excel', async (req, res) => {
    let { desde, hasta, q, area, user_id } = req.query;
    if (!desde) desde = _todayIso().slice(0, 8) + '01';
    if (!hasta) hasta = _todayIso();

    const { resumen, registros } = getAsistencia({ desde, hasta, q, area, user_id });
    const fmtDate = d => d ? d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4) : '';

    const wb = new ExcelJS.Workbook();

    const ws = wb.addWorksheet('Resumen');
    ws.columns = [
        { header: 'CI',              key: 'user_id',  width: 16 },
        { header: 'Nombre',          key: 'name',     width: 32 },
        { header: 'Área',            key: 'area',     width: 22 },
        { header: 'Horario',         key: 'schedule_name', width: 20 },
        { header: 'Días',            key: 'dias',     width: 10 },
        { header: 'Faltas',          key: 'faltas',   width: 10 },
        { header: 'Permisos',        key: 'permisos', width: 11 },
        { header: 'Atrasos',         key: 'atrasos',  width: 10 },
        { header: 'Sal. temprana',   key: 'st',       width: 13 },
        { header: 'Total atraso (min)', key: 'min',   width: 18 },
    ];
    _estiloCabeceraAtrasos(ws.getRow(1));
    for (const r of resumen) {
        ws.addRow({
            user_id: r.user_id, name: r.name, area: r.area || '', schedule_name: r.schedule_name,
            dias: r.dias, faltas: r.faltas, permisos: r.permisos, atrasos: r.atrasos,
            st: r.salidas_tempranas, min: r.total_atraso_min,
        });
    }

    const wd = wb.addWorksheet('Detalle por día');
    wd.columns = [
        { header: 'CI',          key: 'user_id',  width: 16 },
        { header: 'Nombre',      key: 'name',     width: 32 },
        { header: 'Área',        key: 'area',     width: 22 },
        { header: 'Fecha',       key: 'fecha',    width: 13 },
        { header: 'Horario',     key: 'horario',  width: 16 },
        { header: 'Entrada',     key: 'entrada',  width: 11 },
        { header: 'Salida',      key: 'salida',   width: 11 },
        { header: 'Estado',      key: 'estado',   width: 20 },
        { header: 'Motivo',      key: 'motivo',   width: 40 },
    ];
    _estiloCabeceraAtrasos(wd.getRow(1));
    for (const r of registros) {
        wd.addRow({
            user_id: r.user_id, name: r.name, area: r.area || '', fecha: fmtDate(r.date),
            horario: `${r.esperado_entrada}-${r.esperado_salida}`,
            entrada: (r.entrada || '').slice(11, 19),
            salida: (r.salida || '').slice(11, 19),
            estado: r.estado,
            motivo: r.motivo || '',
        });
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="asistencia_${desde}_${hasta}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
});

// ----------------------------------------------------------------
//  Ocultar la ventana de consola (CMD) al ejecutar el .exe empaquetado
// ----------------------------------------------------------------
if (process.platform === 'win32' && IS_PKG && !process.env.REPORTES_HIDDEN) {
    const cp = require('child_process');
    const child = cp.spawn(process.execPath, process.argv.slice(1), {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
        env: Object.assign({}, process.env, { REPORTES_HIDDEN: '1' }),
    });
    child.unref();
    process.exit(0);
}

// ----------------------------------------------------------------
//  Inicio del servidor
// ----------------------------------------------------------------
const PORT = process.env.PORT || 3000;

bootstrap()
    .then(() => {
        const server = app.listen(PORT, '0.0.0.0', () => {
            console.log(`\n  ZKTeco Reportes corriendo en http://localhost:${PORT}`);
            console.log(`  API:     http://localhost:${PORT}/api/attendance`);
            console.log(`  Sync:    POST http://localhost:${PORT}/api/sync\n`);
            if (IS_PKG) {
                const cp = require('child_process');
                cp.spawn('cmd', ['/c', 'start', '', `http://localhost:${PORT}`], { stdio: 'ignore', detached: true }).unref();
            }
        });

        process.on('SIGINT',  () => { try { db.save(); } catch (e) {} server.close(() => process.exit(0)); });
        process.on('SIGTERM', () => { try { db.save(); } catch (e) {} server.close(() => process.exit(0)); });
    })
    .catch(err => {
        console.error('Error inicializando la base de datos:', err);
        process.exit(1);
    });