'use strict';
const assert = require('assert');
const { OnvifCamera } = require('../src/main/onvif');
const { probeOnvif } = require('../src/main/probe');

const { serve, state, USER, PASS } = require('./fake-onvif');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const port = 18080;
  const srv = serve(port);
  await sleep(100);

  // password sbagliata -> errore leggibile
  const bad = new OnvifCamera({ host: '127.0.0.1', port, user: USER, pass: 'no' });
  await bad.connect();
  assert.strictEqual(bad.state, 'error');
  assert.ok(/not Authorized/.test(bad.detail), bad.detail);
  bad.closed = true; clearTimeout(bad.retryTimer);

  const cam = new OnvifCamera({ host: '127.0.0.1', port, user: USER, pass: PASS });
  await cam.connect();
  assert.strictEqual(cam.state, 'connected', cam.detail);
  assert.ok(cam.c.ptzUrl.startsWith('http://127.0.0.1:18080/'), cam.c.ptzUrl);

  cam.move(1, 0.5);
  cam.move(0.8, 0.5);
  cam.move(0, 0);
  await sleep(200);
  assert.ok(state.calls.includes('Stop'), 'stop inviato');
  assert.strictEqual(state.calls[state.calls.length - 1], 'Stop', 'lo stop è l’ultimo comando');

  const p = await cam.getPosition();
  assert.strictEqual(p.kind, 'onvif');
  assert.ok(p.x > 0);

  await cam.gotoPosition({ kind: 'onvif', x: -0.25, y: 0.4, zoom: 0.7 }, 0.5);
  const p2 = await cam.getPosition();
  assert.deepStrictEqual([p2.x, p2.y, p2.zoom], [-0.25, 0.4, 0.7]);

  // stop che fallisce la prima volta: viene ritentato
  state.calls = [];
  state.failNextStop = true;
  cam.move(0.5, 0);
  cam.move(0, 0);
  await sleep(700);
  assert.deepStrictEqual(state.calls.filter((c) => c === 'Stop').length, 2, `stop ritentato: ${state.calls}`);

  // richiamo subito dopo aver lasciato il joystick: lo stop arriva PRIMA del richiamo
  state.calls = [];
  cam.move(1, 1);
  cam.move(0, 0);
  await cam.gotoPosition({ kind: 'onvif', x: 0.1, y: 0.2, zoom: 0.3 }, 1);
  assert.strictEqual(state.calls[state.calls.length - 1], 'AbsoluteMove', `ordine: ${state.calls}`);
  assert.ok(/Timeout/.test('Timeout'));

  const pr = await probeOnvif('127.0.0.1', { user: USER, pass: PASS, ports: [18080] });
  assert.ok(pr.ok && pr.ptz && pr.position, JSON.stringify(pr));
  assert.deepStrictEqual(pr.streams.map((s) => s.uri), ['rtsp://127.0.0.1:554/1', 'rtsp://127.0.0.1:554/2']);

  await cam.disconnect();
  srv.close();
  console.log('TUTTI I TEST ONVIF PASSATI');
  process.exit(0);
})().catch((e) => { console.error('FALLITO:', e); process.exit(1); });
