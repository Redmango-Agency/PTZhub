'use strict';
// Centro operativo + collegamento esterno con una telecamera VISCA simulata
const assert = require('assert');
const http = require('http');
const { createFakeCamera } = require('./fake-visca');
const { ViscaCamera } = require('../src/main/visca');
const { Hub } = require('../src/main/hub');
const { ControlServer } = require('../src/main/control');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 18765;
const TOKEN = 'chiave-di-prova';

function req(path, { host = `127.0.0.1:${PORT}`, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: { Host: host } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(body.toString()); } catch (_) { /* non json */ }
        resolve({ status: res.statusCode, type: res.headers['content-type'], body, json });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

(async () => {
  const fake = createFakeCamera({ udpPort: 11400, tcpPort: 15800, sonyPort: 15500 });
  await sleep(100);
  const cam = new ViscaCamera({ host: '127.0.0.1', port: 11400, mode: 'udp' });
  await cam.connect();
  await sleep(200);

  const pos = (pan, tilt, zoom) => ({ kind: 'visca', pan: { raw: pan, digits: 4 }, tilt: { raw: tilt, digits: 4 }, zoom, focusAuto: true, focus: null });
  const store = {
    settings: { camera: { host: '127.0.0.1', protocol: 'visca-udp' }, recallSpeed: 0.7, moveSpeed: 0.6 },
    presets: [
      { id: 'aaa', name: 'Palco', pos: pos(0x100, 0x10, 0x1000), thumb: `data:image/jpeg;base64,${Buffer.from('JPEGDATA').toString('base64')}`, updatedAt: '1' },
      { id: 'bbb', name: 'Relatore', pos: pos(0x200, 0x20, 0x2000) },
      { id: 'ccc', name: 'Pubblico', pos: pos(0x300, 0x30, 0x3000) },
    ],
  };
  const hub = new Hub({ store, getCamera: () => cam, getCamStatus: () => ({ state: 'connected', detail: '' }) });
  const server = new ControlServer(hub);
  await server.start({ port: PORT, lan: false, token: TOKEN });
  assert.strictEqual(server.status.state, 'on');
  const k = `k=${TOKEN}`;

  // sicurezza: chiave e nome host
  assert.strictEqual((await req('/api/state')).status, 401, 'senza chiave');
  assert.strictEqual((await req('/api/state?k=sbagliata')).status, 401, 'chiave errata');
  assert.strictEqual((await req(`/api/state?${k}`, { host: 'attaccante.example:18765' })).status, 403, 'host estraneo (DNS rebinding)');
  assert.strictEqual((await req('/obs')).status, 401, 'pannello senza chiave');
  const page = await req(`/obs?${k}`);
  assert.strictEqual(page.status, 200);
  assert.ok(/obs\.js/.test(page.body.toString()), 'pagina del pannello OBS');
  assert.strictEqual((await req('/obs.js')).status, 200);
  assert.strictEqual((await req('/i18n.js')).status, 200);

  // stato
  const st = await req(`/api/state?${k}`);
  assert.strictEqual(st.json.presets.length, 3);
  assert.strictEqual(st.json.presets[0].name, 'Palco');
  assert.ok(st.json.lang);

  // eventi in tempo reale (SSE)
  const events = [];
  const sse = http.get({ host: '127.0.0.1', port: PORT, path: `/api/events?${k}`, headers: { Host: `127.0.0.1:${PORT}` } }, (res) => {
    res.on('data', (c) => events.push(c.toString()));
  });
  await sleep(150);

  // richiamo per numero (Stream Deck: http://127.0.0.1:8765/api/recall/2?k=...)
  let r = await req(`/api/recall/2?${k}`);
  assert.ok(r.json.ok, JSON.stringify(r.json));
  await sleep(150);
  assert.strictEqual(fake.state.pan, 0x200);
  assert.strictEqual(fake.state.zoom, 0x2000);
  assert.strictEqual(hub.activeId, 'bbb');

  // richiamo per identificativo, successiva/precedente con giro
  r = await req(`/api/recall/id/ccc?${k}`, { method: 'POST' });
  assert.ok(r.json.ok);
  await req(`/api/next?${k}`); await sleep(120);
  assert.strictEqual(hub.activeId, 'aaa', 'dopo l’ultima torna alla prima');
  await req(`/api/prev?${k}`); await sleep(120);
  assert.strictEqual(hub.activeId, 'ccc');
  assert.strictEqual(fake.state.pan, 0x300);

  // inquadratura inesistente → errore leggibile
  r = await req(`/api/recall/9?${k}`);
  assert.strictEqual(r.status, 409);
  assert.ok(r.json.error);

  // durante la modifica di un'inquadratura i richiami esterni sono bloccati
  hub.setEditing(true);
  r = await req(`/api/recall/1?${k}`);
  assert.strictEqual(r.status, 409, 'bloccato durante la modifica');
  hub.setEditing(false);

  // impulso: si muove e si ferma da solo
  const before = fake.state.log.length;
  r = await req(`/api/nudge/right?${k}&ms=150`);
  assert.ok(r.json.ok);
  await sleep(350);
  const sent = fake.state.log.slice(before);
  assert.ok(sent.some((l) => /^81 01 06 01 \w\w \w\w 02 03 ff$/.test(l)), `movimento a destra: ${sent}`);
  assert.strictEqual(sent[sent.length - 1].startsWith('81 01 06 01') && sent[sent.length - 1].endsWith('03 03 ff'), true, 'si ferma da solo');

  // movimento continuo da OBS senza rinnovo: arresto di sicurezza dopo ~700 ms
  const b2 = fake.state.log.length;
  await req(`/api/move?${k}&x=0.5&y=0&z=0`);
  await sleep(1000);
  const s2 = fake.state.log.slice(b2);
  assert.ok(s2.some((l) => l.endsWith('03 03 ff')), `stop automatico: ${s2}`);

  // zoom a impulso e funzione generica per nome
  r = await req(`/api/zoom/in?${k}&ms=100`);
  assert.ok(r.json.ok);
  r = await req(`/api/run/preset:aaa?${k}`);
  assert.ok(r.json.ok);
  await sleep(120);
  assert.strictEqual(hub.activeId, 'aaa');
  r = await req(`/api/run/sconosciuto?${k}`);
  assert.strictEqual(r.status, 409);

  // miniatura
  const th = await req(`/api/presets/aaa/thumb?${k}`);
  assert.strictEqual(th.status, 200);
  assert.strictEqual(th.type, 'image/jpeg');
  assert.strictEqual(th.body.toString(), 'JPEGDATA');
  assert.strictEqual((await req(`/api/presets/bbb/thumb?${k}`)).status, 404);

  // STOP e Home
  assert.ok((await req(`/api/stop?${k}`)).json.ok);
  assert.ok((await req(`/api/home?${k}`)).json.ok);
  assert.strictEqual(hub.activeId, null);

  const evText = events.join('');
  assert.ok((evText.match(/event: state/g) || []).length >= 3, 'eventi di stato inviati');
  assert.ok(/"activeId":"bbb"/.test(evText), 'il cambio di inquadratura arriva in tempo reale');

  // indirizzo con codifica rotta: risposta 400, niente richiesta appesa
  r = await req(`/api/recall/id/%E0%A4%A?${k}`);
  assert.strictEqual(r.status, 400);

  // durante la modifica anche Home e impulsi da fuori aspettano; STOP passa sempre
  hub.setEditing(true);
  assert.strictEqual((await req(`/api/home?${k}`)).status, 409);
  assert.strictEqual((await req(`/api/nudge/up?${k}`)).status, 409);
  assert.strictEqual((await req(`/api/run/home?${k}`)).status, 409);
  assert.ok((await req(`/api/stop?${k}`)).json.ok);
  hub.setEditing(false);

  // movimenti del pannello OBS fuori ordine: quello vecchio si scarta
  await sleep(450); // fuori dalla pausa dopo STOP
  r = await req(`/api/move?${k}&x=0.4&y=0&z=0&c=dock1&s=5`);
  assert.ok(r.json.ok && !r.json.stale);
  r = await req(`/api/move?${k}&x=0&y=0&z=0&c=dock1&s=6`);
  assert.ok(r.json.ok && !r.json.stale);
  r = await req(`/api/move?${k}&x=0.4&y=0&z=0&c=dock1&s=5`);
  assert.ok(r.json.stale, 'movimento arrivato dopo il rilascio');
  assert.strictEqual(hub.remoteMoving, false);

  // stato: activeIndex conta da 1 come /api/recall/<n>
  await req(`/api/recall/2?${k}`);
  await sleep(150);
  assert.strictEqual((await req(`/api/state?${k}`)).json.activeIndex, 2);

  // due riavvii insieme (nuova chiave + impostazioni salvate): resta un solo server, quello giusto
  const a1 = server.start({ port: PORT, lan: false, token: 'vecchia' });
  const a2 = server.start({ port: PORT, lan: false, token: TOKEN });
  await Promise.all([a1, a2]);
  assert.strictEqual(server.status.state, 'on');
  assert.strictEqual((await req(`/api/state?${k}`)).status, 200);
  assert.strictEqual((await req('/api/state?k=vecchia')).status, 401);

  // senza chiave configurata non entra nessuno
  const empty = new ControlServer(hub);
  await empty.start({ port: PORT + 1, lan: false, token: '' });
  const er = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: PORT + 1, path: '/api/state', headers: { Host: `127.0.0.1:${PORT + 1}` } }, (res) => { res.resume(); resolve(res.statusCode); });
  });
  assert.strictEqual(er, 401);
  await empty.stop();

  // porta già occupata: errore chiaro
  const other = new ControlServer(hub);
  await other.start({ port: PORT, lan: false, token: TOKEN });
  assert.strictEqual(other.status.state, 'error');
  assert.ok(/18765/.test(other.status.detail), other.status.detail);
  await other.stop();

  sse.destroy();
  await server.stop();
  await cam.disconnect();
  fake.close();
  console.log('TUTTI I TEST DEL COLLEGAMENTO ESTERNO PASSATI');
  process.exit(0);
})().catch((e) => { console.error('FALLITO:', e); process.exit(1); });
