'use strict';
// Camera USB su Windows senza aprire il video: collegamento con l'aiuto (protocollo di ptzhub-uvc.exe)
// provato con un aiuto finto in Node, e driver USB completo sopra di esso.
const assert = require('assert');
const path = require('path');
const { UvcNativeLink, parseLabel } = require('../src/main/uvc-native');
const { UvcCamera } = require('../src/main/uvc');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const ok = (name) => { pass += 1; console.log(`  ok  ${name}`); };

const FAKE = path.join(__dirname, 'fake-uvc-helper.js');
const TIMING = { tickMs: 10, ptFullS: 0.5, zoomFullS: 0.5, focusFullS: 0.5, recallFullS: 0.3, retryMs: 80 };

function link(mode = 'ptz') {
  process.env.FAKE_UVC = mode; // ereditata dal processo dell'aiuto
  return new UvcNativeLink({ exe: process.execPath, args: [FAKE] });
}

async function main() {
  // --- etichette di Chromium su Windows
  assert.deepStrictEqual(parseLabel('USB Camera (1bcf:2c99)'), { name: 'USB Camera', vidpid: 'vid_1bcf&pid_2c99' });
  assert.deepStrictEqual(parseLabel('HD Pro Webcam C920 (046D:082D)'), { name: 'HD Pro Webcam C920', vidpid: 'vid_046d&pid_082d' });
  assert.deepStrictEqual(parseLabel('Tenveo\tPTZ'), { name: 'Tenveo PTZ', vidpid: '' });
  ok('nome e VID/PID dall’etichetta della camera');

  // --- collegamento: apertura per VID/PID, valori, errori
  let l = link();
  const list = await l.list();
  assert.strictEqual(list.length, 2);
  const r = await l.open({ deviceId: 'abc', label: 'Camera con altro nome (1bcf:2c99)' });
  assert.strictEqual(r.deviceId, 'abc');
  assert.ok(r.caps.pan && r.caps.tilt && r.caps.zoom);
  let s = await l.apply({ pan: 12.4, tilt: -5, zoom: 150, focusMode: 'manual', bogus: 3 });
  assert.deepStrictEqual([s.pan, s.tilt, s.zoom, s.focusMode], [12, -5, 150, 'manual']);
  s = await l.settings();
  assert.strictEqual(s.zoom, 150);
  await assert.rejects(l.open({ label: 'Non esiste (ffff:ffff)' }), (e) => e.name === 'NotFoundError');
  await l.close();
  l.destroy();
  await assert.rejects(l.settings(), (e) => e.name === 'InvalidStateError');
  ok('apertura per VID/PID anche se il nome cambia, valori, camera assente');

  // --- driver completo: movimento, STOP, richiamo esatto, Home
  l = link();
  let cam = new UvcCamera({ deviceId: 'abc', label: 'USB Camera (1bcf:2c99)', link: l, timing: TIMING });
  await cam.connect();
  assert.strictEqual(cam.state, 'connected');
  cam.move(1, 0.5);
  await sleep(150);
  cam.stopAll();
  await sleep(60);
  const p1 = await cam.getPosition();
  assert.ok(p1.pan > 0 && p1.tilt > 0, JSON.stringify(p1));
  await cam.gotoPosition({ kind: 'usb', pan: -40, tilt: 10, zoom: 300 }, 1);
  await sleep(50);
  const st = await l.settings();
  assert.deepStrictEqual([st.pan, st.tilt, st.zoom], [-40, 10, 300]);
  await cam.disconnect();
  ok('driver USB sopra l’aiuto di Windows: movimento, STOP e richiamo esatto');

  // --- camera senza comandi via USB
  l = link('noptz');
  cam = new UvcCamera({ label: 'USB Camera (1bcf:2c99)', link: l, timing: TIMING });
  await cam.connect();
  assert.strictEqual(cam.state, 'error');
  assert.strictEqual(cam.code, 'noptz');
  await cam.disconnect();
  ok('camera che via USB manda solo il video: «non accetta movimenti»');

  // --- camera staccata durante l'uso: «non risponde» e nuovi tentativi
  l = link('unplug');
  cam = new UvcCamera({ label: 'USB Camera (1bcf:2c99)', link: l, timing: TIMING });
  await cam.connect();
  cam.move(1, 0);
  await sleep(200);
  cam.stopAll();
  assert.strictEqual(cam.state, 'error');
  assert.strictEqual(cam.code, 'notfound');
  await cam.disconnect();
  ok('camera staccata: stato «non risponde» con nuovi tentativi');

  // --- aiuto chiuso all'improvviso: le richieste in attesa non restano appese
  l = link();
  await l.open({ label: 'USB Camera (1bcf:2c99)' });
  let gone = false;
  l.on('gone', () => { gone = true; });
  l.proc.kill();
  await sleep(150);
  assert.ok(gone);
  await l.open({ label: 'USB Camera (1bcf:2c99)' }); // si riapre da solo
  l.destroy();
  ok('aiuto chiuso: segnalato e riaperto alla richiesta successiva');

  console.log(`uvc-native: ${pass} test superati`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
