'use strict';
// Driver USB (UVC) con un track finto: incrementi, limiti, STOP, richiamo, annullamento,
// camera senza pan/tilt/zoom, camera occupata o scollegata, centro operativo.
const assert = require('assert');
const { EventEmitter } = require('events');
const { UvcCamera } = require('../src/main/uvc');
const { analyzeCaps, quantize, classifyError } = require('../src/shared/uvc-caps');
const { Hub } = require('../src/main/hub');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const ok = (name) => { pass += 1; console.log(`  ok  ${name}`); };

// Track finto con le regole di MediaStreamTrack: un insieme «advanced» che non si può
// soddisfare (valore fuori dai limiti, asse che non c'è) viene ignorato per intero.
class FakeTrack {
  constructor(caps, settings) {
    this.caps = caps;
    this.cur = { ...settings };
    this.readyState = 'live';
  }

  getCapabilities() { return JSON.parse(JSON.stringify(this.caps)); }

  getSettings() { return { ...this.cur }; }

  async applyConstraints(c) {
    for (const set of (c && c.advanced) || []) {
      const okSet = Object.entries(set).every(([k, v]) => {
        const cap = this.caps[k];
        if (!cap) return false;
        if (Array.isArray(cap)) return cap.includes(v);
        return typeof v === 'number' && v >= cap.min && v <= cap.max;
      });
      if (okSet) Object.assign(this.cur, set);
      else this.ignored = (this.ignored || 0) + 1;
    }
  }
}

// collegamento finto (come la finestra nascosta): apre il track e gli passa i valori
class FakeLink extends EventEmitter {
  constructor({ caps = PTZ_CAPS, settings = START, openError = null, applyDelay = 0 } = {}) {
    super();
    this.caps = caps;
    this.start = settings;
    this.openError = openError;
    this.applyDelay = applyDelay;
    this.applied = [];
    this.opens = 0;
    this.closes = 0;
    this.inflight = 0;
    this.maxInflight = 0;
    this.track = null;
  }

  async open() {
    this.opens += 1;
    if (this.openError) {
      const e = new Error(this.openError.message || this.openError.name);
      e.name = this.openError.name;
      throw e;
    }
    this.track = new FakeTrack(this.caps, this.start);
    return { deviceId: 'cam-1', label: 'Camera finta', caps: this.track.getCapabilities(), settings: this.track.getSettings() };
  }

  async apply(v) {
    this.inflight += 1;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    try {
      if (this.applyDelay) await sleep(this.applyDelay);
      if (!this.track) { const e = new Error('no track'); e.name = 'NotFoundError'; throw e; }
      this.applied.push({ ...v });
      await this.track.applyConstraints({ advanced: [v] });
      return this.track.getSettings();
    } finally {
      this.inflight -= 1;
    }
  }

  async settings() { return this.track.getSettings(); }

  async close() { this.closes += 1; this.track = null; }

  destroy() { this.destroyed = true; }

  get cur() { return this.track ? this.track.cur : null; }
}

const PTZ_CAPS = {
  pan: { min: -170, max: 170, step: 1 },
  tilt: { min: -30, max: 90, step: 1 },
  zoom: { min: 100, max: 400, step: 1 },
  focusMode: ['manual', 'continuous', 'single-shot'],
  focusDistance: { min: 0, max: 100, step: 1 },
  width: { min: 1, max: 1920 },
};
const START = { pan: 0, tilt: 0, zoom: 100, focusMode: 'continuous', focusDistance: 50 };

// tempi accorciati: pan/tilt tutta la corsa (340) in 0,5 s alla velocità 1
const TIMING = { tickMs: 10, ptFullS: 0.5, zoomFullS: 0.5, focusFullS: 0.5, recallFullS: 0.3, retryMs: 60 };

async function makeCam(linkOpts, camOpts = {}) {
  const link = new FakeLink(linkOpts);
  const cam = new UvcCamera({ deviceId: 'cam-1', label: 'Camera finta', link, timing: TIMING, ...camOpts });
  const statuses = [];
  const logs = [];
  cam.on('status', (s) => statuses.push(s));
  cam.on('log', (m) => logs.push(m));
  await cam.connect();
  return { cam, link, statuses, logs };
}

const onGrid = (v, min, step) => Math.abs(((v - min) / step) - Math.round((v - min) / step)) < 1e-9;

(async () => {
  // 0. capacità ed errori
  const a = analyzeCaps(PTZ_CAPS);
  assert.ok(a.pan && a.tilt && a.zoom && a.focusDistance && a.move && a.any);
  const z = analyzeCaps({ zoom: { min: 0, max: 10, step: 1 } });
  assert.ok(!z.move && z.any && !z.pan && z.zoom);
  const none = analyzeCaps({ width: { min: 1, max: 1920 }, focusMode: ['continuous'], focusDistance: { min: 0, max: 1 } });
  assert.ok(!none.any && !none.focusDistance, 'senza fuoco manuale la distanza non serve');
  assert.ok(!analyzeCaps({ pan: { min: 5, max: 5 } }).pan, 'intervallo vuoto = asse assente');
  assert.strictEqual(quantize({ min: 100, max: 400, step: 3 }, 401), 400);
  assert.strictEqual(quantize({ min: 100, max: 400, step: 7 }, 401), 394, 'mai oltre il massimo');
  assert.strictEqual(quantize({ min: 100, max: 400, step: 7 }, 105), 107);
  assert.strictEqual(quantize({ min: -648000, max: 648000, step: 3600 }, 5000), 3600);
  assert.strictEqual(classifyError({ name: 'NotReadableError' }), 'busy');
  assert.strictEqual(classifyError({ name: 'OverconstrainedError' }), 'notfound');
  assert.strictEqual(classifyError({ name: 'NotAllowedError' }), 'denied');
  ok('capacità, griglia della camera, cause degli errori');

  // 1. collegamento: camera con pan, tilt e zoom
  let { cam, link, statuses } = await makeCam();
  assert.strictEqual(cam.state, 'connected');
  assert.deepStrictEqual(statuses.map((s) => s.state), ['connecting', 'connected']);
  ok('camera con pan/tilt/zoom: connessa');

  // 2. movimento continuo: la posizione cresce con il tempo e con la velocità, sulla griglia
  cam.move(0.5, 0);
  await sleep(150);
  cam.move(0, 0);
  const p1 = link.cur.pan;
  assert.ok(p1 > 20 && p1 < 130, `pan dopo 150 ms a metà velocità: ${p1}`);
  assert.ok(link.applied.every((v) => v.pan === undefined || Number.isInteger(v.pan)), 'valori sulla griglia (passo 1)');
  assert.strictEqual(link.track.ignored || 0, 0, 'nessun valore fuori dai limiti');
  // STOP: gli incrementi si fermano subito
  await sleep(30);
  const n = link.applied.length;
  await sleep(120);
  assert.strictEqual(link.applied.length, n, 'dopo lo stop non parte più niente');
  ok(`pan continuo a velocità proporzionale (${p1}) e stop immediato`);

  // 3. limiti: il pan si ferma al massimo e al minimo, il tilt verso l'alto
  cam.move(1, 1);
  await sleep(700);
  assert.strictEqual(link.cur.pan, 170);
  assert.strictEqual(link.cur.tilt, 90);
  cam.move(-1, -1);
  await sleep(900);
  cam.stopAll();
  assert.strictEqual(link.cur.pan, -170);
  assert.strictEqual(link.cur.tilt, -30);
  assert.strictEqual(link.track.ignored || 0, 0);
  ok('limiti min/max rispettati (pan ±170, tilt −30…90)');

  // 4. zoom continuo e fuoco: zoom(0) ferma; il fuoco passa in manuale e si muove
  cam.zoom(1);
  await sleep(120);
  cam.zoom(0);
  const z1 = link.cur.zoom;
  assert.ok(z1 > 140 && z1 < 260, `zoom ${z1}`);
  await sleep(80);
  assert.strictEqual(link.cur.zoom, z1);
  cam.focus(-1);
  await sleep(100);
  cam.focus(0);
  assert.strictEqual(link.cur.focusMode, 'manual');
  assert.ok(link.cur.focusDistance < 50, `fuoco ${link.cur.focusDistance}`);
  cam.setFocusAuto(true);
  await sleep(20);
  assert.strictEqual(link.cur.focusMode, 'continuous');
  cam.focusOnePush();
  await sleep(20);
  assert.strictEqual(link.cur.focusMode, 'single-shot');
  ok('zoom continuo con stop; fuoco manuale, automatico e rapido');

  // 5. posizione letta e richiamo esatto (veloce = un solo comando; lento = a passi)
  cam.move(0.6, 0.4);
  cam.zoom(0.5);
  await sleep(120);
  cam.stopAll();
  await sleep(30);
  const pos = await cam.getPosition();
  assert.strictEqual(pos.kind, 'usb');
  assert.deepStrictEqual([pos.pan, pos.tilt, pos.zoom], [link.cur.pan, link.cur.tilt, link.cur.zoom]);
  cam.move(-1, -1);
  cam.zoom(-1);
  await sleep(150);
  cam.stopAll();
  await sleep(20);
  let before = link.applied.length;
  await cam.gotoPosition(pos, 1);
  assert.deepStrictEqual([link.cur.pan, link.cur.tilt, link.cur.zoom], [pos.pan, pos.tilt, pos.zoom]);
  const moves = (from) => link.applied.slice(from).filter((v) => v.pan !== undefined).length;
  assert.strictEqual(moves(before), 1, 'velocità 100%: un solo comando');
  await cam.gotoPosition({ kind: 'usb', pan: -100, tilt: 0, zoom: 100, focusAuto: true }, 1);
  before = link.applied.length;
  await cam.gotoPosition(pos, 0.5);
  assert.deepStrictEqual([link.cur.pan, link.cur.tilt, link.cur.zoom], [pos.pan, pos.tilt, pos.zoom]);
  assert.ok(moves(before) > 3, 'velocità 50%: a passi');
  ok(`richiamo esatto pan ${pos.pan} tilt ${pos.tilt} zoom ${pos.zoom}, veloce e a passi`);

  // 6. fuoco salvato in manuale: al richiamo torna la distanza
  cam.setFocusAuto(false);
  cam.focus(1);
  await sleep(60);
  cam.focus(0);
  await sleep(20);
  const pf = await cam.getPosition();
  assert.strictEqual(pf.focusAuto, false);
  assert.ok(typeof pf.focus === 'number');
  cam.setFocusAuto(true);
  await sleep(20);
  await cam.gotoPosition(pf, 1);
  assert.strictEqual(link.cur.focusMode, 'manual');
  assert.strictEqual(link.cur.focusDistance, pf.focus);
  await cam.gotoPosition({ ...pf, focusAuto: true, focus: null }, 1);
  assert.strictEqual(link.cur.focusMode, 'continuous');
  ok('fuoco manuale salvato e richiamato');

  // 7. annullamento: cancelled() durante il richiamo lento ferma i passi che mancano
  await cam.gotoPosition({ kind: 'usb', pan: -170, tilt: -30, zoom: 100 }, 1);
  let stopNow = false;
  const pr = cam.gotoPosition({ kind: 'usb', pan: 170, tilt: 90, zoom: 400 }, 0.2, () => stopNow);
  await sleep(120);
  stopNow = true;
  await assert.rejects(pr, (e) => e.code === 'CANCELLED');
  const mid = { ...link.cur };
  await sleep(100);
  assert.deepStrictEqual(link.cur, mid, 'dopo l\'annullamento la camera non riceve altro');
  assert.ok(mid.pan > -170 && mid.pan < 170, `fermo a metà strada: ${mid.pan}`);
  ok(`richiamo annullato a metà strada (pan ${mid.pan})`);

  // 8. STOP del driver e comando manuale interrompono un richiamo; Home
  let pr2 = cam.gotoPosition({ kind: 'usb', pan: -170, tilt: 0, zoom: 100 }, 0.2);
  await sleep(60);
  cam.stopAll();
  await assert.rejects(pr2, (e) => e.code === 'CANCELLED');
  pr2 = cam.gotoPosition({ kind: 'usb', pan: 170, tilt: 0, zoom: 100 }, 0.2);
  await sleep(60);
  cam.move(0.3, 0);
  await assert.rejects(pr2, (e) => e.code === 'CANCELLED');
  cam.move(0, 0);
  await cam.home();
  assert.deepStrictEqual([link.cur.pan, link.cur.tilt, link.cur.zoom], [0, 0, 100]);
  ok('STOP e joystick fermano il richiamo; Home = pan 0, tilt 0, zoom minimo');

  // 9. inquadrature di altri protocolli e memorie della camera: errori chiari
  await assert.rejects(cam.gotoPosition({ kind: 'visca', pan: { raw: 1, digits: 4 } }), /USB/);
  await assert.rejects(cam.saveSlot(10), /memorie/);
  await assert.rejects(cam.recallSlot(10), /memorie/);
  ok('inquadratura VISCA e memorie della camera rifiutate con un messaggio chiaro');

  // 10. camera lenta: un solo comando alla volta, conta solo l'ultimo valore
  await cam.disconnect();
  assert.ok(link.destroyed, 'la finestra nascosta si chiude con la camera');
  ({ cam, link } = await makeCam({ applyDelay: 45 }));
  cam.move(1, 0);
  await sleep(300);
  cam.move(0, 0);
  await sleep(120);
  assert.strictEqual(link.maxInflight, 1);
  assert.ok(link.applied.length < 12, `comandi uniti: ${link.applied.length}`);
  assert.ok(link.cur.pan > 100, `la camera è comunque arrivata avanti: ${link.cur.pan}`);
  await cam.disconnect();
  ok(`camera lenta: un comando alla volta (${link.applied.length} invece di ~30)`);

  // 11. camera senza pan/tilt/zoom via USB: messaggio chiaro, camera rilasciata, comandi innocui
  ({ cam, link, statuses } = await makeCam({ caps: { width: { min: 1, max: 1920 }, focusMode: ['continuous'] }, settings: {} }));
  assert.strictEqual(cam.state, 'error');
  assert.strictEqual(statuses[statuses.length - 1].code, 'noptz');
  assert.match(cam.detail, /non accetta movimenti via USB.*VISCA\/ONVIF/);
  assert.strictEqual(link.closes, 1, 'camera rilasciata subito');
  cam.move(1, 1); cam.zoom(1); cam.focus(1); cam.setFocusAuto(false); cam.focusOnePush(); cam.stopAll();
  await cam.home();
  await sleep(50);
  assert.strictEqual(link.applied.length, 0);
  await assert.rejects(cam.getPosition(), /non accetta movimenti/);
  await assert.rejects(cam.gotoPosition({ kind: 'usb', pan: 0 }), /non accetta movimenti/);
  await sleep(150);
  assert.strictEqual(link.opens, 1, 'nessun nuovo tentativo: la camera non cambia');
  await cam.disconnect();
  ok('camera senza PTZ: «non accetta movimenti via USB», niente errori dai comandi');

  // 12. solo zoom: si usa lo zoom e lo si dice
  let logs;
  ({ cam, link, statuses, logs } = await makeCam({ caps: { zoom: { min: 0, max: 100, step: 1 } }, settings: { zoom: 0 } }));
  assert.strictEqual(cam.state, 'connected');
  assert.strictEqual(statuses[statuses.length - 1].code, 'zoomonly');
  assert.match(logs.join(' '), /solo lo zoom/);
  cam.move(1, 1);
  await sleep(60);
  assert.strictEqual(link.applied.length, 0, 'pan/tilt ignorati');
  cam.zoom(1);
  await sleep(100);
  cam.zoom(0);
  assert.ok(link.cur.zoom > 0);
  assert.ok(link.applied.every((v) => Object.keys(v).join() === 'zoom'), 'solo valori di zoom');
  const pz = await cam.getPosition();
  assert.deepStrictEqual(Object.keys(pz).filter((k) => ['pan', 'tilt', 'zoom'].includes(k)), ['zoom']);
  await cam.gotoPosition({ kind: 'usb', pan: 10, tilt: 10, zoom: 30 }, 1);
  assert.strictEqual(link.cur.zoom, 30);
  await cam.disconnect();
  ok('camera con solo zoom: connessa, «solo lo zoom», pan/tilt ignorati');

  // 13. camera occupata (NotReadableError): spiegazione con OBS e nuovi tentativi
  ({ cam, link, statuses } = await makeCam({ openError: { name: 'NotReadableError', message: 'Could not start video source' } }));
  assert.strictEqual(cam.state, 'error');
  assert.strictEqual(cam.code, 'busy');
  assert.match(cam.detail, /OBS/);
  await sleep(150);
  assert.ok(link.opens >= 2, 'riprova da sola');
  assert.ok(statuses.filter((s) => s.state === 'connecting').length === 1, 'nei tentativi niente lampeggi');
  link.openError = null; // OBS ha lasciato la camera
  await sleep(250);
  assert.strictEqual(cam.state, 'connected');
  await cam.disconnect();
  ok('camera occupata da un altro programma: messaggio con OBS, poi si collega da sola');

  // 14. camera scollegata durante l'uso: «non risponde», poi torna; richiamo in corso fermato
  ({ cam, link } = await makeCam());
  const pr3 = cam.gotoPosition({ kind: 'usb', pan: 170, tilt: 0, zoom: 100 }, 0.2);
  await sleep(40);
  link.openError = { name: 'NotFoundError', message: 'Requested device not found' };
  link.track = null;
  link.emit('ended');
  await assert.rejects(pr3, /USB scollegato/);
  assert.strictEqual(cam.state, 'error');
  assert.strictEqual(cam.code, 'notfound');
  cam.move(1, 0); // comandi durante l'interruzione: nessun errore
  await sleep(100);
  assert.strictEqual(cam.state, 'error');
  link.openError = null;
  link.emit('devicechange');
  await sleep(700);
  assert.strictEqual(cam.state, 'connected');
  await cam.disconnect();
  ok('camera scollegata: stato «non risponde», riconnessione automatica');

  // 15. centro operativo con la camera USB: richiamo, STOP durante il richiamo, joystick diretto
  ({ cam, link } = await makeCam());
  const store = {
    settings: { camera: { protocol: 'usb', usbDeviceId: 'cam-1', name: 'Camera finta' }, recallSpeed: 0.3, moveSpeed: 0.6 },
    presets: [
      { id: 'a', name: 'A', pos: { kind: 'usb', pan: 120, tilt: 40, zoom: 300, focusAuto: true } },
      { id: 'b', name: 'B', pos: { kind: 'usb', pan: -120, tilt: -10, zoom: 150, focusAuto: true } },
    ],
  };
  const hub = new Hub({ store, getCamera: () => cam, getCamStatus: () => ({ state: cam.state, detail: cam.detail }) });
  assert.strictEqual(hub.state().camera.host, 'USB');
  assert.strictEqual((await hub.recallId('a', 1)).id, 'a');
  assert.deepStrictEqual([link.cur.pan, link.cur.tilt, link.cur.zoom], [120, 40, 300]);
  assert.strictEqual(hub.activeId, 'a');
  let rp = hub.recallId('b');
  await sleep(80);
  hub.stop();
  assert.strictEqual(await rp, null);
  assert.strictEqual(hub.activeId, 'a', 'dopo STOP «B» non diventa attiva');
  rp = hub.recallId('b');
  await sleep(80);
  cam.move(0.5, 0); // joystick della Regia: arriva direttamente alla camera
  assert.strictEqual(await rp, null);
  assert.strictEqual(hub.targetId, null, 'niente più «in arrivo»');
  cam.move(0, 0);
  hub.nudge('left', 100);
  await sleep(200);
  hub.zoomPulse('in', 100);
  await sleep(200);
  hub.home();
  await sleep(500);
  assert.deepStrictEqual([link.cur.pan, link.cur.tilt, link.cur.zoom], [0, 0, 100]);
  await cam.disconnect();
  ok('centro operativo: richiamo, STOP, joystick, impulsi e Home con la camera USB');

  console.log(`uvc: ${pass} prove superate`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
