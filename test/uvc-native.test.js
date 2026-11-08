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

function link(mode = 'ptz', rel = '1') {
  process.env.FAKE_UVC = mode; // ereditate dal processo dell'aiuto
  process.env.FAKE_UVC_REL = rel;
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

  // --- passo piccolo senza comandi a velocità: un passo della griglia, nella direzione giusta
  l = link('ptz', '0');
  cam = new UvcCamera({ label: 'USB Camera (1bcf:2c99)', link: l, timing: TIMING });
  await cam.connect();
  const s0 = await l.settings();
  cam.stepMove(1, 0);
  await sleep(60);
  let s1 = await l.settings();
  assert.deepStrictEqual([s1.pan - s0.pan, s1.tilt - s0.tilt], [1, 0]);
  cam.stepMove(0, -1);
  cam.stepMove(0, -1);
  await sleep(60);
  s1 = await l.settings();
  assert.deepStrictEqual([s1.pan - s0.pan, s1.tilt - s0.tilt], [1, -2]);
  await cam.disconnect();
  ok('passo piccolo via USB: un passo della griglia per clic');

  // --- movimento a velocità (Windows, se la camera lo accetta): fluido e fine
  l = link();
  cam = new UvcCamera({ label: 'USB Camera (1bcf:2c99)', link: l, timing: { ...TIMING, relPulseMs: 120, relKeepMs: 200 } });
  const logs = [];
  cam.on('log', (m) => logs.push(m));
  await cam.connect();
  await sleep(100);
  assert.ok(cam._relOn(), 'comandi a velocità disponibili');
  assert.ok(logs.some((m) => /fluido/.test(m)), `avviso «movimento fluido»: ${logs}`);
  const dbg = () => l.request('debug');
  let before = (await dbg()).relLog.length;
  const sStep0 = await l.settings();
  cam.stepMove(1, 0); // passo fine: velocità minima per un attimo, poi ferma
  await sleep(250);
  let d = await dbg();
  assert.deepStrictEqual(d.relLog.slice(before), [{ pan: 1, tilt: 0 }, { pan: 0, tilt: 0 }], JSON.stringify(d.relLog.slice(before)));
  assert.ok(Math.abs(d.cur.pan - sStep0.pan) <= 1, 'il passo fine sposta meno di un grado');
  // tenuto premuto: velocità chiesta, confermata finché si tiene, ferma al rilascio
  before = d.relLog.length;
  cam.move(0.12, -0.12);
  await sleep(700);
  d = await dbg();
  const held = d.relLog.slice(before);
  assert.ok(held.length >= 3 && held.every((v) => v.pan === 4 && v.tilt === -3), `velocità «Veloce» confermata: ${JSON.stringify(held)}`);
  cam.move(0, 0);
  await sleep(80);
  d = await dbg();
  assert.deepStrictEqual(d.rel.pan === 0 && d.rel.tilt === 0, true, 'ferma al rilascio');
  // STOP durante il movimento; poi un richiamo parte solo con la camera ferma
  cam.move(1, 0);
  await sleep(80);
  cam.stopAll();
  await sleep(80);
  d = await dbg();
  assert.ok(d.rel.pan === 0 && d.rel.tilt === 0, 'STOP ferma il movimento a velocità');
  cam.move(-1, 0);
  await sleep(50);
  await cam.gotoPosition({ kind: 'usb', pan: 30, tilt: 5, zoom: 200 }, 1);
  d = await dbg();
  assert.ok(d.rel.pan === 0 && d.rel.tilt === 0, 'il richiamo ferma prima il movimento a velocità');
  assert.deepStrictEqual([d.cur.pan, d.cur.tilt, d.cur.zoom], [30, 5, 200]);
  // PTZ Hub chiuso durante il movimento: la camera si ferma
  cam.move(1, 1);
  await sleep(80);
  await cam.disconnect();
  ok('movimento a velocità: passo fine, tenuto, STOP, richiamo e chiusura fermano la camera');

  // --- camera che rifiuta i comandi a velocità: si torna ai passi assoluti
  l = link('ptz', 'refuse');
  cam = new UvcCamera({ label: 'USB Camera (1bcf:2c99)', link: l, timing: TIMING });
  const logs2 = [];
  cam.on('log', (m) => logs2.push(m));
  await cam.connect();
  await sleep(100);
  const r0 = await l.settings();
  cam.stepMove(1, 0); // rifiutato: avviso e passi assoluti da qui in poi
  await sleep(100);
  assert.ok(!cam._relOn() && logs2.some((m) => /rifiutato/.test(m)), logs2.join(' | '));
  cam.stepMove(1, 0);
  await sleep(100);
  const r1 = await l.settings();
  assert.strictEqual(r1.pan - r0.pan, 1, 'a passi assoluti dopo il rifiuto');
  assert.strictEqual(cam.state, 'connected');
  await cam.disconnect();
  ok('comandi a velocità rifiutati: si continua a passi, la camera resta collegata');

  // --- opzione «Movimento fluido» spenta: passi assoluti
  l = link();
  cam = new UvcCamera({ label: 'USB Camera (1bcf:2c99)', link: l, timing: TIMING, smooth: false });
  await cam.connect();
  await sleep(100);
  assert.ok(!cam._relOn());
  await cam.disconnect();
  ok('movimento fluido spento dalle Impostazioni: passi assoluti');

  // --- camera senza comandi via USB
  l = link('noptz');
  cam = new UvcCamera({ label: 'USB Camera (1bcf:2c99)', link: l, timing: TIMING });
  await cam.connect();
  assert.strictEqual(cam.state, 'error');
  assert.strictEqual(cam.code, 'noptz');
  await cam.disconnect();
  ok('camera che via USB manda solo il video: «non accetta movimenti»');

  // --- camera staccata durante l'uso: «non risponde» e nuovi tentativi
  l = link('unplug', '0');
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
