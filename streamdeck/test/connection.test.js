// Collegamento condiviso + disegno dei tasti contro un PTZ Hub finto (SSE, miniature, comandi, 401).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { PtzConnection } from '../src/plugin/connection.js';
import { KeyController } from '../src/plugin/keys.js';
import { PiBridge } from '../src/plugin/pi-bridge.js';
import {
  FakePtzHub, KEY, fakeJpeg, freePort, mockAction, sleep, waitFor,
} from './helpers/fake-ptz.js';

const RING = 'stroke="#FF3B30" stroke-width="6"';
const b64 = (buf) => buf.toString('base64');

async function setup({ key = KEY, hubOpts = {} } = {}) {
  const hub = await new FakePtzHub(hubOpts).start();
  const conn = new PtzConnection({ minDelay: 30, maxDelay: 200, thumbRetryDelay: 50 });
  const keys = new KeyController({ conn, getLang: () => 'it' });
  conn.configure({ host: '127.0.0.1', port: hub.port, key });
  return { hub, conn, keys };
}

async function teardown({ hub, conn }) {
  conn.dispose();
  await hub.stop();
}

test('stato in tempo reale: miniatura, nome, anello rosso che segue activeId, richiamo con la chiave', async () => {
  const ctx = await setup();
  const { hub, conn, keys } = ctx;
  try {
    const a = mockAction('key-a');
    const c = mockAction('key-c');
    keys.add('preset', a, { presetId: 'aaa' });
    keys.add('preset', c, { presetId: 'ccc' });

    await waitFor(() => a.lastSvg().includes('<image'), { what: 'miniatura su A' });
    const svg = a.lastSvg();
    assert.ok(svg.includes(b64(fakeJpeg('aaa1'))), 'la miniatura scaricata è dentro l\'SVG');
    assert.ok(svg.includes('Palco &amp;') && svg.includes('&quot;Coro&quot; &lt;1&gt;'), 'nome con escape');
    assert.ok(!svg.includes(RING), 'nessuna inquadratura attiva');

    // pressione: POST /api/recall/id/aaa con la chiave nell'intestazione
    const r = await keys.press('preset', a, { presetId: 'aaa' });
    assert.equal(r.ok, true);
    const rec = hub.requests.find((q) => q.path === '/api/recall/id/aaa');
    assert.ok(rec, 'richiamo arrivato');
    assert.equal(rec.method, 'POST');
    assert.equal(rec.key, KEY, 'la richiesta porta la chiave');
    assert.equal(rec.host, `127.0.0.1:${hub.port}`, 'Host accettato in modalità locale');
    assert.equal(a.calls.ok, 1, 'showOk');

    // l'anello arriva con l'evento SSE e si sposta quando cambia activeId
    await waitFor(() => a.lastSvg().includes(RING), { what: 'anello su A' });
    hub.setState({ activeId: 'ccc' });
    await waitFor(() => !a.lastSvg().includes(RING) && c.lastSvg().includes(RING), { what: 'anello da A a C' });
    hub.setState({ activeId: null });
    await waitFor(() => !c.lastSvg().includes(RING), { what: 'anello tolto' });

    // niente interrogazioni periodiche: un solo flusso di eventi, nessun /api/state
    assert.equal(hub.count((q) => q.path === '/api/state'), 0);
    assert.equal(hub.count((q) => q.path === '/api/events'), 1);

    // miniature in memoria: riscaricate solo quando cambia v
    assert.equal(hub.count((q) => q.path === '/api/presets/aaa/thumb'), 1);
    const imagesBefore = a.calls.images.length;
    hub.setState({ activeId: 'bbb' });
    await sleep(80);
    assert.equal(hub.count((q) => q.path === '/api/presets/aaa/thumb'), 1, 'stessa v: nessun download');
    assert.equal(a.calls.images.length, imagesBefore, 'immagine invariata: nessun setImage');

    hub.thumbs.set('aaa', fakeJpeg('aaa2'));
    hub.setState({ presets: hub.st.presets.map((p) => (p.id === 'aaa' ? { ...p, name: 'Palco nuovo', v: '2' } : p)) });
    await waitFor(() => a.lastSvg().includes(b64(fakeJpeg('aaa2'))), { what: 'miniatura nuova' });
    assert.equal(hub.count((q) => q.path === '/api/presets/aaa/thumb'), 2);
    assert.ok(a.lastSvg().includes('Palco nuovo'));
    const q2 = hub.requests.filter((q) => q.path === '/api/presets/aaa/thumb').pop();
    assert.equal(q2.query, '?v=2');
  } finally {
    await teardown(ctx);
  }
});

test('miniatura non scaricata al primo colpo: si riprova poco dopo', async () => {
  const ctx = await setup();
  const { hub, keys } = ctx;
  try {
    hub.thumbFailures = 2;
    const a = mockAction('a');
    keys.add('preset', a, { presetId: 'aaa' });
    await waitFor(() => a.lastSvg().includes('Palco'), { what: 'tasto senza miniatura' });
    assert.ok(!a.lastSvg().includes('<image'), 'intanto numero grande');
    await waitFor(() => a.lastSvg().includes(b64(fakeJpeg('aaa1'))), { what: 'miniatura al terzo tentativo' });
    assert.equal(hub.count((q) => q.path === '/api/presets/aaa/thumb'), 3);
  } finally {
    await teardown(ctx);
  }
});

test('inquadratura senza miniatura, eliminata, non scelta', async () => {
  const ctx = await setup();
  const { hub, keys } = ctx;
  try {
    const b = mockAction('b');
    const none = mockAction('none');
    keys.add('preset', b, { presetId: 'bbb' });
    keys.add('preset', none, {});
    await waitFor(() => b.lastSvg().includes('Relatore'), { what: 'tasto B' });
    assert.ok(!b.lastSvg().includes('<image') && b.lastSvg().includes('>2</text>'), 'numero grande senza miniatura');
    assert.ok(none.lastSvg().includes('Scegli'));
    await keys.press('preset', none, {});
    assert.equal(none.calls.alert, 1, 'senza inquadratura: avviso');

    hub.setState({ presets: hub.st.presets.filter((p) => p.id !== 'bbb') });
    await waitFor(() => b.lastSvg().includes('>?</text>'), { what: 'tasto con ?' });
    await keys.press('preset', b, { presetId: 'bbb' });
    assert.equal(b.calls.alert, 1);
    assert.equal(hub.count((q) => q.path.startsWith('/api/recall')), 0, 'nessun richiamo inutile');
  } finally {
    await teardown(ctx);
  }
});

test('modifica in corso: segno sul tasto e avviso alla pressione, senza mandare il richiamo', async () => {
  const ctx = await setup();
  const { hub, keys } = ctx;
  try {
    const a = mockAction('a');
    const stop = mockAction('stop');
    const up = mockAction('up');
    keys.add('preset', a, { presetId: 'aaa' });
    keys.add('command', stop, { command: 'stop' });
    keys.add('command', up, { command: 'nudge:up' });
    await waitFor(() => a.lastSvg().includes('<image'));
    hub.setState({ editing: true });
    await waitFor(() => a.lastSvg().includes('#FF9F0A'), { what: 'matita' });
    assert.ok(up.lastSvg().includes('#FF9F0A'), 'comando sospeso segnato');
    assert.ok(!stop.lastSvg().includes('#FF9F0A'), 'STOP funziona sempre');
    await keys.press('preset', a, { presetId: 'aaa' });
    assert.equal(a.calls.alert, 1);
    assert.equal(hub.count((q) => q.path.startsWith('/api/recall')), 0);
    // i comandi passano da PTZ Hub, che decide: 409 -> avviso, STOP -> ok
    await keys.press('command', up, { command: 'nudge:up' });
    assert.equal(up.calls.alert, 1);
    await keys.press('command', stop, { command: 'stop' });
    assert.equal(stop.calls.ok, 1);
  } finally {
    await teardown(ctx);
  }
});

test('comandi: indirizzo giusto, chiave, showOk / showAlert', async () => {
  const ctx = await setup();
  const { hub, keys } = ctx;
  try {
    const expected = {
      stop: '/api/stop', home: '/api/home', next: '/api/next', prev: '/api/prev', onepush: '/api/onepush',
      'zoom:in': '/api/zoom/in', 'zoom:out': '/api/zoom/out', 'nudge:left': '/api/nudge/left', 'nudge:right': '/api/nudge/right',
    };
    for (const [cmd, path] of Object.entries(expected)) {
      const act = mockAction(`cmd-${cmd}`);
      keys.add('command', act, { command: cmd });
      const r = await keys.press('command', act, { command: cmd });
      assert.equal(r.ok, true, cmd);
      const q = hub.requests.filter((x) => x.path === path).pop();
      assert.ok(q, `${cmd} -> ${path}`);
      assert.equal(q.method, 'POST');
      assert.equal(q.key, KEY);
      assert.equal(act.calls.ok, 1);
    }
    const stopKey = mockAction('s');
    keys.add('command', stopKey, { command: 'stop' });
    await waitFor(() => stopKey.lastSvg().includes('#D70015'));

    // richiamo superato da STOP: niente showOk, niente avviso
    hub.superseded = true;
    const a = mockAction('a');
    keys.add('preset', a, { presetId: 'aaa' });
    await waitFor(() => a.lastSvg().includes('<image'));
    const r = await keys.press('preset', a, { presetId: 'aaa' });
    assert.equal(r.superseded, true);
    assert.equal(a.calls.ok + a.calls.alert, 0);
  } finally {
    await teardown(ctx);
  }
});

test('chiave errata (401): immagine offline "chiave errata", poi si riprende con la chiave giusta', async () => {
  const ctx = await setup({ key: 'sbagliata' });
  const { hub, conn, keys } = ctx;
  try {
    const a = mockAction('a');
    const s = mockAction('s');
    keys.add('preset', a, { presetId: 'aaa' });
    keys.add('command', s, { command: 'home' });
    await waitFor(() => a.lastSvg().includes('chiave errata'), { what: 'offline per chiave' });
    assert.ok(a.lastSvg().includes('PTZ Hub') && a.lastSvg().includes('#FFD60A'), 'grigio con avviso e PTZ Hub');
    assert.ok(s.lastSvg().includes('#FFD60A'), 'anche i comandi mostrano l\'avviso');
    assert.equal(conn.status.reason, 'badKey');
    await keys.press('preset', a, { presetId: 'aaa' });
    assert.equal(a.calls.alert, 1, 'pressione con chiave errata: avviso');

    conn.configure({ host: '127.0.0.1', port: hub.port, key: KEY });
    await waitFor(() => a.lastSvg().includes('<image'), { what: 'di nuovo online' });
  } finally {
    await teardown(ctx);
  }
});

test('host non consentito (403) e chiave mancante', async () => {
  const hub = await new FakePtzHub().start();
  const conn = new PtzConnection({ minDelay: 30, maxDelay: 200 });
  const keys = new KeyController({ conn, getLang: () => 'en' });
  try {
    const a = mockAction('a');
    keys.add('preset', a, { presetId: 'aaa' });
    conn.configure({ host: '127.0.0.1', port: hub.port, key: '' });
    await waitFor(() => a.lastSvg().includes('no key'));
    assert.equal(hub.requests.length, 0, 'senza chiave non si chiama nemmeno');
    // PTZ Hub rifiuta il nome host (403, rete locale non attiva): avviso specifico
    hub.forbidAll = true;
    conn.configure({ host: '127.0.0.1', port: hub.port, key: KEY });
    await waitFor(() => a.lastSvg().includes('not allowed'), { what: '403' });
    assert.equal(conn.status.reason, 'forbidden');
    // "localhost" diventa 127.0.0.1 e l'intestazione Host resta tra quelle accettate
    hub.forbidAll = false;
    conn.configure({ host: 'localhost', port: hub.port, key: KEY });
    await waitFor(() => a.lastSvg().includes('<image'), { what: 'localhost accettato' });
    assert.equal(hub.requests.at(-1).host, `127.0.0.1:${hub.port}`);
  } finally {
    conn.dispose();
    await hub.stop();
  }
});

test('PTZ Hub chiuso: offline; riaperto sulla stessa porta: si ricollega da solo', async () => {
  const port = await freePort();
  let hub = await new FakePtzHub({ port }).start();
  const conn = new PtzConnection({ minDelay: 30, maxDelay: 200 });
  const keys = new KeyController({ conn, getLang: () => 'it' });
  try {
    conn.configure({ host: '127.0.0.1', port, key: KEY });
    const a = mockAction('a');
    keys.add('preset', a, { presetId: 'ccc' });
    await waitFor(() => a.lastSvg().includes('<image'), { what: 'online' });

    await hub.stop();
    await waitFor(() => a.lastSvg().includes('non raggiungibile'), { what: 'offline dopo la chiusura' });
    assert.equal(conn.status.state, 'offline');
    assert.equal(conn.status.reason, 'unreachable');
    const r = await keys.press('preset', a, { presetId: 'ccc' });
    assert.equal(r.reason, 'unreachable');
    assert.equal(a.calls.alert, 1);

    hub = await new FakePtzHub({ port }).start();
    hub.setState({ activeId: 'ccc' });
    await waitFor(() => a.lastSvg().includes(RING), { timeout: 4000, what: 'ricollegato con lo stato nuovo' });
    assert.equal(conn.status.state, 'online');
  } finally {
    conn.dispose();
    await hub.stop();
  }
});

test('connessione rifiutata fin dall\'inizio: immagine offline', async () => {
  const port = await freePort();
  const conn = new PtzConnection({ minDelay: 30, maxDelay: 200 });
  const keys = new KeyController({ conn, getLang: () => 'en' });
  try {
    conn.configure({ host: '127.0.0.1', port, key: KEY });
    const a = mockAction('a');
    const c = mockAction('c');
    keys.add('preset', a, { presetId: 'aaa' });
    keys.add('command', c, { command: 'stop' });
    await waitFor(() => a.lastSvg().includes('PTZ Hub') && a.lastSvg().includes('offline'), { what: 'offline' });
    await keys.press('command', c, { command: 'stop' });
    assert.equal(c.calls.alert, 1);
  } finally {
    conn.dispose();
  }
});

test('riconnessione con attesa crescente fino al massimo', async () => {
  const conn0 = new PtzConnection();
  assert.equal(conn0.minDelay, 1000, 'predefinito: 1 s');
  assert.equal(conn0.maxDelay, 10000, 'predefinito: 10 s');
  conn0.dispose();

  // server che accetta e chiude subito: si contano i tentativi
  const times = [];
  const srv = net.createServer((s) => { times.push(Date.now()); s.destroy(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const conn = new PtzConnection({ minDelay: 40, maxDelay: 160 });
  try {
    conn.configure({ host: '127.0.0.1', port: srv.address().port, key: KEY });
    conn.setWanted(true);
    await waitFor(() => times.length >= 6, { timeout: 3000, what: '6 tentativi' });
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    // attese attese: 40, 80, 160, 160, 160 (con un po' di tolleranza)
    assert.ok(gaps[0] >= 35 && gaps[0] < 300, `prima attesa ${gaps[0]}`);
    assert.ok(gaps[1] >= 70, `seconda attesa ${gaps[1]}`);
    assert.ok(gaps[2] >= 140, `terza attesa ${gaps[2]}`);
    for (const g of gaps.slice(3)) assert.ok(g >= 140 && g < 700, `attesa massima ${g}`);
  } finally {
    conn.dispose();
    await new Promise((r) => srv.close(r));
  }
});

test('collegamento solo quando serve: senza tasti visibili il flusso si chiude', async () => {
  const ctx = await setup();
  const { hub, keys, conn } = ctx;
  try {
    assert.equal(conn.status.state, 'idle');
    const a = mockAction('a');
    keys.add('preset', a, { presetId: 'aaa' });
    await waitFor(() => hub.clients.size === 1, { what: 'flusso aperto' });
    keys.remove('a');
    await waitFor(() => hub.clients.size === 0, { what: 'flusso chiuso' });
    assert.equal(conn.status.state, 'idle');
    keys.piOpened('x');
    await waitFor(() => hub.clients.size === 1, { what: 'flusso per il Property Inspector' });
  } finally {
    await teardown(ctx);
  }
});

test('Property Inspector: elenco inquadrature, stato e prova collegamento', async () => {
  const ctx = await setup();
  const { hub, conn, keys } = ctx;
  const sent = [];
  const bridge = new PiBridge({ conn, send: (m) => { sent.push(m); }, getLang: () => 'it' });
  try {
    keys.piOpened('pi');
    await bridge.handle({ event: 'hello' });
    await waitFor(() => sent.some((m) => m.event === 'presets' && m.online), { what: 'elenco' });
    const list = sent.filter((m) => m.event === 'presets').pop();
    assert.deepEqual(list.presets.map((p) => `${p.index} · ${p.name}`), ['1 · Palco & "Coro" <1>', '2 · Relatore', '3 · Pubblico']);
    const st = sent.filter((m) => m.event === 'status').pop();
    assert.equal(st.status.state, 'online');
    assert.equal(st.lang, 'it');
    assert.equal(st.presetCount, 3);

    // l'elenco si rimanda solo quando cambia
    const n = sent.filter((m) => m.event === 'presets').length;
    hub.setState({ activeId: 'aaa' });
    await sleep(60);
    assert.equal(sent.filter((m) => m.event === 'presets').length, n);
    hub.setState({ presets: [...hub.st.presets, { index: 4, id: 'ddd', name: 'Nuova', hasThumb: false, v: '' }] });
    await waitFor(() => sent.filter((m) => m.event === 'presets').length === n + 1, { what: 'elenco aggiornato' });

    await bridge.handle({ event: 'testConnection', host: '127.0.0.1', port: String(hub.port), key: KEY });
    let res = sent.filter((m) => m.event === 'testResult').pop();
    assert.equal(res.ok, true);
    assert.equal(res.presetCount, 4);
    assert.equal(res.camera, 'connected');

    await bridge.handle({ event: 'testConnection', host: '127.0.0.1', port: hub.port, key: 'no' });
    res = sent.filter((m) => m.event === 'testResult').pop();
    assert.deepEqual([res.ok, res.reason], [false, 'badKey']);

    const closed = await freePort();
    await bridge.handle({ event: 'testConnection', host: '127.0.0.1', port: closed, key: KEY });
    res = sent.filter((m) => m.event === 'testResult').pop();
    assert.deepEqual([res.ok, res.reason, res.address], [false, 'unreachable', `127.0.0.1:${closed}`]);
  } finally {
    await teardown(ctx);
  }
});
