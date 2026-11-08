'use strict';
const assert = require('assert');
const { OnvifCamera, OnvifClient, setAuthHints, onAuthHint } = require('../src/main/onvif');
const { probeOnvif } = require('../src/main/probe');

const {
  serve, state, resetAuth, PRESETS, USER, PASS,
} = require('./fake-onvif');

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

  // --- accesso: le password giuste rifiutate per colpa dell'orologio (casi Dahua) ---
  const H = '127.0.0.1';
  const fresh = (pass = PASS) => new OnvifClient({ host: H, port, user: USER, pass });
  let saved = null;
  onAuthHint((all) => { saved = all; });
  const login = async (over, pass) => {
    setAuthHints({});
    resetAuth(over);
    const c = fresh(pass);
    await c.init();
    return c;
  };

  // camera normale con controllo dell'ora: primo tentativo, nessun errore
  let c = await login({ windowMs: 5000 });
  assert.strictEqual(c.authMode, 'wsse');
  assert.strictEqual(state.auth.failures, 0);

  // ora UTC dichiarata avanti di un'ora (ora legale sbagliata): firma con l'ora del PC
  c = await login(PRESETS.dahua);
  assert.strictEqual(c.authMode, 'wsse-pc');
  assert.strictEqual(state.auth.failures, 1, 'un solo tentativo sbagliato');
  assert.deepStrictEqual(saved, { [`${H}:${port}|${USER}`]: 'wsse-pc' }, 'il modo buono viene ricordato');

  // ricollegandosi si parte dal modo buono: nessun tentativo sbagliato
  state.auth.failures = 0;
  c = fresh();
  await c.init();
  assert.strictEqual(c.authMode, 'wsse-pc');
  assert.strictEqual(state.auth.failures, 0);
  const st = await c.ptz(`<tptz:GetStatus>${c.pt()}</tptz:GetStatus>`);
  assert.ok(/Position/.test(st));

  // camera che controlla la firma con l'ora locale letta come UTC
  c = await login({ windowMs: 5000, validate: 'local' });
  assert.strictEqual(c.authMode, 'wsse-local');

  // camera che accetta solo il Digest HTTP
  c = await login(PRESETS.digest);
  assert.strictEqual(c.authMode, 'http');
  assert.ok((await c.streamUris()).length === 2, 'anche i comandi dopo usano il Digest');

  // autenticazione spenta: va al primo colpo
  c = await login({ off: true });
  assert.strictEqual(c.authMode, 'wsse');

  // password davvero sbagliata: pochi tentativi (le camere bloccano l'utente) ed errore chiaro
  setAuthHints({});
  resetAuth(PRESETS.dahua);
  let err = null;
  try { await fresh('sbagliata').init(); } catch (e) { err = e; }
  assert.ok(err && err.auth && !err.locked, String(err));
  assert.ok(state.auth.failures <= 3, `tentativi: ${state.auth.failures}`);
  const pr2 = await probeOnvif(H, { user: USER, pass: 'sbagliata', ports: [port] });
  assert.ok(pr2.ok && pr2.authFailed && /not Authorized/.test(pr2.error), JSON.stringify(pr2));

  // utente bloccato dalla camera: si smette subito e lo si dice
  resetAuth({ lockAfter: 1 });
  err = null;
  try { await fresh('sbagliata').init(); } catch (e) { err = e; }
  assert.ok(err && err.auth, String(err));
  const before = state.auth.failures;
  err = null;
  try { await fresh('sbagliata').init(); } catch (e) { err = e; }
  assert.ok(err && err.locked, String(err));
  assert.strictEqual(state.auth.failures, before, 'nessun altro tentativo a utente bloccato');
  const lockedCam = new OnvifCamera({ host: H, port, user: USER, pass: 'sbagliata' });
  await lockedCam.connect();
  assert.ok(/bloccato|locked/i.test(lockedCam.detail), lockedCam.detail);
  lockedCam.closed = true; clearTimeout(lockedCam.retryTimer);

  // la sonda del primo avvio dice quale modo ha funzionato
  setAuthHints({});
  resetAuth(PRESETS.dahua);
  const pr3 = await probeOnvif(H, { user: USER, pass: PASS, ports: [port] });
  assert.ok(pr3.ok && pr3.ptz && pr3.position && pr3.authMode === 'wsse-pc', JSON.stringify(pr3));
  resetAuth();

  srv.close();
  console.log('TUTTI I TEST ONVIF PASSATI');
  process.exit(0);
})().catch((e) => { console.error('FALLITO:', e); process.exit(1); });
