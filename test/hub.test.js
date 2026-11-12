'use strict';
// Centro operativo: richiami annullabili, impulsi che si fermano sempre, blocco durante la modifica
const assert = require('assert');
const { Hub } = require('../src/main/hub');
const { ViscaCamera } = require('../src/main/visca');
const { createFakeCamera } = require('./fake-visca');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const ok = (name) => { pass += 1; console.log(`  ok  ${name}`); };

// camera finta che registra i comandi; il richiamo dura 120 ms ed è annullabile
function mockCam() {
  const log = [];
  return {
    log,
    move(x, y) { log.push(`move ${x} ${y}`); },
    zoom(z) { log.push(`zoom ${z}`); },
    focus() {},
    focusOnePush() {},
    stopAll() { log.push('stopAll'); },
    home() { log.push('home'); },
    async gotoPosition(pos, sp, cancelled) {
      if (!pos || pos.kind !== 'mock') throw new Error('incompatibile');
      log.push(`goto ${pos.n}`);
      await sleep(120);
      if (cancelled && cancelled()) { const e = new Error('cancelled'); e.code = 'CANCELLED'; throw e; }
      log.push(`zoom-to ${pos.n}`);
    },
    async recallSlot() {},
  };
}

function makeHub(cam) {
  const store = {
    settings: { camera: { host: 'x', protocol: 'mock' }, recallSpeed: 0.7, moveSpeed: 0.6 },
    presets: [
      { id: 'a', name: 'A', pos: { kind: 'mock', n: 1 } },
      { id: 'b', name: 'B', pos: { kind: 'mock', n: 2 } },
      { id: 'c', name: 'C', pos: { kind: 'mock', n: 3 } },
      { id: 'x', name: 'Senza posizione' },
    ],
  };
  return new Hub({ store, getCamera: () => cam });
}

(async () => {
  // 1. impulso e poi richiamo: lo stop dell'impulso parte prima del richiamo
  let cam = mockCam();
  let hub = makeHub(cam);
  hub.nudge('left', 2000);
  await hub.recallId('a');
  const iStop = cam.log.indexOf('move 0 0');
  assert.ok(iStop > 0 && iStop < cam.log.indexOf('goto 1'), cam.log.join(' | '));
  await sleep(50);
  ok('impulso + richiamo: la testa si ferma');

  // 2. zoom a impulso e poi Home: lo zoom si ferma
  cam = mockCam();
  hub = makeHub(cam);
  hub.zoomPulse('in', 2000);
  hub.home();
  assert.ok(cam.log.indexOf('zoom 0') > 0 && cam.log.indexOf('zoom 0') < cam.log.indexOf('home'), cam.log.join(' | '));
  ok('zoom a impulso + Home: lo zoom si ferma');

  // 3. impulso e poi un richiamo che fallisce: lo stop parte lo stesso
  cam = mockCam();
  hub = makeHub(cam);
  hub.nudge('right', 2000);
  await assert.rejects(hub.recallId('x'));
  assert.ok(cam.log.includes('move 0 0'), cam.log.join(' | '));
  ok('impulso + richiamo non riuscito: la testa si ferma');

  // 3b. passo piccolo (freccia premuta e rilasciata): impulso brevissimo alla velocità minima,
  // poi stop; con una camera che sa fare il passo da sola (USB) passa a lei; segnale «manuale»
  cam = mockCam();
  hub = makeHub(cam);
  let manual = 0;
  hub.on('manual', () => { manual += 1; });
  hub.stepMove('left');
  assert.strictEqual(cam.log[0], 'move -0.01 0');
  await sleep(200);
  assert.ok(cam.log.includes('move 0 0'), cam.log.join(' | '));
  const stepCam = { ...mockCam(), steps: [], stepMove(x, y) { this.steps.push([x, y]); } };
  hub = makeHub(stepCam);
  hub.stepMove('up');
  assert.deepStrictEqual(stepCam.steps, [[0, 1]]);
  assert.strictEqual(manual, 1);
  assert.throws(() => hub.stepMove('obliquo'));
  ok('passo piccolo: impulso minimo con stop, oppure passo della camera USB');

  // 3c. comandi manuali dall'app: interrompono il richiamo in corso (anche VISCA/ONVIF) e
  //     un impulso da Stream Deck non li ferma a metà
  cam = mockCam();
  hub = makeHub(cam);
  let rp = hub.recallId('b');
  await sleep(40);
  hub.manualMove(0.12, 0);
  assert.strictEqual(await rp, null, 'il richiamo è superato');
  assert.ok(!cam.log.includes('zoom-to 2'), cam.log.join(' | '));
  hub.manualMove(0, 0);
  hub.nudge('left', 100);
  hub.manualMove(0, 0.12);
  await sleep(180);
  assert.strictEqual(cam.log[cam.log.length - 1], 'move 0 0.12', `l'impulso non ferma il movimento a mano: ${cam.log.join(' | ')}`);
  rp = hub.recallId('a');
  await sleep(40);
  hub.manualZoom(0.7);
  assert.strictEqual(await rp, null);
  hub.manualZoom(0);
  ok('comandi manuali dall’app: interrompono il richiamo, l’impulso non li ferma');

  // 4. STOP durante un richiamo: i passi mancanti non partono e l'inquadratura non diventa attiva
  cam = mockCam();
  hub = makeHub(cam);
  const pr = hub.recallId('b');
  await sleep(40);
  hub.stop();
  assert.strictEqual(await pr, null);
  assert.ok(!cam.log.includes('zoom-to 2'), cam.log.join(' | '));
  assert.strictEqual(hub.activeId, null);
  ok('STOP annulla il richiamo in corso');

  // 5. un richiamo più recente supera il precedente
  cam = mockCam();
  hub = makeHub(cam);
  const r1 = hub.recallId('a');
  await sleep(30);
  const r2 = hub.recallId('c');
  assert.strictEqual(await r1, null);
  assert.strictEqual((await r2).id, 'c');
  assert.strictEqual(hub.activeId, 'c');
  ok('richiami sovrapposti: vince l’ultimo');

  // 6. due "successiva" rapide fanno due passi
  cam = mockCam();
  hub = makeHub(cam);
  await hub.recallId('a');
  const s1 = hub.step(1);
  const s2 = hub.step(1);
  await Promise.all([s1, s2]);
  assert.strictEqual(hub.activeId, 'c');
  assert.strictEqual(hub.state().activeIndex, 3, 'activeIndex conta da 1');
  ok('successiva premuta due volte: due passi; activeIndex da 1');

  // 7. modifica in corso: i comandi da fuori sono bloccati, quelli del programma no
  cam = mockCam();
  hub = makeHub(cam);
  hub.setEditing(true);
  await assert.rejects(hub.recallId('a'));
  assert.strictEqual((await hub.recallId('a', undefined, { force: true })).id, 'a', 'richiamo dell’editor');
  assert.throws(() => hub.home({ remote: true }));
  assert.throws(() => hub.nudge('up', 300, undefined, { remote: true }));
  assert.throws(() => hub.remoteMove(0.5, 0, 0));
  hub.remoteMove(0, 0, 0); // fermarsi è sempre permesso
  await assert.rejects(hub.run('home'));
  hub.home(); // il tasto Home del programma
  hub.stop();
  hub.setEditing(false);
  ok('modifica in corso: OBS e tasti in attesa, STOP sempre attivo');

  // 8. movimento remoto: stessa velocità = nessun comando ripetuto; dopo STOP quelli in ritardo si scartano
  cam = mockCam();
  hub = makeHub(cam);
  hub.remoteMove(0.5, 0, 0);
  const n1 = cam.log.length;
  hub.remoteMove(0.5, 0, 0);
  assert.strictEqual(cam.log.length, n1, 'nessun comando ripetuto');
  hub.stop();
  const n2 = cam.log.length;
  hub.remoteMove(0.5, 0, 0);
  assert.strictEqual(cam.log.length, n2, 'movimento in ritardo dopo STOP scartato');
  await sleep(450);
  hub.remoteMove(0.3, 0, 0);
  assert.ok(cam.log.length > n2, 'dopo un attimo si riparte');
  hub.stop();
  ok('movimento remoto: niente ripetizioni, niente ripartenze dopo STOP');

  // 9. VISCA vera (simulata, camera occupata): STOP durante i tentativi del richiamo
  const fake = createFakeCamera({ udpPort: 11460, tcpPort: 15860, sonyPort: 15560, twoSockets: true });
  await sleep(100);
  const vcam = new ViscaCamera({ host: '127.0.0.1', port: 11460, mode: 'udp' });
  await vcam.connect();
  await sleep(150);
  const vstore = {
    settings: { camera: { host: '127.0.0.1', protocol: 'visca-udp' }, recallSpeed: 0.7, moveSpeed: 0.6 },
    presets: [{ id: 'p', name: 'P', pos: { kind: 'visca', pan: { raw: 0x500, digits: 4 }, tilt: { raw: 0x50, digits: 4 }, zoom: 0x3000, focusAuto: true, focus: null } }],
  };
  const vhub = new Hub({ store: vstore, getCamera: () => vcam });
  // la camera è già impegnata da due movimenti lunghi: il richiamo viene respinto e ritentato
  vcam.t.send([0x01, 0x06, 0x02, 0x10, 0x10, 0, 0, 0, 1, 0, 0, 0, 1]);
  vcam.t.send([0x01, 0x04, 0x47, 0, 0, 1, 0]);
  await sleep(30);
  const vr = vhub.recallId('p');
  await sleep(150);
  const mark = fake.state.log.length;
  vhub.stop();
  assert.strictEqual(await vr, null);
  await sleep(600);
  const after = fake.state.log.slice(mark);
  assert.ok(!after.some((l) => /^81 01 06 02/.test(l) || /^81 01 04 47/.test(l)), `dopo STOP: ${after.join(' | ')}`);
  assert.notStrictEqual(fake.state.zoom, 0x3000);
  assert.strictEqual(vhub.activeId, null);
  ok('VISCA occupata: dopo STOP il richiamo non riparte');
  await vcam.disconnect();
  fake.close();

  console.log(`hub: ${pass} test superati`);
  process.exit(0);
})().catch((e) => { console.error('FALLITO:', e); process.exit(1); });
