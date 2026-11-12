'use strict';
// Driver USB (UVC) per le telecamere collegate al PC con il cavo USB. In prova.
//
// Chromium comanda pan, tilt e zoom di una camera USB solo attraverso un MediaStreamTrack
// (getUserMedia con pan/tilt/zoom, poi applyConstraints). Il track vive in una finestra nascosta
// (uvc-link.js); questo driver ha la stessa interfaccia di quelli VISCA e ONVIF verso l'hub e gli
// manda soltanto valori assoluti.
//
// Le camere USB accettano posizioni assolute: il movimento continuo (joystick, frecce,
// Stream Deck, pannello OBS) si ottiene spostando la posizione a piccoli passi, 25 volte al secondo,
// in base alla velocità. STOP ferma subito gli incrementi. Un comando alla volta verso la camera:
// se è ancora occupata con il precedente si manda solo l'ultimo valore.
//
// Frecce (dalla 1.5.6): un clic = il passo assoluto più piccolo che sposta davvero la camera
// (verificato rileggendo la posizione: se non cambia il passo cresce e il valore buono si ricorda);
// tenuta in «Lento» = gli stessi passi minimi a ritmo regolare, quindi più lenta della velocità
// minima della camera; «Veloce» = comando a velocità continuo, se la camera lo accetta.

const { EventEmitter } = require('events');
const { t } = require('../shared/i18n');
const { analyzeCaps, quantize, classifyError } = require('../shared/uvc-caps');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TIMING = {
  tickMs: 40, // 25 aggiornamenti al secondo
  ptFullS: 20, // pan/tilt: la corsa più lunga in 20 s alla velocità massima (si centra senza scatti)
  zoomFullS: 5, // zoom: da largo a stretto in 5 s
  focusFullS: 4, // fuoco: tutta la corsa in 4 s
  confirmEveryMs: 300, // richiamo: ogni quanto si controlla che la camera sia arrivata
  confirmMs: 20000, // per quanto al massimo (le camere lente impiegano qualche secondo)
  maxResend: 8, // quante volte si rimanda un asse se la camera si è fermata altrove
  resendGapMs: 600, // tra un rinvio e l'altro (la testa deve avere il tempo di partire)
  relKeepMs: 400, // durante il movimento a velocità si conferma il comando (l'aiuto ferma dopo 1,5 s)
  retryMs: 3000, // camera scollegata o occupata: si riprova ogni 3 s
  resyncAfterMs: 1500, // comando manuale dopo 1,5 s senza comandi nostri: prima si rilegge la posizione vera
  kickGapMs: 250, // richiamo: pausa tra il valore «spinta» (un passo accanto) e quello giusto
  slowMaxV: 0.04, // sotto questa velocità (Lento, Maiusc) la tenuta va a passi minimi
  slowStepMs: 600, // Lento tenuto premuto: un passo minimo ogni 0,6 s
  stepSettleMs: 250, // clic: dopo il passo si aspetta prima di rileggere se la camera si è mossa
  stepGrowMax: 4, // clic: quante volte al massimo il passo raddoppia se la camera non si muove
  stepIncMaxFrac: 0.02, // ... fino al 2% della corsa
};

const AXES = ['pan', 'tilt', 'zoom'];

function cancelledError() {
  const e = new Error('cancelled');
  e.code = 'CANCELLED';
  return e;
}

function errorText(code, e) {
  switch (code) {
    case 'busy': return t('uvc.busy');
    case 'notfound': return t('uvc.notFound');
    case 'denied': return t('uvc.denied');
    default: return t('uvc.error', { error: (e && e.message) || String(e) });
  }
}

class UvcCamera extends EventEmitter {
  // opts: { deviceId, label, invertPan, invertTilt, link, timing }
  // link: { open({deviceId,label}), apply(values), settings(), close(), destroy?() } + eventi
  //       'ended' (camera scollegata), 'gone' (finestra nascosta chiusa), 'devicechange'
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.kind = 'usb';
    this.link = opts.link;
    this.tm = { ...TIMING, ...(opts.timing || {}) };
    this.state = 'disconnected';
    this.detail = '';
    this.code = '';
    this.axes = analyzeCaps(null);
    this.ready = false; // track aperto e comandabile
    this.connecting = false;
    this.closed = false;
    this.pos = {}; // posizione richiesta (con i decimali, per gli incrementi piccoli)
    this.last = {}; // ultimi valori mandati alla camera (sulla sua griglia)
    this.vel = { x: 0, y: 0, z: 0, f: 0 };
    this.loopTimer = null;
    this.lastTick = 0;
    this.queue = null; // valori in attesa (uniti), partono appena la camera ha preso i precedenti
    this.busy = false;
    this.idleWaiters = [];
    this.gen = 0; // cambia con STOP, Home e i comandi manuali: un richiamo in corso si ferma
    this.focusAuto = true;
    this.absMoving = false; // richiamo o Home in corso (comando assoluto in attesa di conferma)
    this.lastSendAt = 0; // ultimo valore mandato alla camera
    this.syncedAt = 0; // ultima rilettura della posizione vera
    this.resyncing = null; // rilettura in corso (promessa)
    this.ptSync = false; // il prossimo pan o tilt parte insieme all'altro asse
    // movimento «a velocità» (pan e tilt relativi, solo Windows e se la camera li accetta):
    // fluido e fine anche quando la posizione assoluta della camera va a gradi interi
    this.rel = null; // gamme delle velocità { pan, tilt } o null
    this.relProbed = false; // si prova una volta per avvio
    this.relWant = { pan: 0, tilt: 0 };
    this.relCur = { pan: 0, tilt: 0 };
    this.relBusy = false;
    this.relDirty = false;
    this.relKeep = null;
    // passi minimi (clic e Lento tenuto): passo che ha davvero mosso la camera, per asse
    this.minInc = {};
    this.slowTok = null; // tenuta in Lento in corso (gettone: cambia per fermarla)
    this.slowDir = null;
    this.lastStepAt = 0;
    this.stepQueue = null; // clic in fila
    this.stepGrewLogged = false;
    this.retryTimer = null;
    this.lastErrorLog = 0;
    this._onEnded = () => this._lost(t('uvc.unplugged'));
    this._onGone = () => this._lost(t('uvc.hostGone'));
    this._onDeviceChange = () => {
      // camera ricollegata: si riprova subito invece di aspettare il prossimo tentativo
      if (!this.ready && !this.connecting && !this.closed && this.code !== 'noptz') this._scheduleRetry(500);
    };
    this.link.on('ended', this._onEnded);
    this.link.on('gone', this._onGone);
    this.link.on('devicechange', this._onDeviceChange);
  }

  _setState(state, detail = '', code = '') {
    if (state === this.state && detail === this.detail && code === this.code) return;
    this.state = state;
    this.detail = detail;
    this.code = code;
    const st = { state, detail };
    if (code) st.code = code; // causa, per spiegarla nell'interfaccia (noptz, zoomonly, busy, notfound…)
    this.emit('status', st);
  }

  // ---- collegamento --------------------------------------------------------

  async connect() {
    this.closed = false;
    clearTimeout(this.retryTimer);
    if (this.connecting) return;
    this.connecting = true;
    // nei nuovi tentativi resta lo stato «non risponde» con la sua causa (niente lampeggi)
    if (this.state !== 'error') this._setState('connecting', this.opts.label || 'USB');
    let r;
    try {
      r = await this.link.open({ deviceId: this.opts.deviceId || '', label: this.opts.label || '' });
    } catch (e) {
      this.connecting = false;
      if (this.closed) return;
      const code = classifyError(e);
      this._setState('error', errorText(code, e), code);
      // la causa precisa (codice di Windows, aiuto USB chiuso…) una volta sola, non a ogni tentativo
      const detail = (e && e.message) || String(e);
      if (detail !== this.lastConnectError) {
        this.lastConnectError = detail;
        this.emit('log', t('uvc.detail', { detail }));
      }
      this._scheduleRetry();
      return;
    }
    this.lastConnectError = '';
    this.connecting = false;
    if (this.closed) { this.link.close().catch(() => {}); return; }
    this.axes = analyzeCaps(r && r.caps);
    if (!this.axes.any) {
      // niente pan, tilt né zoom via USB: la camera si rilascia subito (OBS potrebbe volerla)
      this.ready = false;
      await this.link.close().catch(() => {});
      if (this.closed) return;
      this._setState('error', t('uvc.noPtz'), 'noptz');
      return; // riprovare non serve: la camera non cambia idea
    }
    this.ready = true;
    this.last = {};
    this._syncFrom((r && r.settings) || {});
    this.focusAuto = !(r && r.settings && r.settings.focusMode === 'manual');
    if (!this.axes.move) {
      this._setState('connected', t('uvc.zoomOnly'), 'zoomonly');
      if (!this.zoomOnlyLogged) { this.zoomOnlyLogged = true; this.emit('log', t('uvc.zoomOnly')); }
    } else {
      this._setState('connected', '');
      this._probeRel();
    }
  }

  _syncFrom(s) {
    for (const k of [...AXES, 'focusDistance']) {
      const a = this.axes[k];
      if (!a) continue;
      const v = num(s[k]) ? s[k] : (k === 'zoom' || k === 'focusDistance' ? a.min : (a.min <= 0 && a.max >= 0 ? 0 : a.min));
      this.pos[k] = clamp(v, a.min, a.max);
      this.last[k] = quantize(a, this.pos[k]);
    }
  }

  _scheduleRetry(ms = this.tm.retryMs) {
    clearTimeout(this.retryTimer);
    if (this.closed) return;
    this.retryTimer = setTimeout(() => {
      if (!this.closed && !this.ready && !this.connecting) this.connect();
    }, ms);
  }

  // camera scollegata (o finestra nascosta chiusa): stato «non risponde» e nuovi tentativi
  _lost(detail) {
    if (this.closed || !this.ready) return;
    this.ready = false;
    this.gen += 1; // un richiamo in corso si ferma
    this._stopMotion();
    this._relReset(); // la camera la ferma l'aiuto (nuova apertura o controllo di sicurezza)
    this.queue = null;
    this._setState('error', detail, 'notfound');
    this.link.close().catch(() => {});
    this._scheduleRetry();
  }

  async disconnect() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.gen += 1;
    this._stopMotion();
    if (this.relCur.pan || this.relCur.tilt) await this._relHalt();
    this._relReset();
    this.queue = null;
    this.ready = false;
    this.link.removeListener('ended', this._onEnded);
    this.link.removeListener('gone', this._onGone);
    this.link.removeListener('devicechange', this._onDeviceChange);
    try { await Promise.race([this.link.close(), sleep(1000)]); } catch (_) { /* finestra già chiusa */ }
    if (typeof this.link.destroy === 'function') this.link.destroy();
    this._setState('disconnected', '');
  }

  _ensureReady() {
    if (this.ready) return;
    if (this.code === 'noptz') throw new Error(t('uvc.noPtz'));
    throw new Error(this.state === 'error' && this.detail ? this.detail : t('uvc.notConnected'));
  }

  // ---- invio dei valori ----------------------------------------------------

  _send(values) {
    if (!this.ready) return;
    this.queue = { ...(this.queue || {}), ...values };
    for (const k of Object.keys(values)) if (k !== 'focusMode') this.last[k] = values[k];
    this.lastSendAt = Date.now();
    if (!this.busy) this._pump();
  }

  async _pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue && this.ready) {
        const v = this.queue;
        this.queue = null;
        try {
          // eslint-disable-next-line no-await-in-loop
          await this.link.apply(v);
        } catch (e) {
          this._applyFailed(e);
        }
      }
    } finally {
      this.busy = false;
      if (!this.ready) this.queue = null;
      const w = this.idleWaiters;
      this.idleWaiters = [];
      w.forEach((r) => r());
    }
  }

  // aspetta che la camera abbia preso tutti i valori già mandati
  _idle() {
    if (!this.busy && !this.queue) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  _applyFailed(e) {
    const name = (e && e.name) || '';
    if (name === 'NotFoundError' || name === 'InvalidStateError') {
      this._lost(t('uvc.unplugged'));
      return;
    }
    const now = Date.now();
    if (now - this.lastErrorLog > 10000) {
      this.lastErrorLog = now;
      this.emit('log', t('uvc.error', { error: (e && e.message) || String(e) }));
    }
  }

  // ---- movimento continuo --------------------------------------------------

  _stopMotion() {
    this._slowStop();
    this.vel = { x: 0, y: 0, z: 0, f: 0 };
    clearInterval(this.loopTimer);
    this.loopTimer = null;
  }

  _kick() {
    const moving = this.vel.x || this.vel.y || this.vel.z || this.vel.f;
    if (!moving || !this.ready) {
      clearInterval(this.loopTimer);
      this.loopTimer = null;
      return;
    }
    if (this.loopTimer || this.resyncing) return;
    if (this._needsResync()) { this._resync(); return; } // a rilettura finita si riparte da qui
    this.lastTick = Date.now();
    this.loopTimer = setInterval(() => this._tick(), this.tm.tickMs);
  }

  // unità al secondo alla velocità 1. Pan e tilt hanno la stessa unità (gradi o secondi d'arco):
  // stessa velocità angolare, calcolata sulla corsa più lunga
  _rate(k) {
    const a = this.axes[k];
    if (!a) return 0;
    if (k === 'pan' || k === 'tilt') {
      const span = Math.max(this.axes.pan ? this.axes.pan.max - this.axes.pan.min : 0,
        this.axes.tilt ? this.axes.tilt.max - this.axes.tilt.min : 0);
      return span / this.tm.ptFullS;
    }
    return (a.max - a.min) / (k === 'zoom' ? this.tm.zoomFullS : this.tm.focusFullS);
  }

  _tick() {
    const now = Date.now();
    const dt = Math.min(0.2, Math.max(0, (now - this.lastTick) / 1000)); // dopo un blocco niente salti
    this.lastTick = now;
    if (!this.ready) { this._stopMotion(); return; }
    const out = {};
    const step = (k, v) => {
      const a = this.axes[k];
      if (!a || !v) return;
      this.pos[k] = clamp(this.pos[k] + v * this._rate(k) * dt, a.min, a.max);
      const q = quantize(a, this.pos[k]);
      if (q !== this.last[k]) out[k] = q;
    };
    step('pan', this.vel.x);
    step('tilt', this.vel.y);
    step('zoom', this.vel.z);
    step('focusDistance', this.vel.f);
    if (Object.keys(out).length) this._send(this._withPair(out));
  }

  // un comando manuale prende il posto di un richiamo o di Home in corso
  _interrupt() { this.gen += 1; }

  // Prima di un comando manuale si rilegge dove si trova davvero la camera: col telecomando,
  // con OBS o con un altro programma può essersi mossa senza passare da qui, e partire dai
  // valori vecchi la farebbe saltare. Se gli ultimi comandi sono nostri e recenti valgono i
  // nostri valori (la testa può essere ancora in viaggio verso quelli).
  _needsResync() {
    if (!this.ready || this.absMoving) return false;
    return Date.now() - Math.max(this.lastSendAt, this.syncedAt) >= this.tm.resyncAfterMs;
  }

  _resync() {
    if (this.resyncing) return this.resyncing;
    const run = (async () => {
      await this._idle();
      let st = null;
      try { st = await this.link.settings(); } catch (_) { st = null; }
      this.syncedAt = Date.now();
      if (!st || !this.ready) return;
      for (const k of [...AXES, 'focusDistance']) {
        const a = this.axes[k];
        if (!a || !num(st[k])) continue;
        this.pos[k] = clamp(st[k], a.min, a.max);
        this.last[k] = quantize(a, this.pos[k]);
      }
      // in UVC pan e tilt sono un solo controllo: col primo comando si manda anche l'asse
      // fermo al suo valore vero, così il driver non ne usa uno vecchio (la camera «salterebbe»)
      this.ptSync = true;
    })();
    this.resyncing = run.finally(() => {
      this.resyncing = null;
      this._kick();
    });
    return this.resyncing;
  }

  // aggiunge l'asse fermo (pan o tilt) al suo valore vero, solo subito dopo una rilettura
  _withPair(out) {
    if (!this.ptSync || !('pan' in out || 'tilt' in out)) return out;
    this.ptSync = false;
    const other = 'pan' in out ? ('tilt' in out ? null : 'tilt') : 'pan';
    if (other && this.axes[other] && num(this.last[other])) return { ...out, [other]: this.last[other] };
    return out;
  }

  // x, y in [-1, 1]. x>0 = destra, y>0 = su (UVC: pan positivo = orario visto dall'alto, tilt positivo = su)
  move(x, y) {
    if (this.opts.invertPan) x = -x;
    if (this.opts.invertTilt) y = -y;
    x = this.axes.pan ? clamp(Number(x) || 0, -1, 1) : 0;
    y = this.axes.tilt ? clamp(Number(y) || 0, -1, 1) : 0;
    if ((x || y) && Math.max(Math.abs(x), Math.abs(y)) < this.tm.slowMaxV) {
      // Lento: passi minimi a ritmo regolare. Non dipende dalla velocità minima della camera
      // (sulla Tenveo troppo alta) né dalla soglia sotto cui un comando a velocità non la muove
      if (this.relWant.pan || this.relWant.tilt || this.relCur.pan || this.relCur.tilt) this._relDrive(0, 0);
      this.vel.x = 0;
      this.vel.y = 0;
      if (!this.slowTok) this._interrupt();
      this._slowStart(Math.sign(x), Math.sign(y));
      this._kick();
      return;
    }
    this._slowStop();
    if (this._relOn()) {
      // Veloce: la camera si muove da sola alla velocità data, niente passi assoluti
      this.vel.x = 0;
      this.vel.y = 0;
      if (x || y) this._interrupt();
      this._relDrive(this._relSpeed('pan', x), this._relSpeed('tilt', y));
      this._kick();
      return;
    }
    this.vel.x = x;
    this.vel.y = y;
    if (this.vel.x || this.vel.y) this._interrupt();
    this._kick();
  }

  // Passo piccolo (freccia premuta e rilasciata): il più piccolo spostamento assoluto che muove
  // davvero la camera, partendo dalla posizione vera. Niente impulso a velocità: sulla Tenveo un
  // impulso breve alla velocità minima non la faceva partire.
  async stepMove(dx, dy) {
    if (!this.ready) return;
    if (this.opts.invertPan) dx = -dx;
    if (this.opts.invertTilt) dy = -dy;
    this._stopMotion();
    // clic rapidi: i passi vanno in fila (ognuno si fa), il primo prende il posto di un richiamo
    if (!this.stepQueue) this._interrupt();
    const g = this.gen;
    const alive = () => this.gen === g && this.ready;
    const run = (this.stepQueue || Promise.resolve()).then(() => {
      if (!alive()) return null;
      this.lastStepAt = Date.now();
      return this._stepOnce(dx, dy, alive);
    });
    const q = run.catch(() => {}).then(() => { if (this.stepQueue === q) this.stepQueue = null; });
    this.stepQueue = q;
    await run;
  }

  // passo minimo di un asse: quello che ha già mosso la camera, altrimenti un passo della sua
  // griglia (almeno 1/1000 della corsa)
  _minInc(k) {
    const a = this.axes[k];
    if (num(this.minInc[k])) return this.minInc[k];
    return Math.max(a.step || 0, (a.max - a.min) / 1000);
  }

  // Un passo minimo verso dx, dy (segni). Si legge la posizione prima e dopo: se la camera non
  // si è spostata il passo raddoppia (fino al 2% della corsa) e si riprova subito; il passo che
  // funziona resta per i clic successivi. alive(): falso se nel frattempo è arrivato altro.
  async _stepOnce(dx, dy, alive) {
    if (this.relCur.pan || this.relCur.tilt || this.relBusy) await this._relHalt();
    if (!alive()) return;
    if (this.resyncing || this._needsResync()) await this._resync();
    if (!alive()) return;
    await this._idle();
    if (!alive()) return;
    let pre = null;
    try { pre = await this.link.settings(); } catch (_) { pre = null; }
    if (!alive()) return;
    let dirs = [['pan', dx], ['tilt', dy]].filter(([k, v]) => this.axes[k] && v);
    if (pre) {
      // la camera è lontana dall'ultimo valore nostro (telecomando, OBS): si parte da dov'è
      for (const k of ['pan', 'tilt']) {
        if (!this.axes[k] || !num(pre[k]) || !num(this.last[k])) continue;
        if (Math.abs(pre[k] - this.last[k]) > 2 * this._minInc(k)) {
          this.pos[k] = pre[k];
          this.last[k] = quantize(this.axes[k], pre[k]);
          this.ptSync = true;
        }
      }
    }
    for (let tries = 0; dirs.length; tries += 1) {
      const out = {};
      for (const [k, v] of dirs) {
        const a = this.axes[k];
        const base = num(this.last[k]) ? this.last[k] : (num(this.pos[k]) ? this.pos[k] : (a.min + a.max) / 2);
        const q = quantize(a, base + Math.sign(v) * this._minInc(k));
        if (q !== base) { out[k] = q; this.pos[k] = q; }
      }
      if (!Object.keys(out).length) return; // a fine corsa
      this._send(this._withPair(out));
      // eslint-disable-next-line no-await-in-loop
      await this._idle();
      if (!pre || tries >= this.tm.stepGrowMax) return;
      // eslint-disable-next-line no-await-in-loop
      await sleep(this.tm.stepSettleMs);
      if (!alive()) return;
      let st = null;
      // eslint-disable-next-line no-await-in-loop
      try { st = await this.link.settings(); } catch (_) { st = null; }
      if (!alive() || !st) return;
      const stuck = Object.keys(out).filter((k) => num(st[k]) && num(pre[k]) && st[k] === pre[k]);
      // da qui si parte dalla posizione letta (la camera può arrotondare al suo passo vero)
      for (const k of Object.keys(out)) {
        if (num(st[k])) { this.pos[k] = st[k]; this.last[k] = quantize(this.axes[k], st[k]); }
      }
      if (!stuck.length) return;
      for (const k of stuck) {
        const a = this.axes[k];
        const cap = Math.max(a.step || 0, (a.max - a.min) * this.tm.stepIncMaxFrac);
        this.minInc[k] = Math.min(cap, this._minInc(k) * 2);
      }
      if (!this.stepGrewLogged) {
        this.stepGrewLogged = true;
        this.emit('log', t('uvc.stepGrew'));
      }
      dirs = dirs.filter(([k]) => stuck.includes(k));
    }
  }

  // ---- Lento tenuto premuto: passi minimi a ritmo regolare ------------------

  _slowStart(sx, sy) {
    this.slowDir = { x: sx, y: sy };
    if (this.slowTok) return;
    const tok = {};
    this.slowTok = tok;
    const alive = () => this.slowTok === tok && this.ready;
    (async () => {
      while (alive()) {
        const wait = this.lastStepAt + this.tm.slowStepMs - Date.now();
        if (wait > 0) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(Math.min(wait, this.tm.slowStepMs));
          continue;
        }
        this.lastStepAt = Date.now();
        const { x, y } = this.slowDir;
        // eslint-disable-next-line no-await-in-loop
        try { await this._stepOnce(x, y, alive); } catch (_) { /* camera persa: ci pensa _lost */ }
      }
    })();
  }

  _slowStop() {
    this.slowTok = null;
    this.slowDir = null;
  }

  // z in [-1, 1]: >0 stretto (tele), <0 largo
  zoom(z) {
    this.vel.z = this.axes.zoom ? clamp(Number(z) || 0, -1, 1) : 0;
    if (this.vel.z) this._interrupt();
    this._kick();
  }

  // f in [-1, 1]: >0 lontano, <0 vicino. Senza fuoco manuale via USB non fa nulla.
  focus(f) {
    const v = this.axes.focusDistance ? clamp(Number(f) || 0, -1, 1) : 0;
    if (v && this.focusAuto) {
      this.focusAuto = false;
      this._send({ focusMode: 'manual' });
    }
    if (v) this._interrupt();
    this.vel.f = v;
    this._kick();
  }

  setFocusAuto(on) {
    const modes = this.axes.focusModes;
    const mode = on ? (modes.includes('continuous') ? 'continuous' : null) : (modes.includes('manual') ? 'manual' : null);
    if (!mode || !this.ready) return;
    this.focusAuto = !!on;
    this._send({ focusMode: mode });
  }

  focusOnePush() {
    const modes = this.axes.focusModes;
    const mode = modes.includes('single-shot') ? 'single-shot' : (modes.includes('continuous') ? 'continuous' : null);
    if (!mode || !this.ready) return;
    this.focusAuto = mode === 'continuous';
    this._send({ focusMode: mode });
  }

  stopAll() {
    this.gen += 1; // ferma anche un richiamo o Home in corso
    this._stopMotion();
    if (this.relWant.pan || this.relWant.tilt || this.relCur.pan || this.relCur.tilt) this._relDrive(0, 0);
    if (this.absMoving) this._halt();
  }

  // ---- movimento a velocità (pan e tilt relativi) --------------------------

  _relOn() {
    return !!(this.ready && this.rel && this.opts.smooth !== false && this.axes.pan && this.axes.tilt);
  }

  // si chiede all'aiuto (solo Windows) se la camera accetta i comandi a velocità; una volta per
  // avvio: se l'aiuto si blocca o rifiuta, si resta sui passi assoluti
  async _probeRel() {
    if (this.relProbed) { this.rel = this.relCaps || null; return; }
    if (typeof this.link.relCaps !== 'function' || this.opts.smooth === false) return;
    this.relProbed = true;
    let caps = null;
    try {
      caps = await this.link.relCaps();
    } catch (e) {
      if (e && e.name === 'AbortError' && typeof this.link.kill === 'function') this.link.kill(); // aiuto bloccato
      caps = null;
    }
    const ok = (c) => c && num(c.min) && num(c.max) && Math.max(Math.abs(c.min), Math.abs(c.max)) >= 1;
    this.relCaps = caps && ok(caps.pan) && ok(caps.tilt) ? { pan: caps.pan, tilt: caps.tilt } : null;
    this.rel = this.ready ? this.relCaps : null;
    this.emit('log', t(this.relCaps ? 'uvc.smoothOn' : 'uvc.smoothOff'));
  }

  // velocità per la camera: v da -1 a 1 (0 = ferma); la più bassa è 1 (o il passo della gamma)
  _relSpeed(axis, v) {
    if (!v) return 0;
    const c = this.rel && this.rel[axis];
    if (!c) return 0;
    const hi = Math.max(Math.abs(c.min), Math.abs(c.max));
    const lo = Math.min(hi, Math.max(1, num(c.step) && c.step > 1 ? c.step : 1));
    return Math.sign(v) * Math.round(lo + (hi - lo) * Math.min(1, Math.abs(v)));
  }

  _relDrive(pan, tilt) {
    this.relWant = { pan, tilt };
    const moving = !!(pan || tilt);
    clearInterval(this.relKeep);
    this.relKeep = moving ? setInterval(() => this._relFlush(true), this.tm.relKeepMs) : null;
    if (!moving) {
      // la camera si è mossa da sola: al prossimo comando assoluto si rilegge dove si trova
      this.lastSendAt = 0;
      this.syncedAt = 0;
    }
    this._relFlush(false);
  }

  // un comando alla volta all'aiuto; vale sempre l'ultimo chiesto
  _relFlush(keepAlive) {
    if (!this.ready || !this.rel) return;
    if (this.relBusy) { this.relDirty = true; return; }
    const want = { ...this.relWant };
    if (!keepAlive && want.pan === this.relCur.pan && want.tilt === this.relCur.tilt) return;
    if (keepAlive && !want.pan && !want.tilt) return;
    this.relBusy = true;
    this.link.rel(want).then(() => {
      this.relCur = want;
    }, (e) => this._relFailed(e)).finally(() => {
      this.relBusy = false;
      if (this.relDirty) {
        this.relDirty = false;
        this._relFlush(false);
      }
    });
  }

  _relFailed(e) {
    const code = classifyError(e);
    if (code === 'notfound') { this._lost(errorText(code, e)); return; }
    // rifiutato dalla camera: da qui si va a passi assoluti (l'aiuto ha già fermato la camera)
    this._relReset();
    this.rel = null;
    this.relCaps = null;
    this.emit('log', t('uvc.smoothFailed'));
  }

  // ferma subito il movimento a velocità e aspetta la risposta (prima di un comando assoluto)
  async _relHalt() {
    clearInterval(this.relKeep);
    this.relKeep = null;
    this.relWant = { pan: 0, tilt: 0 };
    if (!this.relCur.pan && !this.relCur.tilt && !this.relBusy) return;
    try { await this.link.rel({ pan: 0, tilt: 0 }); } catch (_) { /* l'aiuto ferma comunque */ }
    this.relCur = { pan: 0, tilt: 0 };
    this.lastSendAt = 0;
    this.syncedAt = 0;
  }

  _relReset() {
    clearInterval(this.relKeep);
    this.relKeep = null;
    this.relWant = { pan: 0, tilt: 0 };
    this.relCur = { pan: 0, tilt: 0 };
    this.relDirty = false;
  }

  // ---- posizioni assolute: inquadrature e Home ----------------------------

  // Porta la camera su target ({ pan, tilt, zoom } già sulla sua griglia) con la posizione
  // assoluta salvata, sempre con TUTTI gli assi, qualunque sia la posizione di partenza (niente
  // passi calcolati dalla posizione attuale, che con il telecomando può essere sbagliata).
  //
  // Spinta: molte camere USB ignorano un valore assoluto uguale a quello che hanno già (l'ultimo
  // ricevuto via USB), anche se nel frattempo il telecomando le ha spostate, e spesso via USB
  // continuano a dichiarare quel valore. Per gli assi che la camera (o PTZ Hub) dà già sul punto
  // giusto si manda prima il valore accanto (un passo della griglia) e poco dopo quello giusto:
  // così la camera vede due comandi diversi e si muove davvero.
  //
  // Poi si controlla che la camera ci arrivi: alcune camere USB scartano un comando mentre la testa
  // si muove, quindi se la camera è ferma lontano dal punto giusto il valore si rimanda (con la spinta).
  async _goAbsolute(target, check) {
    const keys = Object.keys(target);
    if (!keys.length) return;
    check();
    if (this.relCur.pan || this.relCur.tilt || this.relBusy) await this._relHalt();
    await this._idle(); // prima finisce quello che era già partito
    check();
    const tol = (k) => {
      const a = this.axes[k];
      return Math.max(a.step || 0, (a.max - a.min) * 0.002, 1e-6);
    };
    const near = (v, k) => num(v) && Math.abs(v - target[k]) <= tol(k);
    // valore accanto a quello giusto: un passo della griglia, verso il centro della corsa
    const kickOf = (k) => {
      const a = this.axes[k];
      const inc = a.step > 0 ? a.step : (a.max - a.min) / 1000;
      const up = target[k] + inc <= a.max && (target[k] - inc < a.min || target[k] <= (a.min + a.max) / 2);
      return quantize(a, target[k] + (up ? inc : -inc));
    };
    let pre = null;
    try { pre = await this.link.settings(); } catch (_) { pre = null; }
    check();
    const kick = keys.filter((k) => near(this.last[k], k) || (pre && near(pre[k], k)));
    const missing = (st) => keys.filter((k) => num(st[k]) && Math.abs(st[k] - target[k]) > tol(k));
    const sameAs = (a, b) => keys.every((k) => a[k] === b[k]);
    const deadline = Date.now() + this.tm.confirmMs;
    Object.assign(this.pos, target);
    this.absMoving = true;
    try {
      if (kick.length) {
        const first = { ...target };
        for (const k of kick) first[k] = kickOf(k);
        this._send(first);
        await this._idle();
        await sleep(this.tm.kickGapMs);
        check();
      }
      this._send({ ...target });
      await this._idle();
      let prev = null;
      let resent = 0;
      let resentAt = Date.now();
      for (;;) {
        check();
        let st = null;
        // eslint-disable-next-line no-await-in-loop
        try { st = await this.link.settings(); } catch (_) { st = null; }
        check();
        if (!st) return; // la camera non comunica la posizione
        const miss = missing(st);
        if (!miss.length) return; // arrivata (o così dice la camera)
        if (Date.now() >= deadline) {
          this.emit('log', t('uvc.notArrived'));
          return;
        }
        // camera ferma ma non sul punto giusto: alcune camere USB, mentre la testa si muove,
        // scartano i valori arrivati subito dopo il primo (va in orizzontale ma non in altezza),
        // altre ignorano il valore che hanno già. Si rimanda UN asse alla volta, a turno tra quelli
        // che mancano, passando dal valore accanto.
        if (prev && sameAs(st, prev) && resent < this.tm.maxResend && Date.now() - resentAt >= this.tm.resendGapMs) {
          const k = miss[resent % miss.length];
          resent += 1;
          this._send({ [k]: kickOf(k) });
          // eslint-disable-next-line no-await-in-loop
          await this._idle();
          // eslint-disable-next-line no-await-in-loop
          await sleep(this.tm.kickGapMs);
          check();
          this._send({ [k]: target[k] });
          // eslint-disable-next-line no-await-in-loop
          await this._idle();
          resentAt = Date.now();
          prev = null;
          // eslint-disable-next-line no-await-in-loop
          await sleep(this.tm.confirmEveryMs);
          continue;
        }
        prev = st;
        // eslint-disable-next-line no-await-in-loop
        await sleep(this.tm.confirmEveryMs);
      }
    } finally {
      this.absMoving = false;
      for (const k of keys) this.last[k] = target[k];
    }
  }

  // STOP durante un richiamo: la camera USB ha già ricevuto la posizione finale; se comunica dove
  // si trova davvero, le si rimanda quel punto così si ferma lì
  async _halt() {
    try {
      const st = await this.link.settings();
      const out = {};
      for (const k of AXES) {
        if (this.axes[k] && st && num(st[k])) out[k] = quantize(this.axes[k], st[k]);
      }
      if (Object.keys(out).length && this.ready) {
        Object.assign(this.pos, out);
        this._send(out);
      }
    } catch (_) { /* camera persa: ci pensa _lost */ }
  }

  // controllo per i richiami: annullato (STOP, Home, comando manuale) o camera persa
  _checker(gen, cancelled) {
    return () => {
      if (!this.ready) throw new Error(this.detail || t('uvc.notConnected'));
      if (this.gen !== gen || (cancelled && cancelled())) throw cancelledError();
    };
  }

  home() {
    if (!this.ready) return Promise.resolve();
    this._stopMotion();
    this.gen += 1;
    const target = {};
    for (const k of ['pan', 'tilt']) {
      const a = this.axes[k];
      // centro: 0 se la camera lo prevede (quasi sempre), altrimenti metà corsa
      if (a) target[k] = quantize(a, a.min <= 0 && a.max >= 0 ? 0 : (a.min + a.max) / 2);
    }
    if (this.axes.zoom) target.zoom = quantize(this.axes.zoom, this.axes.zoom.min);
    return this._goAbsolute(target, this._checker(this.gen, null)).catch((e) => {
      if (!e || e.code !== 'CANCELLED') this.emit('log', e && e.message ? e.message : String(e));
    });
  }

  // Salvataggio: si rilegge SEMPRE la posizione dalla camera (mai i valori ricordati da PTZ Hub).
  // Se la camera non la comunica si dà errore, invece di salvare coordinate forse vecchie.
  async getPosition() {
    this._ensureReady();
    if (this.relCur.pan || this.relCur.tilt || this.relBusy) await this._relHalt();
    await this._idle();
    let s = null;
    try { s = await this.link.settings(); } catch (_) { s = null; }
    const out = { kind: 'usb' };
    for (const k of AXES) {
      const a = this.axes[k];
      if (!a) continue;
      if (!s || !num(s[k])) throw new Error(t('uvc.noRead'));
      out[k] = s[k];
      if (!this.loopTimer && !this.slowTok) { this.pos[k] = out[k]; this.last[k] = quantize(a, out[k]); }
    }
    const mode = typeof s.focusMode === 'string' ? s.focusMode : (this.focusAuto ? 'continuous' : 'manual');
    const dist = num(s.focusDistance) ? s.focusDistance : this.pos.focusDistance;
    // fuoco fisso (manuale o «rapido») salvato come distanza, se la camera la comunica
    const manual = mode === 'manual' || (mode === 'single-shot' && !!this.axes.focusDistance);
    out.focusAuto = !(manual && this.axes.focusDistance && num(dist));
    out.focus = out.focusAuto ? null : dist;
    this.focusAuto = !manual;
    return out;
  }

  async gotoPosition(pos, speed01 = 1, cancelled = null) {
    if (!pos || pos.kind !== 'usb') throw new Error(t('uvc.incompatible'));
    this._ensureReady();
    this._stopMotion();
    this.gen += 1;
    const check = this._checker(this.gen, cancelled);
    const target = {};
    for (const k of AXES) {
      if (this.axes[k] && num(pos[k])) target[k] = quantize(this.axes[k], pos[k]);
    }
    if (!Object.keys(target).length) throw new Error(t('uvc.noPtz'));
    await this._goAbsolute(target, check); // la camera USB va alla sua velocità: speed01 non serve
    // fuoco alla fine, come la camera era al salvataggio. Si manda sempre: col tasto FOCUS del
    // telecomando la camera può essere passata in manuale (o in automatico) senza che PTZ Hub lo sappia
    const modes = this.axes.focusModes;
    if (pos.focusAuto === false && num(pos.focus) && this.axes.focusDistance) {
      const d = quantize(this.axes.focusDistance, pos.focus);
      check();
      this._send({ focusMode: 'manual', focusDistance: d });
      this.pos.focusDistance = d;
      this.last.focusDistance = d;
      this.focusAuto = false;
      await this._idle();
    } else if (pos.focusAuto === true && modes.includes('continuous')) {
      // (senza focusAuto, come per «Centra qui», il fuoco non si tocca)
      check();
      this._send({ focusMode: 'continuous' });
      this.focusAuto = true;
      await this._idle();
    }
  }

  // le camere USB non hanno memorie interne
  async saveSlot() { throw new Error(t('uvc.noSlots')); }

  async recallSlot() { throw new Error(t('uvc.noSlots')); }
}

module.exports = { UvcCamera, TIMING, errorText };
