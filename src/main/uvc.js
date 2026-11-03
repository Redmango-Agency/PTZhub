'use strict';
// Driver USB (UVC) per le telecamere collegate al PC con il cavo USB. In prova.
//
// Chromium comanda pan, tilt e zoom di una camera USB solo attraverso un MediaStreamTrack
// (getUserMedia con pan/tilt/zoom, poi applyConstraints). Il track vive in una finestra nascosta
// (uvc-link.js); questo driver ha la stessa interfaccia di quelli VISCA e ONVIF verso l'hub e gli
// manda soltanto valori assoluti.
//
// Le camere USB accettano solo posizioni assolute: il movimento continuo (joystick, frecce,
// Stream Deck, pannello OBS) si ottiene spostando la posizione a piccoli passi, 25 volte al secondo,
// in base alla velocità. STOP ferma subito gli incrementi. Un comando alla volta verso la camera:
// se è ancora occupata con il precedente si manda solo l'ultimo valore.

const { EventEmitter } = require('events');
const { t } = require('../shared/i18n');
const { analyzeCaps, quantize, classifyError } = require('../shared/uvc-caps');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TIMING = {
  tickMs: 40, // 25 aggiornamenti al secondo
  ptFullS: 8, // pan/tilt: la corsa più lunga in 8 s con il joystick al massimo
  zoomFullS: 5, // zoom: da largo a stretto in 5 s
  focusFullS: 4, // fuoco: tutta la corsa in 4 s
  confirmEveryMs: 300, // richiamo: ogni quanto si controlla che la camera sia arrivata
  confirmMs: 12000, // per quanto al massimo (le camere lente impiegano qualche secondo)
  maxResend: 4, // quante volte si rimanda la posizione se la camera si è fermata altrove
  retryMs: 3000, // camera scollegata o occupata: si riprova ogni 3 s
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
      this._scheduleRetry();
      return;
    }
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
    if (this.loopTimer) return;
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
    if (Object.keys(out).length) this._send(out);
  }

  // un comando manuale prende il posto di un richiamo o di Home in corso
  _interrupt() { this.gen += 1; }

  // x, y in [-1, 1]. x>0 = destra, y>0 = su (UVC: pan positivo = orario visto dall'alto, tilt positivo = su)
  move(x, y) {
    if (this.opts.invertPan) x = -x;
    if (this.opts.invertTilt) y = -y;
    this.vel.x = this.axes.pan ? clamp(Number(x) || 0, -1, 1) : 0;
    this.vel.y = this.axes.tilt ? clamp(Number(y) || 0, -1, 1) : 0;
    if (this.vel.x || this.vel.y) this._interrupt();
    this._kick();
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
    if (this.absMoving) this._halt();
  }

  // ---- posizioni assolute: inquadrature e Home ----------------------------

  // Porta la camera su target ({ pan, tilt, zoom } già sulla sua griglia) con UN comando assoluto:
  // si va sempre alla posizione salvata, qualunque sia quella di partenza (niente passi calcolati
  // dalla posizione attuale, che con il telecomando o un comando perso può essere sbagliata).
  // Poi si controlla che la camera ci arrivi: alcune camere USB scartano un comando mentre la testa
  // si muove, quindi se la camera è ferma lontano dal punto giusto il valore si rimanda.
  async _goAbsolute(target, check) {
    const keys = Object.keys(target);
    if (!keys.length) return;
    check();
    await this._idle(); // prima finisce quello che era già partito
    check();
    Object.assign(this.pos, target);
    const tol = (k) => {
      const a = this.axes[k];
      return Math.max(a.step || 0, (a.max - a.min) * 0.002, 1e-6);
    };
    const arrived = (st) => keys.every((k) => !num(st[k]) || Math.abs(st[k] - target[k]) <= tol(k));
    const sameAs = (a, b) => keys.every((k) => a[k] === b[k]);
    const deadline = Date.now() + this.tm.confirmMs;
    this.absMoving = true;
    try {
      this._send({ ...target });
      await this._idle();
      let prev = null;
      let resent = 0;
      for (;;) {
        check();
        let st = null;
        // eslint-disable-next-line no-await-in-loop
        try { st = await this.link.settings(); } catch (_) { st = null; }
        check();
        if (!st || arrived(st)) return; // arrivata (o la camera non comunica la posizione)
        if (Date.now() >= deadline) {
          this.emit('log', t('uvc.notArrived'));
          return;
        }
        // camera ferma ma non sul punto giusto: il comando è andato perso, si rimanda
        if (prev && sameAs(st, prev) && resent < this.tm.maxResend) {
          resent += 1;
          this._send({ ...target });
          // eslint-disable-next-line no-await-in-loop
          await this._idle();
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

  async getPosition() {
    this._ensureReady();
    await this._idle();
    let s = null;
    try { s = await this.link.settings(); } catch (_) { /* si usano i valori mandati */ }
    const out = { kind: 'usb' };
    for (const k of AXES) {
      const a = this.axes[k];
      if (!a) continue;
      out[k] = s && num(s[k]) ? s[k] : quantize(a, this.pos[k]);
      if (!this.loopTimer) { this.pos[k] = out[k]; this.last[k] = out[k]; }
    }
    const mode = s && typeof s.focusMode === 'string' ? s.focusMode : (this.focusAuto ? 'continuous' : 'manual');
    const dist = s && num(s.focusDistance) ? s.focusDistance : this.pos.focusDistance;
    // fuoco fisso (manuale o «rapido») salvato come distanza, se la camera la comunica
    const manual = mode === 'manual' || (mode === 'single-shot' && !!this.axes.focusDistance);
    out.focusAuto = !(manual && this.axes.focusDistance && num(dist));
    out.focus = out.focusAuto ? null : dist;
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
    // fuoco alla fine, come la camera era al salvataggio
    const f = {};
    const modes = this.axes.focusModes;
    if (pos.focusAuto === false && num(pos.focus) && this.axes.focusDistance) {
      f.focusMode = 'manual';
      f.focusDistance = quantize(this.axes.focusDistance, pos.focus);
      this.pos.focusDistance = f.focusDistance;
      this.focusAuto = false;
    } else if (pos.focusAuto !== false && modes.includes('continuous') && !this.focusAuto) {
      f.focusMode = 'continuous';
      this.focusAuto = true;
    }
    if (Object.keys(f).length) {
      check();
      this._send(f);
      await this._idle();
    }
  }

  // le camere USB non hanno memorie interne
  async saveSlot() { throw new Error(t('uvc.noSlots')); }

  async recallSlot() { throw new Error(t('uvc.noSlots')); }
}

module.exports = { UvcCamera, TIMING, errorText };
