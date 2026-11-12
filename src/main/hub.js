'use strict';
// Centro operativo: tutte le funzioni richiamabili dall'app, dal pannello OBS,
// dai tasti globali e dagli indirizzi web (Stream Deck, Companion…) passano da qui.
// Così la camera riceve i comandi da un solo punto e tutti vedono lo stesso stato.

const { EventEmitter } = require('events');
const { t } = require('../shared/i18n');
const CENTER = require('../shared/center');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const DIRS = { up: [0, 1], down: [0, -1], left: [-1, 0], right: [1, 0] };

// Funzioni fisse; quelle delle inquadrature si aggiungono per ogni preset ("preset:<id>")
const FIXED_ACTIONS = [
  'stop', 'home', 'next', 'prev', 'zoom:in', 'zoom:out',
  'nudge:up', 'nudge:down', 'nudge:left', 'nudge:right', 'onepush',
];

class Hub extends EventEmitter {
  constructor({ store, getCamera, getCamStatus }) {
    super();
    this.store = store;
    this.getCamera = getCamera;
    this.getCamStatus = getCamStatus || (() => ({ state: 'disconnected', detail: '' }));
    this.activeId = null;
    this.editing = false;
    this.pulseTimer = null;
    this.zoomTimer = null;
    this.moveWatchdog = null;
    this.remoteMoving = false;
    this.pulseOn = false; // spostamento a impulso in corso (nudge)
    this.zoomPulseOn = false; // zoom a impulso in corso
    this.lastRemote = null; // ultima velocità ricevuta dal pannello OBS
    this.stopHoldUntil = 0; // subito dopo STOP si ignorano movimenti remoti arrivati in ritardo
    // ogni richiamo ha un numero: STOP, Home, un comando manuale o un richiamo più recente
    // lo rendono superato, così i passi che mancano non partono più
    this.gen = 0;
    this.targetId = null; // inquadratura verso cui la camera sta andando
  }

  camera() {
    const c = this.getCamera();
    if (!c) throw new Error(t('main.configureFirst'));
    return c;
  }

  presets() { return this.store.presets || []; }

  // ---- stato condiviso -----------------------------------------------------

  state() {
    const cam = this.store.settings.camera || {};
    const list = this.presets();
    // camera USB: al posto dell'indirizzo IP si mostra «USB» (pannello OBS, Stream Deck)
    const usb = cam.protocol === 'usb';
    const host = usb ? (cam.usbDeviceId || cam.usbLabel ? 'USB' : '') : (cam.host || '');
    return {
      camera: { ...this.getCamStatus(), host, name: cam.name || '', protocol: cam.protocol || '' },
      activeId: this.activeId,
      targetId: this.targetId, // richiamo in corso (la camera sta andando lì), null se nessuno
      activeIndex: list.findIndex((p) => p.id === this.activeId) + 1, // da 1, come /api/recall/<n>; 0 = nessuna
      editing: this.editing,
      moveSpeed: this.store.settings.moveSpeed,
      presets: list.map((p, i) => ({
        index: i + 1, id: p.id, name: p.name, hasThumb: !!p.thumb, v: p.updatedAt || '',
      })),
    };
  }

  changed() { this.emit('change', this.state()); }

  setActive(id) {
    this.activeId = id;
    this.emit('active', id);
    this.changed();
  }

  setEditing(on) {
    if (this.editing === !!on) return;
    this.editing = !!on;
    this.changed();
  }

  // comandi da fuori (OBS, Stream Deck, tasti globali) mentre si modifica un'inquadratura:
  // spostarebbero la posizione che sta per essere salvata
  _guardRemote(opts) {
    if (opts && opts.remote && this.editing) throw new Error(t('api.editing'));
  }

  _supersede() {
    const had = this.targetId;
    this.gen += 1;
    this.targetId = null;
    if (had) this.changed(); // chi guarda lo stato (Stream Deck, OBS) vede che non sta più arrivando
  }

  presetsChanged() {
    if (this.activeId && !this.presets().some((p) => p.id === this.activeId)) this.activeId = null;
    this.changed();
  }

  // ---- richiami ------------------------------------------------------------

  // Ritorna l'inquadratura richiamata, oppure null se nel frattempo è arrivato STOP,
  // Home, un comando manuale o un altro richiamo (in quel caso non è un errore).
  // force: il richiamo fatto dall'editor stesso, che passa anche durante la modifica.
  async recall(p, speed, { force = false } = {}) {
    if (!p) throw new Error(t('api.noPreset'));
    if (this.editing && !force) throw new Error(t('api.editing'));
    const cam = this.camera();
    this._cancelManual(cam);
    this.gen += 1;
    const gen = this.gen;
    const cancelled = () => this.gen !== gen;
    this.targetId = p.id;
    this.changed();
    const sp = speed != null ? speed : this.store.settings.recallSpeed;
    try {
      if (p.pos) await cam.gotoPosition(p.pos, sp, cancelled);
      else if (p.slot != null) await cam.recallSlot(p.slot, cancelled);
      else throw new Error(t('presets.noPosition'));
    } catch (e) {
      if (cancelled()) return null;
      // richiamo fermato dal driver stesso (per esempio un comando manuale arrivato direttamente
      // alla camera): non è un errore, ma l'inquadratura non è più «in arrivo»
      this.targetId = null;
      this.changed();
      if (e && e.code === 'CANCELLED') return null;
      throw e;
    }
    if (cancelled()) return null;
    this.targetId = null;
    this.setActive(p.id);
    return p;
  }

  recallId(id, speed, opts) { return this.recall(this.presets().find((p) => p.id === id), speed, opts); }

  recallIndex(n) { return this.recall(this.presets()[n - 1]); }

  step(delta) {
    const list = this.presets();
    if (!list.length) throw new Error(t('api.noPreset'));
    // se un richiamo è ancora in corso si parte da lì (due "successiva" rapide = due passi)
    const ref = this.targetId || this.activeId;
    const cur = list.findIndex((p) => p.id === ref);
    let i;
    if (cur < 0) i = delta > 0 ? 0 : list.length - 1;
    else i = (cur + delta + list.length) % list.length;
    return this.recall(list[i]);
  }

  // ---- comandi manuali -----------------------------------------------------

  // Annulla impulsi e movimento remoto in corso. Lo stop che il timer annullato avrebbe
  // mandato parte subito: altrimenti la testa resterebbe in movimento.
  _cancelManual(cam) {
    clearTimeout(this.pulseTimer);
    clearTimeout(this.zoomTimer);
    clearTimeout(this.moveWatchdog);
    const pan = this.pulseOn || this.remoteMoving;
    const zoom = this.zoomPulseOn || this.remoteMoving;
    this.pulseOn = false;
    this.zoomPulseOn = false;
    this.remoteMoving = false;
    this.lastRemote = null;
    try { if (pan) cam.move(0, 0); } catch (_) { /* si prova comunque lo zoom */ }
    try { if (zoom) cam.zoom(0); } catch (_) { /* ignora */ }
  }

  stop() {
    this._supersede();
    clearTimeout(this.pulseTimer);
    clearTimeout(this.zoomTimer);
    clearTimeout(this.moveWatchdog);
    this.pulseOn = false;
    this.zoomPulseOn = false;
    this.remoteMoving = false;
    this.lastRemote = null;
    this.stopHoldUntil = Date.now() + 400;
    this.camera().stopAll();
    this.emit('stopped');
  }

  home(opts) {
    this._guardRemote(opts);
    const cam = this.camera();
    this._cancelManual(cam);
    this._supersede();
    const r = cam.home();
    if (r && typeof r.catch === 'function') r.catch(() => {});
    this.setActive(null);
  }

  onePush() { this.camera().focusOnePush(); }

  // Passo minimo per centrare l'inquadratura (freccia premuta e rilasciata subito):
  // camera USB = un passo della sua griglia; camere di rete = impulso brevissimo alla velocità più bassa
  stepMove(dir, opts) {
    const d = DIRS[dir];
    if (!d) throw new Error(t('api.badCommand'));
    this._guardRemote(opts);
    const cam = this.camera();
    this._supersede();
    this.emit('manual');
    if (typeof cam.stepMove === 'function') {
      const r = cam.stepMove(d[0], d[1]); // USB: prima rilegge la posizione vera (asincrono)
      if (r && typeof r.catch === 'function') r.catch(() => {});
      return;
    }
    clearTimeout(this.pulseTimer);
    this.pulseOn = true;
    cam.move(d[0] * 0.01, d[1] * 0.01);
    this.pulseTimer = setTimeout(() => {
      this.pulseOn = false;
      cam.move(0, 0);
    }, 120);
  }

  // Comandi manuali dall'app (frecce tenute, tastiera, zoom, fuoco). Come gli altri comandi manuali
  // interrompono un richiamo in corso anche con VISCA e ONVIF (prima arrivavano direttamente alla
  // camera: il richiamo VISCA mandava ancora zoom e fuoco dopo che si era già ripreso a muovere a
  // mano) e prendono il posto di un impulso da Stream Deck, il cui stop li fermerebbe a metà.
  manualMove(x, y) {
    const cam = this.camera();
    if (x || y) {
      clearTimeout(this.pulseTimer);
      this.pulseOn = false;
      this._supersede();
    }
    cam.move(x, y);
  }

  manualZoom(z) {
    const cam = this.camera();
    if (z) {
      clearTimeout(this.zoomTimer);
      this.zoomPulseOn = false;
      this._supersede();
    }
    cam.zoom(z);
  }

  manualFocus(f) {
    const cam = this.camera();
    if (f) this._supersede();
    cam.focus(f);
  }

  // «Centra qui» (conti in src/shared/center.js): un passo verso il punto cliccato nell'anteprima.
  // ox, oy = scarto del punto dal centro del video vero (frazioni, + = destra / in basso).
  // È un comando manuale: ferma impulsi e richiami. Risponde con i fattori usati, così
  // l'interfaccia misura di quanto si è spostata davvero l'immagine e corregge la taratura.
  async centerStep(ox, oy, aspect) {
    const cam = this.camera();
    if (typeof cam.getPosition !== 'function' || typeof cam.gotoPosition !== 'function') throw new Error(t('ctr.unsupported'));
    this._cancelManual(cam);
    this._supersede();
    this.gen += 1;
    const gen = this.gen;
    const cancelled = () => this.gen !== gen;
    cam.stopAll();
    await sleep(150); // la testa si ferma prima della lettura
    if (cancelled()) return { moved: false };
    let pos;
    try { pos = await cam.getPosition(); } catch (e) { throw new Error(t('ctr.noPosition', { error: e.message })); }
    if (cancelled()) return { moved: false };
    const cfg = this.store.settings.camera || {};
    const cal = (this.store.settings.centerCal || {})[CENTER.camKey(cfg)];
    const ctx = { axes: cam.axes };
    const plan = CENTER.planStep({
      ox: clamp(Number(ox) || 0, -0.5, 0.5),
      oy: clamp(Number(oy) || 0, -0.5, 0.5),
      pos, ctx, cal, aspect: Number(aspect) || 16 / 9,
      invertPan: !!cfg.invertPan, invertTilt: !!cfg.invertTilt,
    });
    if (!plan) throw new Error(t('ctr.unsupported'));
    const to = CENTER.applyOffset(pos, plan.dPan, plan.dTilt, ctx);
    if (!to) return { moved: false, bucket: plan.bucket, fPan: plan.fPan, fTilt: plan.fTilt };
    try {
      await cam.gotoPosition(to, 0.5, cancelled);
    } catch (e) {
      if (cancelled() || (e && e.code === 'CANCELLED')) return { moved: false };
      throw e;
    }
    if (cancelled()) return { moved: false };
    return { moved: true, bucket: plan.bucket, fPan: plan.fPan, fTilt: plan.fTilt };
  }

  // taratura misurata dall'interfaccia: fattore per asse e fascia di zoom, ricordato per camera
  centerLearn({ bucket, pan, tilt } = {}) {
    const b = Math.round(Number(bucket));
    if (!(b >= 0 && b < CENTER.BUCKETS)) return;
    const ok = (f) => num(f) && Math.abs(f) >= 0.1 && Math.abs(f) <= 10;
    if (!ok(pan) && !ok(tilt)) return;
    const key = CENTER.camKey(this.store.settings.camera);
    const cur = (this.store.settings.centerCal || {})[key] || {};
    const next = { pan: { ...(cur.pan || {}) }, tilt: { ...(cur.tilt || {}) } };
    if (ok(pan)) next.pan[b] = pan;
    if (ok(tilt)) next.tilt[b] = tilt;
    this.store.saveSettings({ centerCal: { [key]: next } });
  }

  // Piccolo spostamento: muove per ms millisecondi e si ferma da solo (ideale per un tasto)
  nudge(dir, ms = 300, speed, opts) {
    const d = DIRS[dir];
    if (!d) throw new Error(t('api.badCommand'));
    this._guardRemote(opts);
    this.emit('manual');
    const cam = this.camera();
    const sp = clamp(speed != null ? speed : this.store.settings.moveSpeed, 0.05, 1);
    this._supersede(); // un comando manuale prende il posto di un richiamo in corso
    clearTimeout(this.pulseTimer);
    this.pulseOn = true;
    cam.move(d[0] * sp, d[1] * sp);
    this.pulseTimer = setTimeout(() => {
      this.pulseOn = false;
      cam.move(0, 0);
    }, clamp(ms, 50, 5000));
  }

  zoomPulse(dir, ms = 300, speed, opts) {
    if (dir !== 'in' && dir !== 'out') throw new Error(t('api.badCommand'));
    this._guardRemote(opts);
    this.emit('manual');
    const cam = this.camera();
    const sp = clamp(speed != null ? speed : this.store.settings.moveSpeed, 0.05, 1);
    this._supersede();
    clearTimeout(this.zoomTimer);
    this.zoomPulseOn = true;
    cam.zoom(dir === 'in' ? sp : -sp);
    this.zoomTimer = setTimeout(() => {
      this.zoomPulseOn = false;
      cam.zoom(0);
    }, clamp(ms, 50, 5000));
  }

  // Movimento continuo da remoto (pannello OBS): va rinnovato di continuo,
  // altrimenti dopo 700 ms la testa si ferma da sola (rete o finestra persa).
  remoteMove(x, y, z) {
    const v = [clamp(x, -1, 1), clamp(y, -1, 1), clamp(z, -1, 1)];
    const moving = v.some((n) => n !== 0);
    if (moving) {
      this._guardRemote({ remote: true });
      // un movimento arrivato in ritardo subito dopo STOP non deve ripartire
      if (Date.now() < this.stopHoldUntil) return;
      this.emit('manual');
    }
    const cam = this.camera();
    clearTimeout(this.moveWatchdog);
    const same = moving && this.remoteMoving && this.lastRemote
      && v.every((n, i) => n === this.lastRemote[i]);
    // stessa velocità di prima: si rinnova solo il controllo, senza ripetere il comando
    if (!same) {
      if (moving) this._supersede();
      cam.move(v[0], v[1]);
      cam.zoom(v[2]);
    }
    this.remoteMoving = moving;
    this.lastRemote = moving ? v : null;
    if (moving) {
      this.moveWatchdog = setTimeout(() => {
        this.remoteMoving = false;
        this.lastRemote = null;
        cam.move(0, 0);
        cam.zoom(0);
      }, 700);
    }
  }

  // ---- funzioni per nome (tasti globali e indirizzi web) -------------------

  actionIds() {
    return [...FIXED_ACTIONS, ...this.presets().map((p) => `preset:${p.id}`)];
  }

  // opts.remote (predefinito): il comando arriva da fuori (tasti globali, indirizzi web)
  async run(action, opts = { remote: true }) {
    const [kind, arg] = String(action).split(/:(.*)/s);
    switch (kind) {
      case 'stop': return this.stop();
      case 'home': return this.home(opts);
      case 'next': return this.step(1);
      case 'prev': return this.step(-1);
      case 'onepush': return this.onePush();
      case 'zoom': return this.zoomPulse(arg, undefined, undefined, opts);
      case 'nudge': return this.nudge(arg, undefined, undefined, opts);
      case 'preset': return this.recallId(arg);
      default: throw new Error(t('api.badCommand'));
    }
  }

  thumb(id) {
    const p = this.presets().find((x) => x.id === id);
    if (!p || !p.thumb) return null;
    const m = /^data:image\/(\w+);base64,(.*)$/.exec(p.thumb);
    if (!m) return null;
    return { type: `image/${m[1]}`, data: Buffer.from(m[2], 'base64') };
  }
}

module.exports = { Hub, FIXED_ACTIONS };
