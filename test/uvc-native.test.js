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
const TIMING = { tickMs: 10, ptFullS: 0.5, zoomFullS: 0.5, focusFullS: 0.5, retryMs: 80, stepSettleMs: 20, kickGapMs: 30 };

function linkWith(env) {
  for (const k of Object.keys(process.env)) if (k.startsWith('FAKE_UVC')) delete process.env[k];
  Object.assign(process.env, { FAKE_UVC: 'ptz', FAKE_UVC_REL: '1', ...env });
  return new UvcNativeLink({ exe: process.execPath, args: [FAKE] });
}

function link(mode = 'ptz', rel = '1') {
  for (const k of Object.keys(process.env)) if (k.startsWith('FAKE_UVC')) delete process.env[k];
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
  await cam.stepMove(1, 0);
  let s1 = await l.settings();
  assert.deepStrictEqual([s1.pan - s0.pan, s1.tilt - s0.tilt], [1, 0]);
  cam.stepMove(0, -1);
  await cam.stepMove(0, -1); // clic rapidi: i passi vanno in fila, ognuno si fa
  await sleep(20);
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
  await cam.stepMove(1, 0); // clic: un passo assoluto minimo, niente impulso a velocità
  await sleep(50);
  let d = await dbg();
  assert.deepStrictEqual(d.relLog.slice(before), [], JSON.stringify(d.relLog.slice(before)));
  assert.strictEqual(d.cur.pan - sStep0.pan, 1, 'il clic sposta di un passo della griglia');
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

  // --- casi della Tenveo vera (1.5.6) ---------------------------------------------------------
  const T2 = { ...TIMING, confirmEveryMs: 30, confirmMs: 2500, resendGapMs: 60, kickGapMs: 60, stepSettleMs: 60, slowStepMs: 200 };
  const real = async (env, extra = {}) => {
    const lk = linkWith(env);
    const c = new UvcCamera({ label: 'USB Camera (1bcf:2c99)', link: lk, timing: { ...T2, ...extra } });
    const lg = [];
    c.on('log', (m) => lg.push(m));
    await c.connect();
    await sleep(80);
    return { lk, c, lg, phys: async () => (await lk.request('debug')).phys };
  };
  const at = (ph, p) => [ph.pan, ph.tilt, ph.zoom].join() === [p.pan, p.tilt, p.zoom].join();
  const P = { kind: 'usb', pan: 30, tilt: 10, zoom: 200, focusAuto: true };

  // A. telecomando IR + camera che ignora il valore che ha già + letture USB ferme all'ultimo valore
  {
    const { lk, c, phys } = await real({ FAKE_UVC_SAME: '1' });
    await c.gotoPosition(P, 1);
    assert.ok(at(await phys(), P), 'primo richiamo');
    await lk.request('ir', ['pan=-80', 'tilt=50', 'zoom=350']);
    await c.gotoPosition(P, 1);
    let ph = await phys();
    assert.ok(at(ph, P), `dopo il telecomando torna sull'inquadratura: ${JSON.stringify(ph)}`);
    await c.home();
    await lk.request('ir', ['pan=60', 'zoom=300']);
    await c.home();
    ph = await phys();
    assert.deepStrictEqual([ph.pan, ph.tilt, ph.zoom], [0, 0, 100], `Home due volte col telecomando in mezzo: ${JSON.stringify(ph)}`);
    await c.disconnect();
    ok('richiamo dopo il telecomando: la camera torna anche se via USB dice di essere già lì');
  }

  // B. stessa camera ma con le letture vere: il richiamo non resta bloccato fino allo scadere
  {
    const { lk, c, lg, phys } = await real({ FAKE_UVC_SAME: '1', FAKE_UVC_READS: 'phys' });
    await c.gotoPosition(P, 1);
    await lk.request('ir', ['pan=-80', 'tilt=50', 'zoom=350']);
    const t0 = Date.now();
    await c.gotoPosition(P, 1);
    const ph = await phys();
    assert.ok(at(ph, P), `letture vere: ${JSON.stringify(ph)} ${lg.join(' | ')}`);
    assert.ok(Date.now() - t0 < 2000 && !lg.some((m) => /non conferma/.test(m)), 'arriva senza aspettare lo scadere');
    // salvataggio dopo il telecomando: si salva la posizione vera, non quella ricordata
    await lk.request('ir', ['pan=55', 'tilt=-5', 'zoom=250']);
    const sp = await c.getPosition();
    assert.deepStrictEqual([sp.pan, sp.tilt, sp.zoom], [55, -5, 250]);
    await c.disconnect();
    ok('richiamo con letture vere e salvataggio dopo il telecomando');
  }

  // C. fuoco cambiato dal telecomando (tasto FOCUS manual): il richiamo rimette l'automatico
  {
    const { lk, c, phys } = await real({ FAKE_UVC_READS: 'phys' });
    await c.gotoPosition(P, 1);
    await lk.request('ir', ['focusMode=manual']);
    await c.gotoPosition(P, 1);
    assert.strictEqual((await phys()).focusMode, 'continuous');
    await c.disconnect();
    ok('richiamo: il modo del fuoco si manda sempre');
  }

  // D. clic: un impulso a velocità sotto la soglia di partenza non muove la Tenveo; il clic deve muoverla
  {
    const { c, phys } = await real({ FAKE_UVC_REL_START_MS: '200' });
    assert.ok(c._relOn());
    const p0 = await phys();
    c.stepMove(1, 0);
    await sleep(400);
    let p1 = await phys();
    assert.ok(p1.pan - p0.pan >= 1 && p1.pan - p0.pan <= 2, `il clic muove poco ma muove: ${p0.pan} -> ${p1.pan}`);
    c.stepMove(0, -1);
    await sleep(400);
    p1 = await phys();
    assert.ok(p1.tilt < p0.tilt, 'anche in altezza');
    await c.disconnect();
    ok('clic delle frecce: passo assoluto minimo, la camera si muove');
  }

  // E. Lento tenuto premuto con una camera la cui velocità minima è alta: deve restare lento
  {
    const { lk, c, phys } = await real({ FAKE_UVC_REL_FLOOR: '10' });
    const before = (await lk.request('debug')).relLog.length;
    const p0 = await phys();
    c.move(0.02, 0);
    await sleep(1000);
    c.move(0, 0);
    await sleep(150);
    const p1 = await phys();
    const dlog = (await lk.request('debug')).relLog.slice(before);
    assert.ok(p1.pan - p0.pan >= 2 && p1.pan - p0.pan <= 8, `Lento: ${p1.pan - p0.pan} unità in 1 s`);
    assert.ok(dlog.every((v) => !v.pan && !v.tilt), `Lento senza comandi a velocità: ${JSON.stringify(dlog)}`);
    const p2 = await phys();
    await sleep(400);
    assert.strictEqual((await phys()).pan, p2.pan, 'fermo al rilascio');
    // Veloce: comando a velocità continuo come prima
    c.move(0.12, 0);
    await sleep(300);
    c.stopAll();
    await sleep(100);
    const d2 = await lk.request('debug');
    assert.ok(d2.relLog.some((v) => v.pan > 0), 'Veloce usa il comando a velocità');
    assert.ok(d2.rel.pan === 0 && d2.rel.tilt === 0, 'STOP lo ferma');
    // STOP durante il Lento: nessun altro passo
    c.move(-0.02, 0);
    await sleep(250);
    c.stopAll();
    const p3 = await phys();
    await sleep(500);
    assert.strictEqual((await phys()).pan, p3.pan, 'STOP ferma il Lento');
    await c.disconnect();
    ok('Lento tenuto: passi minimi, più lento della velocità minima della camera');
  }

  // F. camera che si muove davvero solo a multipli di 3 (griglia più fine del suo passo vero)
  {
    const { c, lg, phys } = await real({ FAKE_UVC_REL: '0', FAKE_UVC_QUANTUM: '3', FAKE_UVC_READS: 'phys' });
    const p0 = await phys();
    await c.stepMove(1, 0);
    const p1 = await phys();
    assert.ok(p1.pan > p0.pan, `il primo clic muove: ${p0.pan} -> ${p1.pan}`);
    assert.ok(lg.some((m) => /passo/.test(m)), lg.join(' | '));
    await c.stepMove(1, 0);
    const p2 = await phys();
    assert.ok(p2.pan > p1.pan, `anche il secondo, col passo ricordato: ${p1.pan} -> ${p2.pan}`);
    await c.disconnect();
    ok('clic con passo vero più grosso: il passo cresce finché la camera si muove e si ricorda');
  }

  // --- camera che rifiuta i comandi a velocità: si torna ai passi assoluti
  l = link('ptz', 'refuse');
  cam = new UvcCamera({ label: 'USB Camera (1bcf:2c99)', link: l, timing: TIMING });
  const logs2 = [];
  cam.on('log', (m) => logs2.push(m));
  await cam.connect();
  await sleep(100);
  cam.move(0.12, 0); // Veloce: rifiutato, avviso e passi assoluti da qui in poi
  await sleep(100);
  cam.move(0, 0);
  assert.ok(!cam._relOn() && logs2.some((m) => /rifiutato/.test(m)), logs2.join(' | '));
  await sleep(50);
  const r0 = await l.settings();
  await cam.stepMove(1, 0);
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
