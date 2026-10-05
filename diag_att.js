// Diagnóstico del blob de asistencia del K40
const ZKDevice = require('./zk-client');

(async () => {
    const zk = new ZKDevice('192.168.118.172', 4370, 0, 8000);
    try {
        await zk.connect();
        const sizes = await zk.readSizes();
        console.log('Sizes:', JSON.stringify(sizes));

        const blob = await zk._streamData(zk.CMD.ATTLOG_RRQ);
        console.log('\nBlob asistencia:', blob.length, 'bytes');
        console.log('Primeros 60 bytes:');
        console.log(blob.subarray(0, 60).toString('hex').match(/.{2}/g).join(' '));
        console.log('header total =', blob.readUInt32LE(0));

        const data = blob.subarray(12);
        console.log('data[12:].length =', data.length);
        console.log('data.length / records =', data.length / sizes.records);

        for (const sz of [8, 16, 40]) {
            console.log(`\n--- registro size=${sz} ---`);
            let off = 0;
            while (off + sz <= data.length && off < sz * 6) {
                const rec = data.subarray(off, off + sz);
                let out;
                if (sz === 8) {
                    out = `uid=${rec.readUInt16LE(0)} status=${rec[2]} time=${ZKDevice._decodeTime(rec.subarray(3,7)).toISOString()} punch=${rec[7]}`;
                } else if (sz === 16) {
                    out = `userId=${rec.readUInt32LE(0)} status=${rec[8]} time=${ZKDevice._decodeTime(rec.subarray(4,8)).toISOString()} punch=${rec[9]}`;
                } else {
                    out = `uid=${rec.readUInt16LE(0)} status=${rec[26]} time=${ZKDevice._decodeTime(rec.subarray(27,31)).toISOString()} punch=${rec[31]}`;
                }
                console.log(out);
                off += sz;
            }
        }

        await zk.disconnect();
        console.log('\nOK');
    } catch (e) {
        console.error('ERROR:', e.message);
    }
})();