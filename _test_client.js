const ZKDevice = require('./zk-client');
(async () => {
  const zk = new ZKDevice('192.168.118.172', 4370, 0, 10000);
  try {
    await zk.connect();
    console.log('Conectado (transporte auto -> TCP)');
    const users = await zk.getUsers();
    console.log(`Usuarios: ${users.length}`);
    for (const u of users.slice(0, 5)) console.log(`  uid=${u.uid} user_id=${u.userId} name=${u.name}`);
    await zk.disconnect();

    const zk2 = new ZKDevice('192.168.118.172', 4370, 0, 10000);
    await zk2.connect();
    const recs = await zk2.getAttendance();
    console.log(`Registros: ${recs.length}`);
    for (const r of recs.slice(0, 5)) console.log(`  user=${r.userId} name=${r.name} ts=${r.timestamp} punch=${r.punch}`);
    await zk2.disconnect();
    console.log('OK');
  } catch (e) {
    console.error('ERROR:', e.message);
  }
})();
