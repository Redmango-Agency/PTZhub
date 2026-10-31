// PTZ Hub finto per i test: stesse regole del collegamento esterno vero (src/main/control.js):
// chiave in ?k= o x-ptz-key, Host locale, /api/state, /api/events (SSE), miniature, comandi.

import http from 'node:http';

export const KEY = 'chiaveProva_1';

/** Intestazione JPEG minima (SOF0 320×180): basta per leggere le dimensioni. */
export function fakeJpeg(tag = 'A') {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0xb4, 0x01, 0x40, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]),
    Buffer.from(`fake-jpeg-${tag}`),
    Buffer.from([0xff, 0xd9]),
  ]);
}

export function defaultState() {
  return {
    camera: { state: 'connected', detail: '', host: '192.168.1.50', protocol: 'visca-udp' },
    activeId: null,
    activeIndex: 0,
    editing: false,
    moveSpeed: 0.6,
    presets: [
      { index: 1, id: 'aaa', name: 'Palco & "Coro" <1>', hasThumb: true, v: '1' },
      { index: 2, id: 'bbb', name: 'Relatore', hasThumb: false, v: '' },
      { index: 3, id: 'ccc', name: 'Pubblico', hasThumb: true, v: '7' },
    ],
    lang: 'it',
  };
}

export class FakePtzHub {
  constructor({ port = 0, key = KEY, lan = false } = {}) {
    this.port = port;
    this.key = key;
    this.lan = lan;
    this.st = defaultState();
    this.thumbs = new Map([['aaa', fakeJpeg('aaa1')], ['ccc', fakeJpeg('ccc7')]]);
    this.requests = []; // { method, path, query, key, host }
    this.clients = new Set();
    this.server = null;
    this.sockets = new Set();
    this.recallDelay = 0;
    this.superseded = false;
  }

  async start() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on('connection', (s) => { this.sockets.add(s); s.on('close', () => this.sockets.delete(s)); });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', () => resolve());
    });
    this.port = this.server.address().port;
    this.ping = setInterval(() => { for (const c of this.clients) c.write(': ping\n\n'); }, 15000);
    return this;
  }

  async stop() {
    clearInterval(this.ping);
    for (const c of this.clients) { try { c.end(); } catch (_) { /* ignora */ } }
    this.clients.clear();
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    for (const so of this.sockets) so.destroy();
    await new Promise((r) => s.close(() => r()));
  }

  state() {
    return { ...this.st, activeIndex: this.st.presets.findIndex((p) => p.id === this.st.activeId) + 1 };
  }

  setState(patch) {
    Object.assign(this.st, patch);
    this.broadcast();
  }

  broadcast() {
    // come PTZ Hub, a volte i messaggi arrivano spezzati: si scrive in due pezzi
    const msg = `event: state\ndata: ${JSON.stringify(this.state())}\n\n`;
    const cut = Math.floor(msg.length / 2);
    for (const c of this.clients) {
      c.write(msg.slice(0, cut));
      c.write(msg.slice(cut));
    }
  }

  count(pred) {
    return this.requests.filter(pred).length;
  }

  json(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const key = url.searchParams.get('k') || req.headers['x-ptz-key'];
    this.requests.push({ method: req.method, path: url.pathname, query: url.search, key, host: req.headers.host });
    const host = String(req.headers.host || '').toLowerCase();
    if (this.forbidAll || (!this.lan &&![`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`].includes(host))) {
      this.json(res, 403, { ok: false, error: 'host not allowed' });
      return;
    }
    if (key !== this.key) {
      this.json(res, 401, { ok: false, error: 'chiave mancante o errata' });
      return;
    }
    const parts = url.pathname.split('/').slice(2).map(decodeURIComponent);
    switch (parts[0]) {
      case 'state':
        this.json(res, 200, { ok: true, ...this.state() });
        return;
      case 'events':
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`event: state\ndata: ${JSON.stringify(this.state())}\n\n`);
        this.clients.add(res);
        req.on('close', () => this.clients.delete(res));
        return;
      case 'presets': {
        const th = this.thumbs.get(parts[1]);
        if (parts[2] !== 'thumb' || !th) { res.writeHead(404); res.end(); return; }
        if (this.thumbFailures > 0) { this.thumbFailures -= 1; res.writeHead(500); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
        res.end(th);
        return;
      }
      case 'recall': {
        if (this.st.editing) { this.json(res, 409, { ok: false, error: 'modifica in corso' }); return; }
        const id = parts[1] === 'id' ? parts[2] : this.st.presets[Number(parts[1]) - 1]?.id;
        const p = this.st.presets.find((x) => x.id === id);
        if (!p) { this.json(res, 409, { ok: false, error: 'inquadratura inesistente' }); return; }
        if (this.recallDelay) await new Promise((r) => setTimeout(r, this.recallDelay));
        if (this.superseded) { this.json(res, 200, { ok: true, superseded: true }); return; }
        this.setState({ activeId: p.id });
        this.json(res, 200, { ok: true, recalled: { id: p.id, name: p.name } });
        return;
      }
      case 'stop':
      case 'onepush':
        this.json(res, 200, { ok: true });
        return;
      case 'home':
      case 'next':
      case 'prev':
      case 'zoom':
      case 'nudge':
        if (this.st.editing) { this.json(res, 409, { ok: false, error: 'modifica in corso' }); return; }
        this.json(res, 200, { ok: true });
        return;
      default:
        this.json(res, 404, { ok: false, error: 'comando non riconosciuto' });
    }
  }
}

/** Azione finta di Stream Deck: registra le chiamate. */
export function mockAction(id) {
  const calls = { images: [], ok: 0, alert: 0 };
  return {
    id,
    calls,
    setImage(img) { calls.images.push(img); return Promise.resolve(); },
    showOk() { calls.ok += 1; return Promise.resolve(); },
    showAlert() { calls.alert += 1; return Promise.resolve(); },
    isInMultiAction: () => false,
    lastSvg() {
      const img = calls.images[calls.images.length - 1];
      if (!img) return '';
      return Buffer.from(img.replace(/^data:image\/svg\+xml;base64,/, ''), 'base64').toString('utf8');
    },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Aspetta finché cond() è vera (o scade). */
export async function waitFor(cond, { timeout = 3000, step = 10, what = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${what}`);
    await sleep(step);
  }
}

/** Porta libera (si apre e si chiude un server). */
export async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}
