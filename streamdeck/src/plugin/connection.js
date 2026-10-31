// Collegamento unico con PTZ Hub, condiviso da tutti i tasti del plugin.
//  - stato in tempo reale da /api/events (Server-Sent Events), con riconnessione 1 s → 10 s
//  - miniature delle inquadrature in memoria, riscaricate solo quando cambia "v"
//  - comandi (richiami, STOP, Home, …)
// Mentre gli eventi arrivano non si interroga PTZ Hub a intervalli.

import http from 'node:http';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { normalizeConfig, sameConfig } from '../shared/address.js';
import { SseParser } from './sse.js';
import { httpRequest, reasonForStatus, requestOptions } from './http.js';
import { imageSize } from './image-size.js';

const noopLog = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Stato del collegamento (this.status):
 *  - idle: non serve (nessun tasto visibile) o impostazioni non ancora caricate
 *  - connecting: primo tentativo in corso
 *  - online: eventi ricevuti; this.state contiene lo stato di PTZ Hub
 *  - offline: reason = unreachable | badKey | noKey | forbidden | notPtz | error
 *
 * Eventi: 'change' (stato o collegamento cambiati, al massimo uno per giro),
 *         'thumb' (id: è arrivata una miniatura).
 */
export class PtzConnection extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.minDelay = opts.minDelay ?? 1000;
    this.maxDelay = opts.maxDelay ?? 10000;
    this.requestTimeout = opts.requestTimeout ?? 5000; // stato, miniature, apertura degli eventi
    this.commandTimeout = opts.commandTimeout ?? 30000; // un richiamo risponde quando la camera è arrivata
    this.idleTimeout = opts.idleTimeout ?? 45000; // PTZ Hub manda ": ping" ogni 15 s
    this.thumbRetryDelay = opts.thumbRetryDelay ?? 3000;
    this.log = opts.log || noopLog;

    this.config = normalizeConfig({});
    this.configured = false;
    this.wanted = false;
    this.status = { state: 'idle', reason: '' };
    this.state = null;
    this.lastLang = '';

    this.streamId = 0;
    this.stream = null;
    this.delay = this.minDelay;
    this.retryTimer = null;
    this.idleTimer = null;
    this.notifyQueued = false;

    this.cfgGen = 0;
    this.thumbs = new Map(); // id -> { v, img, prev, loading, tries }
    this.agent = new http.Agent({ keepAlive: true, maxSockets: 6 });
  }

  // ---- configurazione --------------------------------------------------------

  /** Nuove impostazioni globali ({host, port, key}). Se cambiano, ci si ricollega da capo. */
  configure(raw) {
    const cfg = normalizeConfig(raw);
    if (this.configured && sameConfig(cfg, this.config)) return false;
    this.configured = true;
    this.config = cfg;
    this.cfgGen += 1;
    this.thumbs.clear();
    this.state = null;
    this._restart();
    this._notify();
    return true;
  }

  /** Il collegamento serve solo mentre c'è almeno un tasto visibile o un Property Inspector aperto. */
  setWanted(on) {
    const v = !!on;
    if (v === this.wanted) return;
    this.wanted = v;
    this._restart();
  }

  /** Riprova subito (es. dopo "Prova collegamento" o un tasto premuto mentre PTZ Hub era chiuso). */
  kick() {
    if (!this.wanted || !this.configured || this.status.state === 'online') return;
    if (this.stream) return; // un tentativo è già in corso
    clearTimeout(this.retryTimer);
    this.delay = this.minDelay;
    this._open();
  }

  dispose() {
    this.wanted = false;
    this._stopStream();
    clearTimeout(this.retryTimer);
    this.agent.destroy();
    this.removeAllListeners();
  }

  // ---- eventi in tempo reale ---------------------------------------------------

  _restart() {
    this._stopStream();
    clearTimeout(this.retryTimer);
    this.delay = this.minDelay;
    if (!this.wanted || !this.configured) {
      this._setStatus('idle');
      return;
    }
    this._setStatus('connecting');
    this._open();
  }

  _stopStream() {
    clearTimeout(this.idleTimer);
    this.streamId += 1; // le risposte del tentativo vecchio vengono ignorate
    const s = this.stream;
    this.stream = null;
    if (s) {
      clearTimeout(s.connectTimer);
      try { s.req.destroy(); } catch (_) { /* già chiuso */ }
    }
  }

  _open() {
    clearTimeout(this.retryTimer);
    if (!this.wanted || !this.configured) return;
    const cfg = this.config;
    if (!cfg.key) {
      // senza chiave non si prova nemmeno: si riparte quando arrivano impostazioni nuove
      this._setStatus('offline', 'noKey');
      return;
    }
    this._stopStream();
    const id = this.streamId;
    let req;
    try {
      req = http.request(requestOptions({
        ...cfg,
        path: '/api/events',
        agent: false,
        headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
      }));
    } catch (e) {
      this.log.warn(`events: ${e.message}`);
      this._setStatus('offline', e.code === 'ERR_INVALID_CHAR' ? 'badKey' : 'error');
      this._scheduleRetry(this.maxDelay);
      return;
    }
    const s = { req, res: null, connectTimer: null };
    this.stream = s;
    s.connectTimer = setTimeout(() => {
      const e = new Error('timeout');
      e.code = 'ETIMEDOUT';
      req.destroy(e);
    }, this.requestTimeout);

    req.on('response', (res) => {
      clearTimeout(s.connectTimer);
      if (id !== this.streamId) { res.destroy(); return; }
      s.res = res;
      const type = String(res.headers['content-type'] || '');
      if (res.statusCode !== 200 || !type.startsWith('text/event-stream')) {
        res.resume();
        this._streamEnded(id, res.statusCode === 200 ? 'notPtz' : reasonForStatus(res.statusCode));
        return;
      }
      const decoder = new StringDecoder('utf8');
      const parser = new SseParser({ onEvent: (ev) => this._onEvent(id, ev) });
      this._armIdle(id);
      res.on('data', (chunk) => {
        if (id !== this.streamId) return;
        this._armIdle(id);
        parser.push(decoder.write(chunk));
      });
      res.on('end', () => this._streamEnded(id, 'closed'));
      res.on('close', () => this._streamEnded(id, 'closed'));
      res.on('error', () => this._streamEnded(id, 'closed'));
    });
    req.on('error', (e) => {
      clearTimeout(s.connectTimer);
      this._streamEnded(id, s.res ? 'closed' : 'unreachable', e);
    });
    req.end();
  }

  _armIdle(id) {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      // nessun dato (nemmeno il ping) da troppo tempo: connessione morta (es. PC uscito dalla sospensione)
      if (id === this.streamId) this._streamEnded(id, 'closed');
    }, this.idleTimeout);
  }

  _onEvent(id, ev) {
    if (id !== this.streamId || ev.event !== 'state') return;
    let st;
    try {
      st = JSON.parse(ev.data);
    } catch (_) {
      return;
    }
    this.delay = this.minDelay;
    if (this.status.state !== 'online') {
      // di nuovo raggiungibile: le miniature non scaricate prima si riprovano
      for (const e of this.thumbs.values()) if (!e.done) e.tries = 0;
    }
    this._applyState(st);
    this._setStatus('online');
  }

  _streamEnded(id, reason, err) {
    if (id !== this.streamId) return;
    this._stopStream();
    if (err) this.log.debug(`events: ${err.code || err.message}`);
    if (reason === 'closed' && this.status.state === 'online') {
      // il flusso si è interrotto dopo aver funzionato (es. PTZ Hub ha riavviato il collegamento):
      // si riprova tra poco e intanto i tasti restano come sono; se il nuovo tentativo fallisce vanno offline
      this._scheduleRetry();
      return;
    }
    this._setStatus('offline', reason === 'closed' ? 'unreachable' : reason);
    // chiave errata o host rifiutato non si sistemano da soli: si riprova con calma
    this._scheduleRetry(reason === 'badKey' || reason === 'forbidden' ? this.maxDelay : undefined);
  }

  _scheduleRetry(fixed) {
    clearTimeout(this.retryTimer);
    if (!this.wanted || !this.configured) return;
    const d = fixed ?? this.delay;
    this.delay = Math.min(this.delay * 2, this.maxDelay);
    this.retryTimer = setTimeout(() => this._open(), d);
  }

  _applyState(raw) {
    const presets = Array.isArray(raw.presets) ? raw.presets
      .filter((p) => p && typeof p.id === 'string')
      .map((p, i) => ({
        index: Number(p.index) || i + 1,
        id: p.id,
        name: String(p.name ?? ''),
        hasThumb: !!p.hasThumb,
        v: String(p.v ?? ''),
      })) : [];
    const st = {
      camera: raw.camera && typeof raw.camera === 'object' ? raw.camera : {},
      activeId: raw.activeId || null,
      activeIndex: Number(raw.activeIndex) || 0,
      editing: !!raw.editing,
      moveSpeed: raw.moveSpeed,
      presets,
      lang: typeof raw.lang === 'string' ? raw.lang : '',
    };
    this.state = st;
    if (st.lang) this.lastLang = st.lang;
    // miniature di inquadrature eliminate o rimaste senza immagine
    const keep = new Set(presets.filter((p) => p.hasThumb).map((p) => p.id));
    for (const id of this.thumbs.keys()) if (!keep.has(id)) this.thumbs.delete(id);
    this._notify();
  }

  _setStatus(state, reason = '') {
    if (this.status.state === state && this.status.reason === reason) return;
    this.status = { state, reason };
    this._notify();
  }

  _notify() {
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      this.emit('change');
    });
  }

  // ---- miniature ---------------------------------------------------------------

  /**
   * Miniatura da mostrare subito per l'inquadratura (id, v): { mime, data (base64), width, height } o null.
   * Se manca o è vecchia la scarica e poi emette 'thumb'; nel frattempo ritorna quella precedente.
   */
  thumb(id, v) {
    const e = this.thumbs.get(id);
    if (e && e.v === v) {
      if (!e.loading && !e.done && e.tries < 3 && !e.waiting) this._loadThumb(id, v, e);
      return e.img || e.prev || null;
    }
    const entry = { v, img: null, prev: e ? (e.img || e.prev) : null, loading: false, done: false, tries: 0, waiting: false };
    this.thumbs.set(id, entry);
    this._loadThumb(id, v, entry);
    return entry.prev;
  }

  async _loadThumb(id, v, entry) {
    const gen = this.cfgGen;
    entry.loading = true;
    entry.tries += 1;
    const cfg = this.config;
    let img = null;
    let failed = false;
    try {
      const r = await httpRequest({
        ...cfg,
        path: `/api/presets/${encodeURIComponent(id)}/thumb?v=${encodeURIComponent(v)}`,
        agent: this.agent,
        timeout: this.requestTimeout,
      });
      const type = String(r.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (r.status === 200 && type.startsWith('image/') && r.body.length) {
        const size = imageSize(r.body);
        img = { mime: type, data: r.body.toString('base64'), width: size?.width || 0, height: size?.height || 0 };
      } else if (r.status !== 404) {
        failed = true;
      }
    } catch (e) {
      failed = true;
      this.log.debug(`thumb ${id}: ${e.code || e.message}`);
    }
    if (gen !== this.cfgGen || this.thumbs.get(id) !== entry) return; // impostazioni o versione cambiate nel frattempo
    entry.loading = false;
    if (failed) {
      // si riprova tra poco (al massimo 3 volte per versione), intanto resta l'immagine precedente
      if (entry.tries < 3) {
        entry.waiting = true;
        setTimeout(() => {
          entry.waiting = false;
          if (this.thumbs.get(id) === entry) this.emit('thumb', id);
        }, this.thumbRetryDelay);
      }
      return;
    }
    entry.done = true;
    entry.img = img;
    entry.prev = null;
    this.emit('thumb', id);
  }

  // ---- comandi -------------------------------------------------------------------

  /**
   * Manda un comando: path senza /api/ (es. "stop", "recall/id/abc", "nudge/up").
   * @returns {Promise<{ok: boolean, superseded?: boolean, reason?: string, error?: string}>}
   */
  async command(path, { timeout } = {}) {
    const cfg = this.config;
    if (!cfg.key) return { ok: false, reason: 'noKey' };
    try {
      const r = await httpRequest({ ...cfg, method: 'POST', path: `/api/${path}`, agent: this.agent, timeout: timeout ?? this.commandTimeout });
      let j = null;
      try { j = JSON.parse(r.body.toString('utf8')); } catch (_) { /* risposta non JSON */ }
      if (r.status === 200 && j && j.ok) return { ok: true, superseded: !!j.superseded };
      return { ok: false, reason: r.status === 404 && j ? 'refused' : reasonForStatus(r.status), status: r.status, error: (j && j.error) || '' };
    } catch (e) {
      return { ok: false, reason: e.code === 'EBADKEY' ? 'badKey' : 'unreachable', error: e.code || e.message };
    }
  }

  recallId(id) {
    return this.command(`recall/id/${encodeURIComponent(id)}`);
  }

  /** Prova un collegamento (anche con impostazioni non ancora salvate) leggendo /api/state. */
  async probe(raw) {
    const cfg = normalizeConfig(raw);
    if (!cfg.key) return { ok: false, reason: 'noKey', config: cfg };
    try {
      const r = await httpRequest({ ...cfg, path: '/api/state', agent: false, timeout: this.requestTimeout });
      let j = null;
      try { j = JSON.parse(r.body.toString('utf8')); } catch (_) { /* non JSON */ }
      if (r.status === 200 && j && j.ok && Array.isArray(j.presets)) {
        if (sameConfig(cfg, this.config)) this.kick();
        return { ok: true, config: cfg, state: j };
      }
      return { ok: false, config: cfg, reason: r.status === 200 ? 'notPtz' : reasonForStatus(r.status), error: (j && j.error) || '' };
    } catch (e) {
      return { ok: false, config: cfg, reason: e.code === 'EBADKEY' ? 'badKey' : 'unreachable', error: e.code || e.message };
    }
  }
}
