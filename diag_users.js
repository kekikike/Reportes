// Diagnostico del blob de usuarios del K40: muestra el DEPARTAMENTO que
// tiene cada empleado cargado en el biometrico.
//
//   cd C:\Users\Enrique\Desktop\reportes
//   node diag_users.js
//
// Edita DEVICE_IP si el biometrico tiene otra IP.
const ZKDevice = require('./zk-client');

const DEVICE_IP = process.argv[2] || '192.168.118.172';
const DEVICE_PORT = parseInt(process.argv[3]) || 4370;
const COMM_KEY = parseInt(process.argv[4]) || 0;

const hex = b => Buffer.from(b).toString('hex').match(/.{2}/g || []).join(' ');
const txt = b => ZKDevice._cleanStr(Buffer.from(b)).replace(/[^\x20-\x7E]/g, '.');

(async () => {
    const zk = new ZKDevice(DEVICE_IP, DEVICE_PORT, COMM_KEY, 15000);
    try {
        await zk.connect();
        const sizes = await zk.readSizes();
        console.log(`Conectado a ${DEVICE_IP}:${DEVICE_PORT}`);
        console.log('Tamanos:', JSON.stringify(sizes));

        // Blob crudo de usuarios, tal cual lo devuelve el equipo.
        const blob = await zk._streamData(zk.CMD.USERTEMP_RRQ);
        const total = blob.readUInt32LE(0);
        const data = blob.subarray(12);
        console.log(`\nBlob: ${blob.length} B | cabecera total=${total} | datos=${data.length} B`);
        console.log(`data.length % 72 = ${data.length % 72}  |  % 28 = ${data.length % 28}`);

        let packetSize = sizes.users > 0 && total > 0 && total % sizes.users === 0 ? total / sizes.users : 0;
        if (![28, 72].includes(packetSize)) packetSize = data.length % 72 === 0 ? 72 : 28;
        console.log(`Layout de usuario: ${packetSize} bytes por registro\n`);

        const usados = [];
        let off = 0;
        while (off + packetSize <= data.length && usados.length < 12) {
            const rec = data.subarray(off, off + packetSize);
            const uid = rec.readUInt16LE(0);
            const priv = rec[2];
            const name = packetSize === 72 ? txt(rec.subarray(11, 35)) : txt(rec.subarray(8, 16));
            const userId = packetSize === 72 ? txt(rec.subarray(48, 72)) : String(rec.readUInt32LE(24));

            // Bytes donde puede vivir el departamento (group_id) segun pyzk:
            //   72 bytes: card I(35) | pad(39) | group_id 7s(40) | pad(47)
            //   28 bytes: card I(16) | pad(20) | group_id B(21)
            const card   = packetSize === 72 ? rec.readUInt32LE(35) : rec.readUInt32LE(16);
            const grupo  = packetSize === 72 ? txt(rec.subarray(40, 47)) : String(rec[21] || '');
            const leido  = ZKDevice._normDepartment(grupo);

            console.log(`uid=${uid} priv=${priv} user_id="${userId}" nombre="${name}"`);
            console.log(`    card(35/16)=${card}  group_id(40/21)="${grupo}"  -> DEPARTAMENTO=${leido === null ? '(vacio)' : leido}`);
            console.log(`    bytes 35..48: ${hex(rec.subarray(35, 48))}   ascii: "${txt(rec.subarray(35, 48))}"`);

            usados.push(leido);
            off += packetSize;
        }

        const conDpto = usados.filter(x => x !== null).length;
        console.log(`\nResumen (${usados.length} usuarios revisados): ${conDpto} con departamento.`);
        if (conDpto === 0) {
            console.log('=> El equipo NO devolvio ningun codigo en group_id.');
            console.log('   Copia el bloque "bytes 35..48" de arriba y pasamelo:');
            console.log('   si hay un numero ahi, el departamento esta en otro offset');
            console.log('   y lo ajusto en zk-client.js.');
        }

        await zk.disconnect();
    } catch (e) {
        console.error('ERROR:', e.message);
        console.error('Revisa que la PC este en el mismo segmento que el biometrico.');
    }
})();
