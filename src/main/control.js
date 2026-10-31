'use strict';
// Collegamento locale per comandare il programma dall'esterno:
//  - pannello per OBS (pagina servita da qui, aggiornata in tempo reale)
//  - indirizzi web per Stream Deck, Bitfocus Companion e simili
// Ogni richiesta deve contenere la chiave (?k=...) dell'account: così una pagina web
// qualsiasi aperta nel browser non può muovere la telecamera.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const I18N = require('../shared/i18n');

const STATIC = {
  '/obs': ['obs.html', 'text/html; charset=utf-8'],
  '/obs.js': ['obs.js', 'text/javascript; charset=utf-8'],
  '/obs.css': ['obs.css', 'text/css; charset=utf-8'],
  '/i18n.js': ['../shared/i18n.js', 'text/javascript; charset=utf-8'],
  '/icon.png': ['../renderer/icon.png', 'image/png'],
};
const STATIC_DIR = path.join(__dirname, '..', 'control');

function safeEqual(a, b) {
  if (!b) return false; // senza chiave configurata non passa nessuno
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

class ControlServer extends EventEmitter {
  constructor(hub) {
    super();
    this.hub = hub;
    this.server = null;
    this.clients = new Set();
    this.opts = null;
    this.status = { state: 'off', detail: '' };
    this.heartbeat = null;
    this.queue = Promise.resolve(); // avvii e arresti uno alla volta, nell'ordine in cui arrivano
    this.moveSeq = new Map(); // ultimo numero di sequenza dei movimenti per ogni pannello OBS
    this.onChange = (st) => this.broadcast('state', this.publicState(st));
    hub.on('change', this.onChange);
  }

  publicState(st = this.hub.state()) {
    return { ...st, lang: I18N.getLang() };
  }

  setStatus(state, detail = '') {
    this.status = { state, detail };
    this.emit('status', this.status);
  }

  _enqueue(fn) {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  start(opts) { return this._enqueue(() => this._start(opts)); }

  stop() { return this._enqueue(() => this._stop()); }

  async _start({ port = 8765, lan = false, token }) {
    await this._stop();
    this.opts = { port, lan, token };
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        try { this.json(res, 500, { ok: false, error: e.message }); } catch (_) { /* risposta già inviata */ }
      });
    });
    server.maxConnections = 64;
    this.server = server;
    server.on('error', (e) => {
      this.setStatus('error', e.code === 'EADDRINUSE' ? I18N.t('api.portBusy', { port }) : e.message);
    });
    await new Promise((resolve) => {
      server.listen(port, lan ? '0.0.0.0' : '127.0.0.1', () => {
        this.setStatus('on', `${lan ? '0.0.0.0' : '127.0.0.1'}:${port}`);
        resolve();
      });
      server.once('error', () => resolve());
    });
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) c.write(': ping\n\n');
    }, 15000);
  }

  async _stop() {
    clearInterval(this.heartbeat);
    for (const c of this.clients) { try { c.end(); } catch (_) { /* ignora */ } }
    this.clients.clear();
    this.moveSeq.clear();
    if (this.server) {
      const s = this.server;
      this.server = null;
      await new Promise((r) => {
        // le connessioni rimaste aperte (richieste in corso) si chiudono dopo un attimo
        const force = setTimeout(() => { try { s.closeAllConnections(); } catch (_) { /* ignora */ } }, 1000);
        s.close(() => { clearTimeout(force); r(); });
        try { s.closeIdleConnections(); } catch (_) { /* ignora */ }
      });
    }
    this.setStatus('off');
  }

  broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) c.write(msg);
  }

  hostAllowed(req) {
    if (this.opts.lan) return true;
    // protezione dal "DNS rebinding": in modalità locale si accettano solo questi nomi
    const host = String(req.headers.host || '').toLowerCase();
    const p = this.opts.port;
    return [`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`].includes(host);
  }

  json(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  async handle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://local');
    } catch (_) {
      this.json(res, 400, { ok: false, error: 'bad url' });
      return;
    }
    if (!this.hostAllowed(req)) {
      this.json(res, 403, { ok: false, error: 'host not allowed' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
      this.json(res, 405, { ok: false, error: 'method not allowed' });
      return;
    }
    const key = url.searchParams.get('k') || req.headers['x-ptz-key'];
    const p = url.pathname.replace(/\/+$/, '') || '/';

    // file statici del pannello OBS (la pagina stessa richiede la chiave nell'indirizzo)
    if (STATIC[p]) {
      if (p === '/obs' && !safeEqual(key, this.opts.token)) {
        res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(I18N.t('api.badKey'));
        return;
      }
      const [file, type] = STATIC[p];
      fs.readFile(path.join(STATIC_DIR, file), (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        res.end(data);
      });
      return;
    }

    if (!p.startsWith('/api/')) {
      this.json(res, 404, { ok: false, error: 'not found' });
      return;
    }
    if (!safeEqual(key, this.opts.token)) {
      this.json(res, 401, { ok: false, error: I18N.t('api.badKey') });
      return;
    }

    let parts;
    try {
      parts = p.split('/').slice(2).map(decodeURIComponent); // dopo /api/
    } catch (_) {
      this.json(res, 400, { ok: false, error: 'bad url' });
      return;
    }
    const num = (name, def) => {
      const v = url.searchParams.get(name);
      if (v === null || v === '') return def;
      const n = Number(v);
      return Number.isFinite(n) ? n : def;
    };
    const hub = this.hub;
    try {
      switch (parts[0]) {
        case 'state':
          this.json(res, 200, { ok: true, ...this.publicState() });
          return;
        case 'events': {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
          });
          res.write(`event: state\ndata: ${JSON.stringify(this.publicState())}\n\n`);
          this.clients.add(res);
          req.on('close', () => this.clients.delete(res));
          return;
        }
        case 'presets':
          if (parts[2] === 'thumb') {
            const th = hub.thumb(parts[1]);
            if (!th) { res.writeHead(404); res.end(); return; }
            // l'indirizzo cambia a ogni modifica dell'inquadratura (?v=...), quindi si può tenere in cache
            res.writeHead(200, { 'Content-Type': th.type, 'Cache-Control': 'private, max-age=86400' });
            res.end(th.data);
            return;
          }
          this.json(res, 200, { ok: true, presets: hub.state().presets });
          return;
        case 'recall': {
          const p2 = parts[1] === 'id' ? await hub.recallId(parts[2]) : await hub.recallIndex(Number(parts[1]));
          // null: il richiamo è stato superato da STOP o da un altro comando
          this.json(res, 200, p2 ? { ok: true, recalled: { id: p2.id, name: p2.name } } : { ok: true, superseded: true });
          return;
        }
        case 'next': await hub.step(1); break;
        case 'prev': await hub.step(-1); break;
        case 'stop': hub.stop(); break;
        case 'home': hub.home({ remote: true }); break;
        case 'onepush': hub.onePush(); break;
        case 'nudge': hub.nudge(parts[1], num('ms', 300), num('speed', undefined), { remote: true }); break;
        case 'zoom': hub.zoomPulse(parts[1], num('ms', 300), num('speed', undefined), { remote: true }); break;
        case 'move': {
          // il pannello OBS numera i movimenti: uno arrivato fuori ordine si scarta
          const cid = String(url.searchParams.get('c') || '').slice(0, 32);
          const seq = num('s', null);
          if (cid && seq != null) {
            const last = this.moveSeq.get(cid);
            if (last != null && seq <= last) { this.json(res, 200, { ok: true, stale: true }); return; }
            if (this.moveSeq.size > 50 && !this.moveSeq.has(cid)) this.moveSeq.clear();
            this.moveSeq.set(cid, seq);
          }
          hub.remoteMove(num('x', 0), num('y', 0), num('z', 0));
          break;
        }
        case 'run': await hub.run(parts.slice(1).join('/'), { remote: true }); break;
        default:
          this.json(res, 404, { ok: false, error: I18N.t('api.badCommand') });
          return;
      }
      this.json(res, 200, { ok: true });
    } catch (e) {
      this.json(res, 409, { ok: false, error: e.message });
    }
  }
}

module.exports = { ControlServer };
