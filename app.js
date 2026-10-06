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
//  Departamentos / areas
//
//  El biometrico solo entrega el CODIGO del departamento (group_id) de
//  cada empleado: no expone el nombre descriptivo. Por eso los codigos
//  que llegan del equipo se registran solos y el usuario les asigna un
//  nombre (tabla departments) desde la interfaz.
// ----------------------------------------------------------------
function deptNameMap() {
    const map = Object.create(null);
    for (const r of db.all('SELECT code, name FROM departments')) {
        if (r.name) map[r.code] = r.name;
    }
    return map;
}

// { user_id -> { codigo, nombre } } tomando el registro mas reciente
// (el mismo empleado puede vivir en varios biometricos).
function userDeptMap() {
    const map = Object.create(null);
    const names = deptNameMap();
    for (const r of db.all('SELECT user_id, department, MAX(synced_at) AS synced_at FROM users GROUP BY user_id')) {
        if (!r.department) continue;
        map[r.user_id] = {
            codigo: r.department,
            nombre: names[r.department] || r.department,
        };
    }
    return map;
}

// Registra un codigo recien leido del equipo (sin pisar el nombre ya
// asignado localmente).
function _registrarDepartamento(codigo) {
    if (codigo === null || codigo === undefined || codigo === '') return;
    db.run('INSERT OR IGNORE INTO departments (code, name, updated_at) VALUES (?, NULL, ?)',
        String(codigo), new Date().toISOString());
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

// Construye las jornadas de cada usuario.
// Reglas (UN registro por usuario por día):
//  - Cada día con marcas genera a lo sumo UNA fila por usuario.
//  - ENTRADA = primera marca punch 0 del día.
//  - Si el día tiene una SALIDA real (punch 1) se usa esa como salida.
//  - Si no hay salida real: una entrada (punch 0) posterior que difiera de la
//    entrada inicial en MÁS de 3 minutos se considera salida (el biométrico a
//    veces marca la salida como entrada).
//  - Si un día tiene SOLO SALIDAS (ningún punch 0):
//      * primero se intenta cerrar la jornada del día anterior (salida que
//        cruza la medianoche: personal que sale al día siguiente),
//      * si no hay jornada previa que cerrar, la PRIMERA salida del día se
//        toma como ENTRADA y la ULTIMA como SALIDA (fila inferida).
//  - Salidas nocturnas: una salida (punch 1) registrada al día siguiente, sin
//    entrada previa ese día, cierra la jornada del día anterior (personal que
//    sale el siguiente día).
//  - Se garantiza UN registro por usuario por día (sin repetidos).
function _buildJornadas(punches) {
    const perUser = Object.create(null);
    for (const p of punches) (perUser[p.user_id] = perUser[p.user_id] || []).push(p);

    const out = [];
    for (const uid of Object.keys(perUser)) {
        const byDate = Object.create(null);
        for (const p of perUser[uid]) {
            const d = p.timestamp.slice(0, 10);
            (byDate[d] = byDate[d] || []).push(p);
        }

        const rows = [];
        for (const d of Object.keys(byDate).sort()) {
            const marks = byDate[d].sort((a, b) => _ts(a.timestamp) - _ts(b.timestamp));
            const n = marks.length;

            let firstP0 = -1;
            for (let i = 0; i < n; i++) {
                if (Number(marks[i].punch) === 0) { firstP0 = i; break; }
            }

            // Salidas nocturnas: punch 1 sin una entrada previa en el mismo día.
            const overnight = firstP0 === -1
                ? marks.filter(p => Number(p.punch) === 1)
                : marks.slice(0, firstP0).filter(p => Number(p.punch) === 1);

            let overnightCerrado = false;
            if (overnight.length) {
                const prev = rows[rows.length - 1];
                if (prev && !prev.salida && prev.entrada.slice(0, 10) === _addDays(d, -1)) {
                    prev.salida = overnight.reduce(
                        (m, p) => _ts(p.timestamp) > _ts(m) ? p.timestamp : m,
                        overnight[0].timestamp);
                    prev.marcaciones += overnight.length;
                    overnightCerrado = true;
                }
            }

            // Dia SIN entradas (solo punch 1) que no cerro una jornada previa:
            // la primera salida es la entrada y la ultima es la salida.
            if (firstP0 === -1 && !overnightCerrado) {
                const p1s = marks.filter(p => Number(p.punch) === 1);
                if (!p1s.length) continue;
                rows.push({
                    user_id: uid,
                    name: p1s[0].name,
                    entrada: p1s[0].timestamp,
                    salida: p1s[p1s.length - 1].timestamp,
                    marcaciones: n,
                    inferida: 1,
                });
                continue;
            }

            const rest = firstP0 === -1 ? [] : marks.slice(firstP0);
            if (!rest.length) continue;

            const row = {
                user_id: uid,
                name: rest[0].name,
                entrada: rest[0].timestamp,
                salida: null,
                marcaciones: n,
                inferida: 0,
            };

            const p1s = rest.filter(p => Number(p.punch) === 1);
            if (p1s.length) {
                // Salida real marcada el mismo día.
                row.salida = p1s[p1s.length - 1].timestamp;
            } else {
                // Sin salida real: la última entrada (punch 0) posterior que
                // difiera de la entrada inicial por más de 3 minutos es salida.
                const t0 = _ts(rest[0].timestamp);
                for (let i = 1; i < rest.length; i++) {
                    if (Number(rest[i].punch) !== 0) continue;
                    if (_ts(rest[i].timestamp) - t0 > 3 * 60000) {
                        row.salida = rest[i].timestamp;
                    }
                }
            }

            rows.push(row);
        }

        // Garantiza UN registro por usuario por día incluso si el biométrico
        // registra marcaciones duplicadas o el cruce de medianoche generara
        // dos jornadas: se conserva la primera entrada y la última salida.
        const uniq = [];
        const seenDate = Object.create(null);
        for (const r of rows) {
            const k = r.user_id + '|' + (r.entrada || '').slice(0, 10);
            const prev = seenDate[k];
            if (!prev) {
                seenDate[k] = r;
                uniq.push(r);
                continue;
            }
            if (r.entrada && r.entrada < prev.entrada) prev.entrada = r.entrada;
            if (r.salida && (!prev.salida || r.salida > prev.salida)) prev.salida = r.salida;
            prev.marcaciones += r.marcaciones;
            prev.inferida = (prev.inferida || r.inferida) ? 1 : 0;
        }

        out.push(...uniq.map(r => ({
            date: (r.entrada || '').slice(0, 10),
            user_id: r.user_id,
            name: r.name,
            entrada: r.entrada,
            salida: r.salida,
            marcaciones: r.marcaciones,
            inferida: r.inferida || 0,
        })));
    }
    return out;
}

// Consulta las marcaciones del periodo y arma las jornadas.
// Incluye un día extra para capturar salidas que cruzan medianoche.
// opts.departamento : filtra por código o nombre de departamento.
//                   'sin' / '-' = empleados sin departamento asignado.
function getJornadas({ desde, hasta, q, users, user_id, orden, departamento }) {
    if (!desde) desde = '2000-01-01';
    if (!hasta) hasta = '2099-12-31';

    let where = 'timestamp >= ? AND timestamp <= ?';
    const params = [desde + ' 00:00:00', _addDays(hasta, 1) + ' 23:59:59'];

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
        `SELECT user_id, name, timestamp, punch, status FROM attendance WHERE ${where} ORDER BY user_id, timestamp`
    ).all(...params);

    // El departamento es un atributo del empleado: se resuelve desde la tabla
    // de usuarios (el mismo carnet puede estar en varios biometricos).
    const dept = userDeptMap();
    const filtroDept = String(departamento || '').trim();

    let rows = _buildJornadas(punches).map(j => {
        const d = dept[j.user_id];
        return {
            date: (j.entrada || '').slice(0, 10),
            user_id: j.user_id,
            name: j.name,
            departamento: d ? d.nombre : '',
            departamento_codigo: d ? d.codigo : '',
            entrada: j.entrada,
            salida: j.salida,
            marcaciones: j.marcaciones,
            inferida: j.inferida || 0,
        };
    });

    if (filtroDept) {
        const sinDept = ['sin', '-', 'ninguno', 'null'].includes(filtroDept.toLowerCase());
        rows = rows.filter(r => {
            if (sinDept) return !r.departamento;
            return String(r.departamento).toLowerCase() === filtroDept.toLowerCase()
                || String(r.departamento_codigo).toLowerCase() === filtroDept.toLowerCase();
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
//  Sincronizar UN dispositivo: conecta, descarga SOLO los registros
//  nuevos (incremental por dispositivo) y los guarda en SQLite.
//  El user_id del biométrico es el carnet (CI): se identifica por id.
// ----------------------------------------------------------------
async function syncDevice(dev) {
    const { id: deviceId, ip, port, password } = dev;
    const now = new Date().toISOString();

    let zk = null;
    let zkRetry = null;
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
                insU.run(deviceId, u.uid, u.userId, u.name, u.privilege, u.department, now);
                // El equipo solo entrega el codigo del departamento: se registra
                // para poder asignarle un nombre desde la interfaz.
                _registrarDepartamento(u.department);
            }
        }

        // Descarga SOLO los registros nuevos del dispositivo (desde el
        // ultimo indice ATTLOG sincronizado en last_records).
        const fetchNew = async (conn) => {
            const lastRec = Number(dev.last_records) || 0;
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

        if (deviceId) {
            const insA = db.prepare(
                'INSERT OR IGNORE INTO attendance (device_id, user_id, name, timestamp, status, punch, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
            );
            for (const r of records) {
                const ts = r.timestamp instanceof Date
                    ? r.timestamp.toISOString()
                    : String(r.timestamp);
                insA.run(deviceId, r.userId, r.name || userMap[r.userId] || '', ts, r.status, r.punch, now);
            }

            // Registrar el ultimo indice sincronizado (snapshot del
            // dispositivo, no el conteo leido) para la proxima corrida.
            db.run(
                'UPDATE devices SET last_records = ?, last_sync_at = ? WHERE id = ?',
                deviceTotal, now, deviceId
            );
        }

        const conDept = users.filter(u => u.department).length;
        const nuevosDept = db.prepare(
            'SELECT COUNT(*) AS n FROM departments WHERE name IS NULL OR name = ?'
        ).get(now).n;

        return {
            success: true,
            device: { id: deviceId, name: dev.name, ip, port },
            users: users.length,
            records: records.length,
            incremental,
            deviceRecords: deviceTotal,
            conDepartamento: conDept,
            departamentos: nuevosDept,
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
// ----------------------------------------------------------------
app.post('/api/sync', async (req, res) => {
    const { ip, port, password } = req.body || {};
    const now = new Date().toISOString();

    const deviceIp   = (ip && String(ip).trim());
    const devicePort = parseInt(port) || 4370;
    const devicePass = (password !== undefined && password !== null) ? password : 0;

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
            const result = await syncDevice(dev);
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
                return await syncDevice(d);
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
//  API: Usuarios (desde SQLite local o directo del dispositivo)
// ----------------------------------------------------------------
app.get('/api/users', (req, res) => {
    // El mismo carnet (user_id) puede vivir en varios biométricos: se
    // entrega UN solo registro por empleado (se toma el más reciente).
    const rows = db.prepare(
        'SELECT user_id, name, department, MAX(synced_at) AS synced_at FROM users GROUP BY user_id ORDER BY name COLLATE NOCASE'
    ).all();

    const nombres = deptNameMap();
    let out = rows.map(r => ({
        user_id: r.user_id,
        name: r.name,
        synced_at: r.synced_at,
        departamento_codigo: r.department || '',
        departamento: r.department ? (nombres[r.department] || r.department) : '',
    }));

    const dep = String((req.query && req.query.departamento) || '').trim();
    if (dep) {
        const sinDept = ['sin', '-', 'ninguno', 'null'].includes(dep.toLowerCase());
        out = out.filter(u => sinDept ? !u.departamento : u.departamento === dep || u.departamento_codigo === dep);
    }
    res.json(out);
});

// ----------------------------------------------------------------
//  API: Departamentos / areas
//  GET    : codigos leidos del biometrico + nombre asignado + empleados
//  POST   : asigna (o cambia) el nombre de un codigo
//  DELETE : quita el nombre asignado (el codigo sigue vigente)
// ----------------------------------------------------------------
app.get('/api/departments', (req, res) => {
    const conteo = Object.create(null);
    for (const r of db.all('SELECT department, COUNT(*) AS n FROM users WHERE department IS NOT NULL GROUP BY department')) {
        conteo[r.department] = r.n;
    }
    const filas = db.all('SELECT code, name, updated_at FROM departments ORDER BY code COLLATE NOCASE');

    //.Include tambien los codigos que aun no estan en la tabla (por si la
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

app.post('/api/departments', (req, res) => {
    const { code, name } = req.body || {};
    const c = String(code || '').trim();
    const n = String(name || '').trim();
    if (!c) return res.status(400).json({ success: false, error: 'code requerido' });
    db.run(
        'INSERT INTO departments (code, name, updated_at) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at',
        c, n || null, new Date().toISOString()
    );
    db.save();
    res.json({ success: true, codigo: c, nombre: n || c });
});

app.delete('/api/departments/:code', (req, res) => {
    const code = String(req.params.code || '').trim();
    if (!code) return res.status(400).json({ success: false, error: 'code invalido' });
    const info = db.run('DELETE FROM departments WHERE code = ?', code);
    db.save();
    res.json({ success: true, changes: info.changes });
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
    ).all(...params, limit, offset);

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
        `SELECT user_id, name, department, MAX(synced_at) AS synced_at FROM users WHERE ${where} GROUP BY user_id ORDER BY name COLLATE NOCASE`
    ).all(...params);

    const counts = db.prepare(`
        SELECT user_id, COUNT(*) as n
        FROM attendance
        WHERE DATE(timestamp) BETWEEN ? AND ?
        GROUP BY user_id
    `).all(desde, hasta);

    const cmap = Object.create(null);
    for (const c of counts) cmap[c.user_id] = c.n;

    const nombres = deptNameMap();

    res.json(users.map(u => ({
        user_id: u.user_id,
        name: u.name,
        marcaciones: cmap[u.user_id] || 0,
        departamento_codigo: u.department || '',
        departamento: u.department ? (nombres[u.department] || u.department) : '',
    })));
});

// ----------------------------------------------------------------
//  API: Resumen diario por usuario
// ----------------------------------------------------------------
app.get('/api/summary', (req, res) => {
    let { desde, hasta, user_id, q, users, orden, departamento } = req.query;
    if (!desde) desde = new Date().toISOString().slice(0, 10);
    if (!hasta) hasta = desde;

    res.json({ desde, hasta, records: getJornadas({ desde, hasta, user_id, q, users, orden, departamento }) });
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
    let { desde, hasta, q, users, departamento } = req.query;
    if (!desde) desde = '2000-01-01';
    if (!hasta) hasta = '2099-12-31';

    const detallado = !!(q && q.trim()) || !!(users && String(users).trim());
    const rows = getJornadas({ desde, hasta, q, users, departamento });
    const fmtDate  = d => d ? d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4) : '';
    const q2 = s => '"' + String(s || '').replace(/"/g, '""') + '"';

    const cols = ['CI', 'Nombre', 'Departamento', 'Entrada', 'Salida'];
    if (detallado) cols.push('Marcaciones');

    const linea = (r) => {
        const c = [r.user_id, q2(r.name), q2(r.departamento)];
        c.push((r.entrada || '').slice(11, 19), (r.salida || '').slice(11, 19));
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
    let { desde, hasta, q, users, departamento } = req.query;
    if (!desde) desde = '2000-01-01';
    if (!hasta) hasta = '2099-12-31';

    const detallado = !!(q && q.trim()) || !!(users && String(users).trim());
    const fmtDate = d => d ? d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4) : '';
    const rows = getJornadas({ desde, hasta, q, users, departamento });

    const cols = [
        { header: 'CI', key: 'user_id', width: 14 },
        { header: 'Nombre', key: 'name', width: 30 },
        { header: 'Departamento', key: 'departamento', width: 22 },
        { header: 'Entrada', key: 'entrada', width: 12 },
        { header: 'Salida', key: 'salida', width: 12 },
    ];
    if (detallado) cols.push({ header: 'Marcaciones', key: 'marcaciones', width: 12 });
    const ncols = cols.length;

    const mapped = rows.map(r => ({
        date: fmtDate(r.date),
        user_id: r.user_id,
        name: r.name,
        departamento: r.departamento || '',
        entrada: (r.entrada || '').slice(11, 19),
        salida: (r.salida || '').slice(11, 19),
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
    let { desde, hasta, q, users, departamento } = req.query;
    if (!desde) desde = '2000-01-01';
    if (!hasta) hasta = '2099-12-31';

    const detallado = !!(q && q.trim()) || !!(users && String(users).trim());
    const fmtDate = d => d ? d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4) : '';

    const rows = getJornadas({ desde, hasta, q, users, departamento });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="asistencia_${desde}_${hasta}.pdf"`);

    const headers = ['CI', 'Nombre', 'Departamento', 'Entrada', 'Salida'];
    const widths  = [80, 230, 150, 190, 190];
    if (detallado) { headers.push('Marc.'); widths.push(60); }

    const items = [];
    let prevFecha = null;
    for (const r of rows) {
        if (r.date !== prevFecha) {
            prevFecha = r.date;
            items.push({ type: 'date', text: fmtDate(r.date) });
        }
        const cells = [r.user_id, r.name || '', r.departamento || '-'];
        cells.push((r.entrada || '').slice(11, 19), (r.salida || '').slice(11, 19));
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