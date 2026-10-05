// Fuerza bruta: localizar formato exacto de registros de asistencia
const ZKDevice = require('./zk-client');

function tryDecode(buf4) {
    const t = buf4.readUInt32LE(0);
    const y = 2000 + (t >>> 26);
    const m = (t >>> 22) & 15;
    const d = (t >>> 17) & 31;
    const h = (t >>> 12) & 31;
    const mi = (t >>> 6) & 63;
    const s = t & 63;
    if (y >= 2024 && y <= 2030 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
        return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')} ${String(h).padStart(2,'0')}:${String(mi).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    }
    return null;
}

(async () => {
    const zk = new ZKDevice('192.168.118.172', 4370, 0, 8000);
    try {
        await zk.connect();
        const sizes = await zk.readSizes();
        const blob = await zk._streamData(zk.CMD.ATTLOG_RRQ);
        await zk.disconnect();

        console.log('blob.length =', blob.length, ' records(reportadas) =', sizes.records);
        console.log('Header 12 primeros:', blob.subarray(0, 12).toString('hex'));

        // Probar tamaños de registro y alineaciones
        for (const recSize of [40, 32, 16]) {
            // offsets donde (blob.length - start) % recSize === 0, considerando que el blob puede incluir header global
            const startCandidates = [];
            for (let s = 0; s <= 16; s++) {
                if ((blob.length - s) % recSize === 0 && (blob.length - s) > 0) startCandidates.push(s);
            }
            console.log(`\n=== recSize=${recSize} startCandidates=${startCandidates} ===`);
            for (const start of startCandidates) {
                const n = (blob.length - start) / recSize;
                // windows de timestamp a probar dentro del registro
                const tdMap = {};
                for (let w = 0; w <= recSize - 4; w += 1) {
                    // probar en primer y segundo registro
                    const rec1 = blob.subarray(start, start + recSize);
                    const rec2 = blob.subarray(start + recSize, start + 2 * recSize);
                    const t1 = tryDecode(rec1.subarray(w, w + 4));
                    const t2 = tryDecode(rec2.subarray(w, w + 4));
                    if (t1 && t2) tdMap[w] = `${t1} | ${t2}`;
                }
                console.log(`  start=${start} n=${n} timestampWindows: ${Object.entries(tdMap).map(([w, t]) => `[${w}:29] ${t}`).join('  ') || 'ninguno'}`);

                // dump hex del primer registro
                console.log(`    rec1 hex: ${blob.subarray(start, start + recSize).toString('hex')}`);
                const uid16 = blob.readUInt16LE(start);
                const uid32 = blob.readUInt32LE(start);
                const ascii = ZKDevice._cleanStr(blob.subarray(start + 4, start + 20));
                console.log(`    uid16=${uid16} uid32=${uid32} ascii[4:20]="${ascii}"`);
            }
        }

        console.log('\nOK');
    } catch (e) {
        console.error('ERROR:', e.message);
    }
})();