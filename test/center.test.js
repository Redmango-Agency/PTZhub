'use strict';
// «Centra qui»: clic → punto del video vero (bande nere, rotazione), scarto → spostamento in
// unità della camera (zoom, protocolli, inversione), taratura misurata (anche specchiata),
// inseguimento del punto tra due fotogrammi, centro operativo.
const assert = require('assert');
const C = require('../src/shared/center');
const { Hub } = require('../src/main/hub');

let pass = 0;
const ok = (name) => { pass += 1; console.log(`  ok  ${name}`); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

(async () => {
  // 1. clic → video vero: bande nere ai lati, rotazione di 180°
  // anteprima 1000×500 con video 16:9 (dw = 888,9, bande di 55,6 px a sinistra e a destra)
  assert.strictEqual(C.toSource(20, 250, 1000, 500, 1920, 1080), null, 'clic sulla banda nera');
  let p = C.toSource(500, 250, 1000, 500, 1920, 1080);
  assert.ok(near(p.u, 0.5) && near(p.v, 0.5));
  p = C.toSource(55.5556 + 888.889 * 0.75, 125, 1000, 500, 1920, 1080);
  assert.ok(near(p.u, 0.75, 1e-3) && near(p.v, 0.25, 1e-3), JSON.stringify(p));
  const r = C.toSource(55.5556 + 888.889 * 0.75, 125, 1000, 500, 1920, 1080, true);
  assert.ok(near(r.u, 0.25, 1e-3) && near(r.v, 0.75, 1e-3), 'capovolta: punto opposto nel video vero');
  // bande sopra e sotto (video 4:3 in un'anteprima larga): stessa logica
  assert.strictEqual(C.toSource(500, 5, 1000, 1000, 1600, 1200), null);
  ok('clic convertito nel video vero (bande nere, capovolta)');

  // 2. scarto → spostamento: USB in gradi, zoom che stringe il campo visivo
  const axes = { pan: { min: -170, max: 170, step: 1 }, tilt: { min: -30, max: 90, step: 1 }, zoom: { min: 0, max: 100, step: 1 } };
  const wide = C.planStep({ ox: 0.25, oy: 0, pos: { kind: 'usb', pan: 0, tilt: 0, zoom: 0 }, ctx: { axes } });
  assert.ok(near(wide.dPan, 15), `a zoom minimo un quarto d'immagine = 15°: ${wide.dPan}`);
  assert.ok(wide.dTilt === 0); // (anche -0)
  const tele = C.planStep({ ox: 0.25, oy: 0, pos: { kind: 'usb', pan: 0, tilt: 0, zoom: 100 }, ctx: { axes } });
  assert.ok(near(tele.dPan, 1.5), `a zoom massimo 10 volte meno: ${tele.dPan}`);
  assert.ok(tele.bucket === 7 && wide.bucket === 0);
  const down = C.planStep({ ox: 0, oy: 0.25, pos: { kind: 'usb', pan: 0, tilt: 0, zoom: 0 }, ctx: { axes }, aspect: 16 / 9 });
  assert.ok(down.dTilt < 0 && near(down.dTilt, -15 * 9 / 16), `punto in basso = tilt giù: ${down.dTilt}`);
  const inv = C.planStep({ ox: 0.25, oy: 0.25, pos: { kind: 'usb', pan: 0, tilt: 0, zoom: 0 }, ctx: { axes }, invertPan: true, invertTilt: true });
  assert.ok(inv.dPan < 0 && inv.dTilt > 0, 'direzioni invertite nelle impostazioni');
  // camera USB in secondi d'arco (come vuole lo standard UVC)
  const arc = { pan: { min: -612000, max: 612000, step: 3600 }, tilt: { min: -108000, max: 324000, step: 3600 }, zoom: { min: 100, max: 400, step: 1 } };
  const pa = C.planStep({ ox: 0.25, oy: 0, pos: { kind: 'usb', pan: 0, tilt: 0, zoom: 100 }, ctx: { axes: arc } });
  assert.ok(near(pa.dPan, 15 * 3600), `secondi d'arco: ${pa.dPan}`);
  ok('scarto → gradi → unità della camera, con lo zoom e le direzioni invertite');

  // 3. nuova posizione: USB solo gli assi che cambiano, sulla griglia e nei limiti
  let to = C.applyOffset({ kind: 'usb', pan: 160, tilt: 10, zoom: 50, focusAuto: true }, 15.4, 0.2, { axes });
  assert.deepStrictEqual(to, { kind: 'usb', pan: 170 }, 'fermo al limite, tilt invariato non si manda, niente fuoco');
  assert.strictEqual(C.applyOffset({ kind: 'usb', pan: 0, tilt: 0 }, 0.2, 0.1, { axes }), null, 'meno di un passo: niente');
  to = C.applyOffset({ kind: 'usb', pan: 0, tilt: 0, zoom: 1 }, 0, -3.6, { axes });
  assert.deepStrictEqual(to, { kind: 'usb', tilt: -4 });
  // VISCA: valori con segno in complemento a due
  const vpos = { kind: 'visca', pan: { raw: 0xFFF0, digits: 4 }, tilt: { raw: 0x0010, digits: 4 }, zoom: 0x2000, focusAuto: true, focus: null };
  assert.strictEqual(C.viscaSigned(0xFFF0, 4), -16);
  to = C.applyOffset(vpos, 32, -32, {});
  assert.deepStrictEqual([to.pan.raw, to.tilt.raw, to.zoom], [0x0010, 0xFFF0, 0x2000]);
  const v5 = C.applyOffset({ ...vpos, pan: { raw: 0xFFFF0, digits: 5 } }, -16, 0, {});
  assert.strictEqual(v5.pan.raw, 0xFFFE0);
  const vplan = C.planStep({ ox: 0.25, oy: 0, pos: vpos, ctx: {} });
  assert.ok(near(vplan.dPan, 15 / (1 + 9 * 0.5) * 14.4, 1e-6), `VISCA a metà zoom: ${vplan.dPan}`);
  // ONVIF: spazio generico, pan che fa il giro, tilt fermo ai limiti
  to = C.applyOffset({ kind: 'onvif', x: 0.95, y: 0.98, zoom: 0.2 }, 0.1, 0.1, {});
  assert.ok(near(to.x, -0.95, 1e-5) && to.y === 1 && to.zoom === 0.2, JSON.stringify(to));
  const oplan = C.planStep({ ox: 0.25, oy: 0, pos: { kind: 'onvif', x: 0, y: 0, zoom: null }, ctx: {} });
  assert.ok(near(oplan.dPan, 15 / 180));
  ok('nuova posizione per USB, VISCA (con segno) e ONVIF');

  // 4. taratura: dalla misura dello spostamento vero
  assert.strictEqual(C.learnFactor(1, 0.25, -0.25), 1, 'arrivato giusto: fattore invariato');
  assert.strictEqual(C.learnFactor(1, 0.25, -0.125), 2, 'spostato a metà: fattore doppio');
  assert.strictEqual(C.learnFactor(1, 0.25, 0.25), -1, 'immagine specchiata: verso opposto');
  assert.strictEqual(C.learnFactor(2, -0.2, 0.4), 1);
  assert.strictEqual(C.learnFactor(1, 0.25, 0.001), null, 'camera ferma: niente taratura');
  assert.strictEqual(C.learnFactor(1, 0.01, -0.01), null, 'scarto troppo piccolo per misurare');
  // il fattore ricordato si usa nello stesso livello di zoom
  const cal = { pan: { 0: -1 }, tilt: { 0: 0.5 } };
  const c1 = C.planStep({ ox: 0.25, oy: 0.25, pos: { kind: 'usb', pan: 0, tilt: 0, zoom: 0 }, ctx: { axes }, cal });
  assert.ok(near(c1.dPan, -15) && near(c1.dTilt, -15 * 9 / 16 * 0.5) && c1.fPan === -1);
  const c2 = C.planStep({ ox: 0.25, oy: 0, pos: { kind: 'usb', pan: 0, tilt: 0, zoom: 100 }, ctx: { axes }, cal });
  assert.strictEqual(c2.fPan, 1, 'altro livello di zoom: stima pura');
  ok('taratura misurata: più, meno, specchiata, per livello di zoom');

  // 5. inseguimento: il pezzetto cliccato si ritrova nell'immagine spostata
  const W = 160;
  const H = 90;
  const scene = (shiftX, shiftY) => {
    const data = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const X = x + shiftX;
        const Y = y + shiftY;
        // trama con dettagli (come una persona davanti a una parete)
        data[y * W + x] = 128 + 60 * Math.sin(X * 0.21) * Math.cos(Y * 0.17) + 40 * Math.sin((X + 2 * Y) * 0.05)
          + (((X - 60) ** 2 + (Y - 40) ** 2 < 80) ? 70 : 0);
      }
    }
    return { w: W, h: H, data };
  };
  const a = scene(0, 0);
  const tpl = C.patchAt(a, 60 / (W - 1), 40 / (H - 1), 10);
  assert.ok(tpl, 'pezzetto con dettagli');
  const b = scene(25, -12); // la camera è andata a destra e in alto: il punto va a sinistra e in basso
  const m = C.findPatch(b, tpl);
  assert.ok(m.score > 0.95, `somiglianza ${m.score}`);
  assert.ok(near(m.u * (W - 1), 35, 0.6) && near(m.v * (H - 1), 52, 0.6), `ritrovato a ${m.u * (W - 1)}, ${m.v * (H - 1)}`);
  const flat = { w: W, h: H, data: new Float32Array(W * H).fill(200) };
  assert.strictEqual(C.patchAt(flat, 0.5, 0.5, 10), null, 'parete uniforme: niente da inseguire');
  assert.ok(C.meanDiff(a, a) === 0 && C.meanDiff(a, b) > 3);
  ok('inseguimento del punto tra due fotogrammi');

  // 6. centro operativo: legge la posizione, sposta solo pan/tilt, ricorda la taratura per camera
  const log = [];
  const cam = {
    axes,
    stopAll() { log.push('stop'); },
    move() {},
    zoom() {},
    async getPosition() { return { kind: 'usb', pan: 10, tilt: 0, zoom: 0, focusAuto: false, focus: 30 }; },
    async gotoPosition(pos) { log.push(pos); },
  };
  const saved = [];
  const store = {
    settings: { camera: { protocol: 'usb', usbLabel: 'Tenveo (1bcf:2c99)' }, centerCal: {} },
    presets: [],
    saveSettings(part) { saved.push(part); this.settings.centerCal = { ...this.settings.centerCal, ...part.centerCal }; },
  };
  const hub = new Hub({ store, getCamera: () => cam });
  const res = await hub.centerStep(0.25, 0, 16 / 9);
  assert.ok(res.moved && res.bucket === 0 && res.fPan === 1);
  assert.deepStrictEqual(log, ['stop', { kind: 'usb', pan: 25 }], JSON.stringify(log));
  hub.centerLearn({ bucket: 0, pan: -1.2, tilt: null });
  hub.centerLearn({ bucket: 0, pan: 99 }); // valore assurdo: ignorato
  assert.strictEqual(saved.length, 1);
  const key = C.camKey(store.settings.camera);
  assert.deepStrictEqual(store.settings.centerCal[key], { pan: { 0: -1.2 }, tilt: {} });
  log.length = 0;
  await hub.centerStep(0.25, 0, 16 / 9);
  assert.deepStrictEqual(log[1], { kind: 'usb', pan: -8 }, 'usa la taratura ricordata (verso opposto, 1,2 volte)');
  // camera senza posizione
  const hub2 = new Hub({ store, getCamera: () => ({ ...cam, async getPosition() { throw new Error('nessuna risposta'); } }) });
  await assert.rejects(hub2.centerStep(0.2, 0, 16 / 9), /posizione/);
  ok('centro operativo: passo di centratura e taratura per camera');

  console.log(`center: ${pass} test superati`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
