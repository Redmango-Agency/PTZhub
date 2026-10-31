'use strict';
const assert = require('assert');
const { createFakeCamera } = require('./fake-visca');
const { ViscaCamera } = require('../src/main/visca');
const { probeVisca } = require('../src/main/probe');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runMode(mode, port, panDigits) {
  const fake = createFakeCamera({ udpPort: 11259 + panDigits, tcpPort: 15678 + panDigits, sonyPort: 15381 + panDigits, panDigits });
  await sleep(100);
  const cam = new ViscaCamera({ host: '127.0.0.1', port: port + panDigits, mode, address: 1 });
  const statuses = [];
  cam.on('status', (s) => statuses.push(s.state));
  await cam.connect();
  await sleep(300);
  assert.strictEqual(cam.state, 'connected', `${mode}: stato connesso`);

  cam.move(0.5, 0.5); // destra + su
  await sleep(80);
  cam.move(0, 0);
  await sleep(200);
  cam.zoom(1); await sleep(50); cam.zoom(0);
  await sleep(150);

  const p1 = await cam.getPosition();
  assert.strictEqual(p1.kind, 'visca');
  assert.strictEqual(p1.pan.digits, panDigits);
  assert.ok(p1.pan.raw > 0, 'pan aumentato');
  assert.ok(p1.zoom > 0, 'zoom aumentato');

  // posizione negativa (complemento a due) e fuoco manuale
  const target = { kind: 'visca', pan: { raw: panDigits === 5 ? 0xFFF00 : 0xFF00, digits: panDigits }, tilt: { raw: 0xFFA0, digits: 4 }, zoom: 0x1234, focusAuto: false, focus: 0x0ABC };
  await cam.gotoPosition(target, 0.5);
  await sleep(200);
  const p2 = await cam.getPosition();
  assert.deepStrictEqual(p2.pan, target.pan);
  assert.deepStrictEqual(p2.tilt, target.tilt);
  assert.strictEqual(p2.zoom, 0x1234);
  assert.strictEqual(p2.focusAuto, false);
  assert.strictEqual(p2.focus, 0x0ABC);

  // slot camera
  cam.saveSlot(12);
  await sleep(100);
  cam.home();
  await sleep(100);
  cam.recallSlot(12);
  await sleep(150);
  const p3 = await cam.getPosition();
  assert.deepStrictEqual(p3.pan, target.pan);

  // lo stop su UDP viene ripetuto
  const stops = fake.state.log.filter((l) => l === '81 01 06 01 01 01 03 03 ff').length;
  if (mode !== 'tcp') assert.ok(stops >= 2, `${mode}: stop ripetuto (${stops})`);

  await cam.disconnect();
  fake.close();
  await sleep(100);
  console.log(`ok ${mode} (pan ${panDigits} nibble)`);
}

(async () => {
  await runMode('udp', 11259, 4);
  await runMode('tcp', 15678, 4);
  await runMode('sony', 15381, 4);
  await runMode('udp', 11259, 5);

  // camera con 2 socket: il fuoco manuale arriva comunque, dopo i nuovi tentativi
  {
    const fake = createFakeCamera({ udpPort: 11300, tcpPort: 15700, sonyPort: 15400, twoSockets: true });
    await sleep(100);
    const cam = new ViscaCamera({ host: '127.0.0.1', port: 11300, mode: 'udp' });
    await cam.connect();
    await sleep(200);
    const target = { kind: 'visca', pan: { raw: 0x0200, digits: 4 }, tilt: { raw: 0x0100, digits: 4 }, zoom: 0x2000, focusAuto: false, focus: 0x0777 };
    await cam.gotoPosition(target, 1);
    await sleep(100);
    const p = await cam.getPosition();
    assert.ok(fake.state.rejected > 0, 'la camera simulata ha rifiutato almeno un comando (buffer pieno)');
    assert.strictEqual(p.focusAuto, false, 'fuoco manuale applicato');
    assert.strictEqual(p.focus, 0x0777, 'posizione fuoco applicata dopo il nuovo tentativo');
    assert.strictEqual(p.zoom, 0x2000);

    // lo stop parte anche se si chiude subito dopo un movimento
    cam.move(0.5, 0);
    await sleep(50);
    const before = fake.state.log.length;
    await cam.disconnect();
    await sleep(100);
    const after = fake.state.log.slice(before);
    assert.ok(after.includes('81 01 06 01 01 01 03 03 ff'), `stop inviato alla chiusura (${after.join(' | ')})`);
    fake.close();
    console.log('ok camera a 2 socket + stop alla chiusura');
  }

  // rilevamento sulle porte standard
  const fake = createFakeCamera({ udpPort: 1259, tcpPort: 5678, sonyPort: 52381 });
  await sleep(100);
  const r = await probeVisca('127.0.0.1');
  for (const v of r) assert.ok(v.ok && v.position, `probe ${v.label}`);
  fake.close();
  console.log('ok probe VISCA');
  console.log('TUTTI I TEST VISCA PASSATI');
  process.exit(0);
})().catch((e) => { console.error('FALLITO:', e); process.exit(1); });
