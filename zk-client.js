/**
 * ZKTeco K40 — Cliente UDP del protocolo de pull (puerto 4370).
 * Implementacion en Node.js replicando pyzk.
 */

class ZKDevice {
    constructor(ip, port = 4370, password = 0, timeout = 15000, transport = 'auto') {
        this.ip = ip;
        this.port = port;
        this.password = password;
        this.timeout = timeout;
        this.transport = transport; // 'auto' | 'tcp' | 'udp'
        this.useTcp = transport === 'tcp';
        this.sock = null;
        this.sessionId = 0;
        this.replyId = 65534;
        this.isConnected = false;
        this.tcpBuf = Buffer.alloc(0);
        this.tcpFrames = [];
        this.tcpWaiters = [];

        // Constantes del protocolo
        this.CMD = {
            ATTLOG_RRQ:     13,
            USERTEMP_RRQ:   9,
            USERTEMP_WRRQ:  10, // escribir usuario
            SET_USER:       8,
            GET_FREE_SIZES: 50,
            CONNECT:        1000,
            EXIT:           1001,
            ENABLE_DEVICE:  1002,
            DISABLE_DEVICE: 1003,
            AUTH:           1102,
            PREPARE_DATA:   1500,
            DATA:           1501,
            FREE_DATA:      1502,
            DATA_WRRQ:      1503, // preparar buffer de datos (protocolo "new"/TCP)
            READ_BUFFER:    1504, // leer un tramo del buffer preparado
            ACK_OK:         2000,
            ACK_UNAUTH:     2005,
        };

        // Tamaño maximo de un bloque por pedido READ_BUFFER
        this.MAX_CHUNK = 0xFFC0;
        // Milisegundos de silencio tras los que se da por terminada una transmision
        this.READ_IDLE = 1200;
    }

    // ---------------------------------------------------------------
    //  Checksum (replica exacta de pyzk / zkemsdk.c)
    // ---------------------------------------------------------------
    _checksum(buf) {
        let cs = 0;
        for (let i = 0; i < buf.length - 1; i += 2) {
            cs += buf.readUInt16LE(i);
            if (cs > 65535) cs -= 65535;
        }
        if (buf.length % 2 !== 0) {
            cs += buf[buf.length - 1];
        }
        while (cs > 65535) cs -= 65535;
        cs = ~cs;
        while (cs < 0) cs += 65535;
        return cs & 0xFFFF;
    }

    // ---------------------------------------------------------------
    //  Construccion de trama
    // ---------------------------------------------------------------
    _makeFrame(command, payload = Buffer.alloc(0)) {
        const header = Buffer.alloc(8);
        header.writeUInt16LE(command, 0);
        header.writeUInt16LE(0, 2); // checksum placeholder
        header.writeUInt16LE(this.sessionId, 4);
        header.writeUInt16LE(this.replyId, 6);

        const frame = Buffer.concat([header, payload]);
        const cs = this._checksum(frame);

        header.writeUInt16LE(cs, 2);

        // Incrementar reply_id (como pyzk)
        let newReply = this.replyId + 1;
        if (newReply >= 65535) newReply -= 65535;
        header.writeUInt16LE(newReply, 6);

        return { frame: Buffer.concat([header, payload]), sentReply: newReply };
    }

    // ---------------------------------------------------------------
    //  Make comm key (MakeKey de zkemsdk.c / pyzk)
    //  Se usa multiplicacion (no desplazamiento) para evitar el desborde
    //  a int32 que romperia claves impares.
    // ---------------------------------------------------------------
    _makeCommKey(key, sessionId) {
        let k = 0;
        for (let i = 0; i < 32; i++) {
            if (key & (1 << i)) {
                k = (k * 2) | 1;
            } else {
                k = k * 2;
            }
        }
        k = (k + sessionId) & 0xFFFFFFFF;

        const b = Buffer.alloc(4);
        b.writeUInt32LE(k >>> 0, 0);

        const b0 = b[0] ^ 0x5A; // Z
        const b1 = b[1] ^ 0x4B; // K
        const b2 = b[2] ^ 0x53; // S
        const b3 = b[3] ^ 0x4F; // O

        const ticks = 50;
        return Buffer.from([
            b2 ^ ticks,
            b3 ^ ticks,
            ticks,
            b1 ^ ticks,
        ]);
    }

    // ---------------------------------------------------------------
    //  Enviar trama UDP
    // ---------------------------------------------------------------
    _sendFrame(command, payload = Buffer.alloc(0)) {
        const { frame, sentReply } = this._makeFrame(command, payload);
        return new Promise((resolve, reject) => {
            if (this.useTcp) {
                const top = Buffer.alloc(8);
                top.writeUInt16LE(0x5050, 0);
                top.writeUInt16LE(0x7d82, 2);
                top.writeUInt32LE(frame.length, 4);
                this.sock.write(Buffer.concat([top, frame]), (err) => {
                    if (err) return reject(new Error(`Error enviando: ${err.message}`));
                    this.replyId = sentReply;
                    resolve();
                });
            } else {
                this.sock.send(frame, 0, frame.length, this.port, this.ip, (err) => {
                    if (err) return reject(new Error(`Error enviando: ${err.message}`));
                    this.replyId = sentReply;
                    resolve();
                });
            }
        });
    }

    // ---------------------------------------------------------------
    //  Recibir trama UDP
    // ---------------------------------------------------------------
    _recvFrame(timeoutMs) {
        if (this.useTcp) return this._recvFrameTcp(timeoutMs);
        const timeout = timeoutMs || this.timeout;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error('Timeout esperando respuesta del dispositivo.'));
            }, timeout);

            this.sock.once('message', (msg) => {
                clearTimeout(timer);
                if (msg.length < 8) {
                    return reject(new Error(`Trama muy corta (${msg.length}B)`));
                }
                const cmd      = msg.readUInt16LE(0);
                const session  = msg.readUInt16LE(4);
                const reply    = msg.readUInt16LE(6);
                const data     = msg.subarray(8);

                this.sessionId = session;
                this.replyId = reply;
                resolve({ command: cmd, session, reply, data });
            });
        });
    }

    // ---------------------------------------------------------------
    //  Recibir una trama tolerante al silencio: resuelve null si
    //  transcurre 'idleMs' sin nuevos datos (fin de transmision).
    // ---------------------------------------------------------------
    _recvFrameMaybe(timeoutMs, idleMs) {
        return new Promise((resolve) => {
            const recvP = this._recvFrame(timeoutMs).catch(() => null);
            const idle = setTimeout(() => resolve(null), idleMs);
            recvP.then((f) => { clearTimeout(idle); resolve(f); });
        });
    }

    // ---------------------------------------------------------------
    //  Soporte TCP (cabecera TOP 0x5050/0x7d82, replicando pyzk)
    // ---------------------------------------------------------------
    _parseFrame(msg) {
        if (msg.length < 8) throw new Error(`Trama muy corta (${msg.length}B)`);
        const command = msg.readUInt16LE(0);
        const session = msg.readUInt16LE(4);
        const reply   = msg.readUInt16LE(6);
        const data    = msg.subarray(8);
        this.sessionId = session;
        this.replyId = reply;
        return { command, session, reply, data };
    }

    _recvFrameTcp(timeoutMs) {
        if (this.tcpFrames.length > 0) {
            try {
                return Promise.resolve(this._parseFrame(this.tcpFrames.shift()));
            } catch (e) {
                return Promise.reject(e);
            }
        }
        const timeout = timeoutMs || this.timeout;
        return new Promise((resolve, reject) => {
            const waiter = {
                resolve,
                reject,
                timer: setTimeout(() => {
                    const i = this.tcpWaiters.indexOf(waiter);
                    if (i !== -1) this.tcpWaiters.splice(i, 1);
                    reject(new Error('Timeout esperando respuesta del dispositivo.'));
                }, timeout),
            };
            this.tcpWaiters.push(waiter);
        });
    }

    _parseTcpData(chunk) {
        this.tcpBuf = Buffer.concat([this.tcpBuf, chunk]);
        while (this.tcpBuf.length >= 8) {
            const t1 = this.tcpBuf.readUInt16LE(0);
            const t2 = this.tcpBuf.readUInt16LE(2);
            const len = this.tcpBuf.readUInt32LE(4);
            if (t1 !== 0x5050 || t2 !== 0x7d82 || len < 8) {
                this.tcpBuf = this.tcpBuf.subarray(1);
                continue;
            }
            if (this.tcpBuf.length < 8 + len) break;
            const frame = Buffer.from(this.tcpBuf.subarray(8, 8 + len));
            this.tcpBuf = this.tcpBuf.subarray(8 + len);
            this._deliverTcpFrame(frame);
        }
    }

    _deliverTcpFrame(frame) {
        if (this.tcpWaiters.length > 0) {
            const w = this.tcpWaiters.shift();
            clearTimeout(w.timer);
            try {
                w.resolve(this._parseFrame(frame));
            } catch (e) {
                w.reject(e);
            }
        } else {
            this.tcpFrames.push(frame);
        }
    }

    _rejectAllTcpWaiters(err) {
        while (this.tcpWaiters.length > 0) {
            const w = this.tcpWaiters.shift();
            clearTimeout(w.timer);
            w.reject(err);
        }
    }

    _resetTransport() {
        this.tcpBuf = Buffer.alloc(0);
        this.tcpFrames = [];
        this.tcpWaiters = [];
        this.isConnected = false;
        this.sessionId = 0;
        this.replyId = 65534;
    }

    // ---------------------------------------------------------------
    //  Enviar comando y esperar respuesta
    // ---------------------------------------------------------------
    async _command(cmd, payload = Buffer.alloc(0)) {
        if (!this.isConnected && cmd !== this.CMD.CONNECT && cmd !== this.CMD.AUTH) {
            throw new Error('No hay conexion activa con el dispositivo.');
        }
        await this._sendFrame(cmd, payload);
        return this._recvFrame();
    }

    // ---------------------------------------------------------------
    //  Decodificar tiempo ZK (4 bytes LE -> Date)
    // ---------------------------------------------------------------
    static _decodeTime(buf) {
        if (buf.length < 4) return new Date(0);
        let t = buf.readUInt32LE(0);
        const sec  = t % 60; t = Math.floor(t / 60);
        const min  = t % 60; t = Math.floor(t / 60);
        const hour = t % 24; t = Math.floor(t / 24);
        const day  = t % 31 + 1; t = Math.floor(t / 31);
        const mon  = t % 12 + 1; t = Math.floor(t / 12);
        const year = t + 2000;
        return new Date(year, mon - 1, day, hour, min, sec);
    }

    // ---------------------------------------------------------------
    //  Formatear fecha/hora del dispositivo (hora local sin zona)
    //  Se mantienen tal cual los valores del reloj interno del equipo.
    // ---------------------------------------------------------------
    static _formatDateTime(d) {
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }

    // ---------------------------------------------------------------
    //  Limpiar strings ZK
    // ---------------------------------------------------------------
    static _cleanStr(buf) {
        if (!buf || buf.length === 0) return '';
        let str = buf.toString('utf8');
        const nul = str.indexOf('\x00');
        if (nul !== -1) str = str.substring(0, nul);
        return str.trim();
    }

    // ---------------------------------------------------------------
    //  Normalizar el codigo de departamento (group_id) del empleado.
    //  El biometrico escribe el valor tal cual se cargo en el equipo
    //  ("1", "01", "ADMIN", ...). Vacio o "0" significa "sin departamento
    //  asignado" (0 es el valor por defecto de group_id en el protocolo).
    // ---------------------------------------------------------------
    static _normDepartment(v) {
        if (v === null || v === undefined) return null;
        const s = String(v).replace(/\x00/g, '').trim();
        if (!s) return null;
        if (/^0+$/.test(s)) return null;
        return s;
    }

    // ---------------------------------------------------------------
    //  Decodificar un registro ATTLOG de 40 bytes y devolver sus campos.
    // ---------------------------------------------------------------
    static _decodeAttRecord(rec) {
        const uid       = rec.readUInt16LE(0);
        let userId      = ZKDevice._cleanStr(rec.subarray(2, 26));
        const status    = rec[26];
        const timestamp = ZKDevice._formatDateTime(ZKDevice._decodeTime(rec.subarray(27, 31)));
        const punch     = rec[31];
        if (!userId) userId = String(uid);
        return { uid, userId, status, timestamp, punch };
    }

    // ---------------------------------------------------------------
    //  Conexion al dispositivo
    // ---------------------------------------------------------------
    async connect() {
        const modes = this.transport === 'udp' ? ['udp']
            : this.transport === 'tcp' ? ['tcp']
            : ['tcp', 'udp'];
        let lastErr = null;
        for (const mode of modes) {
            try {
                if (mode === 'tcp') await this._connectTcp();
                else await this._connectUdp();
                return true;
            } catch (err) {
                lastErr = err;
                this._cleanupSocket();
            }
        }
        throw lastErr || new Error('No se pudo conectar al dispositivo.');
    }

    _connectTcp() {
        const net = require('net');
        this.useTcp = true;
        this._resetTransport();
        return new Promise((resolve, reject) => {
            const sock = net.createConnection({ host: this.ip, port: this.port });
            this.sock = sock;
            let settled = false;

            const timer = setTimeout(() => {
                fail(new Error('Timeout conectando al dispositivo.'));
            }, this.timeout);

            const fail = (err) => {
                this._rejectAllTcpWaiters(err);
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(err);
            };

            sock.on('data', (d) => this._parseTcpData(d));
            sock.on('error', (e) => fail(new Error(`Socket error: ${e.message}`)));
            sock.on('close', () => fail(new Error('Conexion cerrada por el dispositivo.')));
            sock.once('connect', () => {
                settled = true;
                clearTimeout(timer);
                this._doConnect().then(resolve).catch(reject);
            });
        });
    }

    _connectUdp() {
        const dgram = require('dgram');
        this.useTcp = false;
        this._resetTransport();
        return new Promise((resolve, reject) => {
            const sock = dgram.createSocket('udp4');
            this.sock = sock;
            sock.on('error', (err) => {
                reject(new Error(`Socket error: ${err.message}`));
            });
            sock.bind(0, () => {
                this._doConnect().then(resolve).catch(reject);
            });
        });
    }

    _cleanupSocket() {
        if (this.sock) {
            try {
                if (typeof this.sock.destroy === 'function') this.sock.destroy();
                else this.sock.close();
            } catch (e) {}
            this.sock = null;
        }
        this.isConnected = false;
    }

    async _doConnect() {
        try {
            this.sessionId = 0;
            this.replyId = 65534;

            // CMD_CONNECT
            let resp = await this._command(this.CMD.CONNECT);
            this.sessionId = resp.session;

            // CMD_AUTH si es necesario
            if (resp.command === this.CMD.ACK_UNAUTH) {
                const key = this._makeCommKey(this.password, this.sessionId);
                resp = await this._command(this.CMD.AUTH, key);
            }

            if (![this.CMD.ACK_OK, this.CMD.CONNECT].includes(resp.command)) {
                throw new Error(`Respuesta inesperada al conectar: cmd=${resp.command}`);
            }

            this.isConnected = true;
            return true;
        } catch (err) {
            this.isConnected = false;
            throw err;
        }
    }

    // ---------------------------------------------------------------
    //  Desconexion
    // ---------------------------------------------------------------
    async disconnect() {
        if (this.sock) {
            try {
                await this._command(this.CMD.EXIT);
            } catch (e) {}

            if (this.useTcp) {
                return new Promise((resolve) => {
                    const sock = this.sock;
                    this.sock = null;
                    this.isConnected = false;
                    try {
                        sock.end(() => resolve());
                    } catch (e) {
                        resolve();
                    }
                    setTimeout(resolve, 2000);
                });
            }

            return new Promise((resolve) => {
                const sock = this.sock;
                this.sock = null;
                this.isConnected = false;
                sock.close(() => resolve());
            });
        }
    }

    // ---------------------------------------------------------------
    //  Habilitar / deshabilitar dispositivo
    // ---------------------------------------------------------------
    async disable() {
        const r = await this._command(this.CMD.DISABLE_DEVICE);
        return r.command === this.CMD.ACK_OK;
    }

    async enable() {
        const r = await this._command(this.CMD.ENABLE_DEVICE);
        return r.command === this.CMD.ACK_OK;
    }

    // ---------------------------------------------------------------
    //  Tamanos de memoria
    // ---------------------------------------------------------------
    async readSizes() {
        const r = await this._command(this.CMD.GET_FREE_SIZES);
        const data = r.data;
        if (data.length < 80) {
            throw new Error(`Respuesta de tamanos invalida (${data.length}B, cmd=${r.command})`);
        }
        const fields = [];
        for (let i = 0; i < 20; i++) {
            fields.push(data.readUInt32LE(i * 4));
        }
        // pyzk: users=fields[4], fingers=fields[6], records=fields[8]
        // fingers_cap=fields[14], users_cap=fields[15], rec_cap=fields[16]
        return {
            users: fields[4],
            fingers: fields[6],
            records: fields[8],
            cards: fields[12],
            fingersCap: fields[14],
            usersCap: fields[15],
            recCap: fields[16],
        };
    }

    // ---------------------------------------------------------------
    //  Streaming de datos (protocolo legacy 1500/1501)
    // ---------------------------------------------------------------
    async _streamData(command) {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                return await this._streamDataOnce(command);
            } catch (e) {
                if (attempt === 2) throw e;
                await sleep(300);
            }
        }
        return null;
    }

    async _streamDataOnce(command) {
        const resp = await this._command(command);

        if (resp.command === this.CMD.DATA) {
            return resp.data;
        }

        if (resp.command !== this.CMD.PREPARE_DATA) {
            throw new Error(`Respuesta inesperada: cmd=${resp.command}`);
        }

        const total = resp.data.readUInt32LE(0);
        let blob = Buffer.from(resp.data);

        // Leer datagramas restantes. Se da por terminada la transmision
        // cuando (a) se completo el tamaño esperado, (b) llega un ACK_OK o
        // (c) el dispositivo queda en silencio READ_IDLE ms (evita esperar
        // 30 s por bytes fantasma que algunos firmwares nunca envian).
        while (blob.length < 8 + total) {
            const idleP = new Promise(r => setTimeout(() => r(null), this.READ_IDLE));
            let f = null;
            try {
                f = await Promise.race([
                    this._recvFrame(this.timeout).catch(() => null),
                    idleP,
                ]);
            } catch (e) {
                break;
            }
            if (f === null) break;

            if (f.command === this.CMD.DATA) {
                blob = Buffer.concat([blob, f.data]);
            } else if (f.command === this.CMD.ACK_OK) {
                break;
            } else if (f.command === this.CMD.PREPARE_DATA) {
                blob = Buffer.concat([blob, f.data]);
            }
        }

        try {
            await this._command(this.CMD.FREE_DATA);
        } catch (e) {}

        return blob;
    }

    // ---------------------------------------------------------------
    //  Obtener usuarios
    // ---------------------------------------------------------------
    async getUsers() {
        const sizes = await this.readSizes();
        if (sizes.users === 0) return [];

        const blob = await this._streamData(this.CMD.USERTEMP_RRQ);
        if (blob.length < 6) return [];

        const total = blob.readUInt32LE(0);
        const blobSize = blob.readUInt32LE(8);
        // Los registros reales comienzan en el byte 12:
        //   [0:4] total, [4:8] chunk, [8:12] tamano de datos, [12:] datos
        let data = blob.subarray(12);

        let packetSize = 28;
        if (blobSize > 0 && sizes.users > 0 && blobSize % sizes.users === 0) {
            packetSize = blobSize / sizes.users;
        }
        if (packetSize !== 28 && packetSize !== 72) {
            packetSize = (data.length % 72 === 0) ? 72 : 28;
        }

        const users = [];
        let offset = 0;
        while (offset + packetSize <= data.length) {
            const rec = data.subarray(offset, offset + packetSize);
            let uid, userId, name, department, card;

            if (packetSize === 72) {
                // pyzk: '<HB8s24sIx7sx24s'
                //   uid H(0) | privilege B(2) | password 8s(3) | name 24s(11)
                //   card I(35) | pad(39) | group_id 7s(40) | pad(47)
                //   user_id 24s(48)
                uid = rec.readUInt16LE(0);
                card = rec.readUInt32LE(35);
                // El "Departamento / Area" que se cargo en el biometrico es el
                // group_id del empleado (texto de 7 caracteres).
                department = ZKDevice._cleanStr(rec.subarray(40, 47));
                userId = ZKDevice._cleanStr(rec.subarray(48, 72));
                name = ZKDevice._cleanStr(rec.subarray(11, 35));
            } else {
                // pyzk: '<HB5s8sIxBhI'
                //   uid H(0) | privilege B(2) | password 5s(3) | name 8s(8)
                //   card I(16) | pad(20) | group_id B(21) | timezone h(22)
                //   user_id I(24)
                uid = rec.readUInt16LE(0);
                card = rec.readUInt32LE(16);
                department = rec[21] ? String(rec[21]) : '';
                userId = String(rec.readUInt32LE(24));
                name = ZKDevice._cleanStr(rec.subarray(8, 16));
            }

            if (!userId) userId = String(uid);
            if (!name) name = `Usuario-${userId}`;

            users.push({
                uid,
                userId,
                name,
                // privilege es el byte 2 del registro (detras del uid de 2 bytes)
                privilege: rec[2] || 0,
                card,
                department: ZKDevice._normDepartment(department),
            });

            offset += packetSize;
        }

        return users;
    }

    // ---------------------------------------------------------------
    //  Obtener registros de asistencia
    // ---------------------------------------------------------------
    async getAttendance(userMap = null) {
        const sizes = await this.readSizes();
        if (sizes.records === 0) return [];

        let users = null;
        if (!userMap) {
            try {
                // Releer usuarios en una conexion fresca (el K40 no acepta
                // dos streams distintos en la misma sesion UDP).
                users = await this.getUsers();
            } catch (e) {
                users = [];
            }
        }

        const map = userMap || {};
        if (users) {
            for (const u of users) {
                map[u.userId] = u.name;
                map[String(u.uid)] = u.name;
            }
        }

        const blob = await this._streamData(this.CMD.ATTLOG_RRQ);
        if (blob.length < 4) return [];

        const total = blob.readUInt32LE(0);
        const blobSize = blob.readUInt32LE(8);
        const data = blob.subarray(12);

        // Determinar tamano de registro
        let sz = 0;
        if (sizes.records > 0 && blobSize > 0 && blobSize % sizes.records === 0) {
            sz = blobSize / sizes.records;
        }
        if (![8, 16, 40].includes(sz)) {
            if (sizes.records > 0 && data.length % sizes.records === 0) {
                sz = data.length / sizes.records;
            }
        }
        if (![8, 16, 40].includes(sz)) {
            for (const c of [8, 16, 40]) {
                if (data.length > 0 && data.length % c === 0) { sz = c; break; }
            }
        }
        if (sz === 0) return [];

        const records = [];
        let offset = 0;
        while (offset + sz <= data.length) {
            const rec = data.subarray(offset, offset + sz);
            let userId, uid, timestamp, status, punch;

            if (sz === 8) {
                uid = rec.readUInt16LE(0);
                status = rec[2];
                timestamp = ZKDevice._formatDateTime(ZKDevice._decodeTime(rec.subarray(3, 7)));
                punch = rec[7];
                userId = String(uid);
            } else if (sz === 16) {
                userId = String(rec.readUInt32LE(0));
                uid = parseInt(userId);
                timestamp = ZKDevice._formatDateTime(ZKDevice._decodeTime(rec.subarray(4, 8)));
                status = rec[8];
                punch = rec[9];
            } else {
                uid = rec.readUInt16LE(0);
                userId = ZKDevice._cleanStr(rec.subarray(2, 26));
                status = rec[26];
                timestamp = ZKDevice._formatDateTime(ZKDevice._decodeTime(rec.subarray(27, 31)));
                punch = rec[31];
                if (!userId) userId = String(uid);
            }

            const name = map[userId] || map[String(uid)] || 'Desconocido';

            const recObj = {
                uid,
                userId,
                name,
                timestamp,
                status,
                punch,
                punchLabel: this._punchLabel(punch),
                statusLabel: this._statusLabel(status),
            };
            if (!ZKDevice._isPhantomRecord(recObj)) {
                records.push(recObj);
            }

            offset += sz;
        }

        return records;
    }

    // ---------------------------------------------------------------
    //  LECTURA INCREMENTAL (protocolo "nuevo" 1503/1504)
    //
    //  El K40 apendiza los ATTLOG en orden cronologico (los mas recientes
    //  al final del buffer). Para no descargar siempre el dataset completo:
    //   1) se prepara el buffer con CMD_DATA_WRRQ (1503),
    //   2) se lee SOLO la cola (registros desde `fromRecord` hasta el
    //      final) en un unico tramo 1504 READ_BUFFER,
    //   3) se verifica la sanidad (cuenta exacta y timestamps crecientes
    //      >= maxTs) y, si algo falla, se cae a la lectura completa.
    //  El incremental se usa SOLO cuando el delta cabe en un tramo 1504.
    // ---------------------------------------------------------------

    // Preparar el buffer de asistencia en el dispositivo (1503).
    async _prepareAttlogBuffer() {
        // pyzk read_with_buffer(CMD_ATTLOG_RRQ=13): payload de 11 bytes
        // [1, 13, 0,0,0,0, 0,0,0, 0] (CMD flag + ATTLOG_RRQ).
        const payload = Buffer.from([1, 13, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        const r = await this._command(this.CMD.DATA_WRRQ, payload);

        // El tamano llega en data[1:5] (el byte 0 es eco del comando).
        const readSize = (d) => {
            if (!d || d.length < 5) return 0;
            return d.readUInt32LE(1);
        };

        if (r.command === this.CMD.PREPARE_DATA) {
            return { total: readSize(r.data), prepared: true };
        }
        if (r.command === this.CMD.ACK_OK && r.data.length >= 5) {
            return { total: readSize(r.data), prepared: true };
        }
        if (r.command === this.CMD.ACK_OK) {
            return { total: 0, prepared: true };
        }
        throw new Error(`Respuesta inesperada PREPARE_DATA: cmd=${r.command}`);
    }

    // Leer un tramo ya preparado del buffer (1504 READ_BUFFER).
    // start = 4 + indice*40  (el bloque de datos empieza en el byte 4).
    async _readBufferRange(startByte, sizeBytes) {
        const payload = Buffer.alloc(8);
        payload.writeInt32LE(startByte, 0);
        payload.writeInt32LE(sizeBytes, 4);
        await this._sendFrame(this.CMD.READ_BUFFER, payload);

        const chunks = [];
        let got = 0;
        let done = false;

        while (!done && (got < sizeBytes)) {
            let f = null;
            try {
                f = await this._recvFrameMaybe(this.timeout, this.READ_IDLE);
            } catch (e) {
                break;
            }
            if (!f) break;

            if (f.command === this.CMD.DATA) {
                chunks.push(f.data);
                got += f.data.length;
            } else if (f.command === this.CMD.ACK_OK) {
                done = true;
            }
            // PREPARE_DATA / otros: ignorar
        }

        // Drenar un ACK residual si quedo pendiente.
        try { await this._recvFrameMaybe(600, 400); } catch (e) {}

        return Buffer.concat(chunks);
    }

    // ---------------------------------------------------------------
    //  Un registro ATTLOG real nunca tiene uid 0 (el indice interno del
    //  usuario arranca en 1), ni anio 2000, ni punch/status fuera de los
    //  rangos estandar (0-5 / 0-7). El equipo deja un "slot vacio" al
    //  final del buffer 1503/1504 que relee como memoria basura
    //  (uid=0, timestamps 2000/2074, status 48/82, etc.). Se descarta
    //  asi para que nunca se cuele en el reporte de asistencia.
    // ---------------------------------------------------------------
    static _isPhantomRecord(rec) {
        const uid = Number(rec.uid);
        if (uid === 0) return true;
        const y = String(rec.timestamp || '').slice(0, 4);
        if (y < '2001' || y > '2099') return true;
        const t = Date.parse(String(rec.timestamp || '').replace(' ', 'T'));
        if (!Number.isFinite(t) || t > Date.now() + 24 * 3600 * 1000) return true;
        const punch = Number(rec.punch);
        if (![0, 1, 2, 3, 4, 5].includes(punch)) return true;
        const status = Number(rec.status);
        if (!(status >= 0 && status <= 8)) return true;
        return false;
    }

    // Decodificar un tramo de registros ATTLOG (40 bytes c/u, sin cabecera).
    _decodeAttendanceBlob(blob) {
        const recSize = 40;
        const records = [];
        let offset = 0;
        while (offset + recSize <= blob.length) {
            const rec = blob.subarray(offset, offset + recSize);
            const uid = rec.readUInt16LE(0);
            let userId = ZKDevice._cleanStr(rec.subarray(2, 26));
            const status = rec[26];
            const timestamp = ZKDevice._formatDateTime(
                ZKDevice._decodeTime(rec.subarray(27, 31))
            );
            const punch = rec[31];
            if (!userId) userId = String(uid);
            const record = { uid, userId, name: '', timestamp, status, punch };
            if (!ZKDevice._isPhantomRecord(record)) records.push(record);
            offset += recSize;
        }
        return records;
    }

    // ---------------------------------------------------------------
    //  Descarga incremental de asistencia.
    //  opts.fromRecord : indice del PRIMER registro sin sincronizar
    //                    (0/undefined => lectura completa).
    //  opts.maxTs      : timestamp maximo local (ms) para verificar la cola.
    //  opts.userMap    : { userId/uid -> name }
    //  Devuelve { records, total, incremental, full }.
    // ---------------------------------------------------------------
    async getAttendanceSince(opts = {}) {
        const { fromRecord, maxTs = 0, userMap = null } = opts;
        const sizes = await this.readSizes();
        const N = sizes.records || 0;
        if (N === 0) return { records: [], total: 0, incremental: false, full: true };

        const runFull = async () => ({
            records: await this.getAttendance(userMap),
            total: N,
            incremental: false,
            full: true,
        });

        const k = Number(fromRecord) || 0;
        // Sin corte previo => lectura completa (primera sincronizacion).
        if (k <= 0) return runFull();

        // El buffer se achico (se borraron registros) => resincronizar.
        if (N < k) return runFull();

        // Nada nuevo: respuesta inmediata sin descargar nada.
        if (N <= k) {
            return { records: [], total: N, incremental: true, full: false };
        }

        const delta = N - k;
        const bytes = delta * 40;
        // Solo incremental cuando todo el delta cabe en UNA peticion 1504.
        if (bytes <= 0 || bytes > this.MAX_CHUNK) return runFull();

        let blob = null;
        try {
            const prep = await this._prepareAttlogBuffer();
            if (!prep.prepared) return runFull();

            const startByte = 4 + k * 40;
            blob = await this._readBufferRange(startByte, bytes);
            // liberar el buffer preparado
            try { await this._command(this.CMD.FREE_DATA); } catch (e) {}
        } catch (e) {
            try { await this._command(this.CMD.FREE_DATA); } catch (e2) {}
            return runFull();
        }

        const decoded = this._decodeAttendanceBlob(blob);

        // Verificacion de sanidad estructural: la lectura devolvio
        // EXACTAMENTE los slots pedidos.
        const slotCount = blob.length / 40;
        if (!Number.isInteger(slotCount) || slotCount !== delta) {
            try { await this._command(this.CMD.FREE_DATA); } catch (e2) {}
            return runFull();
        }

        // El ultimo slot del buffer 1503/1504 suele ser un "slot vacio"
        // con basura volatil: puede leer como una marca casi plausible
        // (uid!=0, anio 2074/2000, status/punch raros). Se acepta SOLO el
        // prefijo cronologico de marcas NUEVAS (t > maxTs), crecientes y
        // dentro del futuro admisible (reloj del equipo). La cola fantasma
        // se CONSOME (last_records avanza a N) para que el proximo sync
        // lea solo la marca real nueva.
        const nowMs = Date.now();
        const maxFuture = nowMs + 24 * 3600 * 1000; // tolerancia de reloj
        let prev = 0;
        let p = 0;
        for (; p < decoded.length; p++) {
            const t = Date.parse(String(decoded[p].timestamp).replace(' ', 'T'));
            if (!(t > maxTs) || t > maxFuture || t < prev) break;
            prev = t;
        }

        if (p === decoded.length) {
            // Toda la cola es valida y nueva.
            return { records: decoded, total: N, incremental: true, full: false };
        }

        if (p > 0 && p < decoded.length - 1) {
            // Basura en MEDIO de la cola (no deberia pasar con un buffer
            // apendeado): no se confia en un corte, se relee todo.
            return runFull();
        }

        // Basura al inicio (delta de puro fantasma) o al final: se acepta
        // el prefijo valido (puede ser vacio) y se consume el indice.
        const records = decoded.slice(0, p);
        return { records, total: N, incremental: true, full: false };
    }

    // ---------------------------------------------------------------
    //  Labels
    // ---------------------------------------------------------------
    _punchLabel(p) {
        const map = {
            0: 'Entrada', 1: 'Salida',
            2: 'Salida fuera', 3: 'Entrada fuera',
            4: 'Extra entrada', 5: 'Extra salida',
        };
        return map[p] || `Tipo ${p}`;
    }

    _statusLabel(s) {
        const map = {
            0: 'Huella', 1: 'Tarjeta', 2: 'Clave',
            3: 'Huella+Clave', 4: 'Tarjeta+Huella',
            5: 'Tarjeta+Clave', 6: 'FP+PWD', 7: 'All', 8: 'All',
        };
        return map[s] || `Verif ${s}`;
    }

    // ---------------------------------------------------------------
    //  Agregar usuario al biométrico (K40)
    //  userId: CI (máx 24 chars)
    //  name: Nombres y Apellido Paterno unidos por espacio (máx 24 chars)
    //  department: group_id (código de área)
    // ---------------------------------------------------------------
    async addUser({ userId, name, department = null, privilege = 0 }) {
        if (!this.isConnected) throw new Error('No hay conexión activa con el dispositivo');
        if (!userId || !userId.trim()) throw new Error('userId requerido');
        if (!name || !name.trim()) throw new Error('name requerido');
        
        const uid = 0;
        const card = 0;
        const pass = '';
        const dept = ZKDevice._normDepartment(department) || '';
        
        const userIdStr = String(userId).trim().substring(0, 24);
        const nameStr = String(name).trim().substring(0, 24);
        const deptStr = String(dept).trim().substring(0, 7);
        const deptNum = parseInt(dept) || 0;
        const userIdNum = parseInt(userId);
        
        // Formato más compatible con K40 Pro: usar PACKET_SIZE 28 (registro corto)
        // Enviar con CMD.DATA_WRRQ estilo pyzk - o usar comando directo
        // Intentar con formato 28 (el que usa getUsers 28 bytes)
        const rec28 = Buffer.alloc(28);
        rec28.writeUInt16LE(uid, 0);
        rec28.writeUInt8(privilege & 0xFF, 2);
        Buffer.from(pass.substring(0, 5), 'latin1').copy(rec28, 3, 0, 5);
        Buffer.from(nameStr.substring(0, 8), 'latin1').copy(rec28, 8, 0, 8);
        rec28.writeUInt32LE(card, 16);
        rec28.writeUInt8(deptNum & 0xFF, 21);
        // timezone 0
        rec28.writeUInt16LE(0, 22);
        rec28.writeUInt32LE(Number.isNaN(userIdNum) ? uid : userIdNum, 24);
        
        const rec72 = Buffer.alloc(72);
        rec72.writeUInt16LE(uid, 0);
        rec72.writeUInt8(privilege & 0xFF, 2);
        Buffer.from(pass, 'latin1').copy(rec72, 3, 0, 8);
        Buffer.from(nameStr, 'latin1').copy(rec72, 11, 0, 24);
        rec72.writeUInt32LE(card, 35);
        Buffer.from(deptStr, 'latin1').copy(rec72, 40, 0, 7);
        rec72.writeUInt8(0, 47);
        Buffer.from(userIdStr, 'latin1').copy(rec72, 48, 0, 24);
        
        // Probar formato 28 (más común)
        const payload28 = Buffer.alloc(11 + 28);
        payload28[0] = 1; // Data record count
        payload28[1] = this.CMD.USERTEMP_WRRQ & 0xFF;
        payload28[2] = (this.CMD.USERTEMP_WRRQ >> 8) & 0xFF;
        payload28.fill(0, 3, 11);
        rec28.copy(payload28, 11);
        
        try {
            const resp = await this._command(this.CMD.USERTEMP_WRRQ, rec28);
            if (resp.command === this.CMD.ACK_OK) return true;
            // Si no es ACK_OK, intentar payload con header
        } catch (e) {}
        
        // Intentar formato 72
        try {
            const resp72 = await this._command(this.CMD.USERTEMP_WRRQ, rec72);
            if (resp72.command === this.CMD.ACK_OK) return true;
        } catch (e) {}
        
        // Intentar CMD_SET_USER (8) con formato 72 - más directo
        // Intentar CMD_SET_USER (8) con formato 72 - más directo
        try {
            const respSet = await this._command(8, rec72);
            if (respSet.command === this.CMD.ACK_OK) return true;
        } catch (e3) {
            // Intentar formato 28
            try {
                const respSet2 = await this._command(8, rec28);
                if (respSet2.command === this.CMD.ACK_OK) return true;
            } catch (e4) {}
        }
        
        // Intentar USERTEMP_WRRQ (10)
        try {
            const resp = await this._command(10, rec72);
            if (resp.command === this.CMD.ACK_OK) return true;
        } catch (e5) {
            try {
                const resp = await this._command(10, rec28);
                if (resp.command === this.CMD.ACK_OK) return true;
            } catch (e6) {}
        }
        
        throw new Error('No se pudo agregar el usuario al biométrico');
    }
}

module.exports = ZKDevice;