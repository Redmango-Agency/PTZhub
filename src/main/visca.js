'use strict';
// Driver VISCA per telecamere PTZ.
// Trasporti supportati:
//   - 'udp'  : VISCA "raw" su UDP (tipicamente porta 1259)
//   - 'tcp'  : VISCA "raw" su TCP (tipicamente porta 5678)
//   - 'sony' : Sony VISCA over IP, UDP con header di 8 byte (porta 52381)

const dgram = require('dgram');
const net = require('net');
const { EventEmitter } = require('events');
const { t } = require('../shared/i18n');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function toNibbles(value, count) {
  const out = [];
  for (let i = count - 1; i >= 0; i--) out.push((value >>> (4 * i)) & 0x0f);
  return out;
}

function fromNibbles(bytes) {
  let v = 0;
  for (const b of bytes) v = (v * 16) + (b & 0x0f);
  return v;
}

function hex(buf) {
  return Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

// Divide un buffer in messaggi VISCA terminati da 0xFF.
function splitMessages(buf) {
  const out = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0xff) {
      out.push(buf.subarray(start, i + 1));
      start = i + 1;
    }
  }
  return { messages: out, rest: buf.subarray(start) };
}

const ERROR_KEYS = {
  0x01: 'visca.e01', 0x02: 'visca.e02', 0x03: 'visca.e03', 0x04: 'visca.e04', 0x05: 'visca.e05', 0x41: 'visca.e41',
};

// errore "annullato": il richiamo è stato superato da STOP o da un altro comando
function cancelledError() {
  const e = new Error('cancelled');
  e.code = 'CANCELLED';
  return e;
}

class ViscaTransport extends EventEmitter {
  constructor({ host, port, mode, address = 1 }) {
    super();
    this.host = host;
    this.port = port;
    this.mode = mode; // 'udp' | 'tcp' | 'sony'
    this.address = clamp(address | 0, 1, 7);
    this.seq = 0;
    this.socket = null;
    this.tcpBuffer = Buffer.alloc(0);
    this.connected = false;
    this.closed = false;
    this.pending = null; // inquiry in attesa
    this.inquiryChain = Promise.resolve();
    this.pendingAck = null; // comando in attesa di ACK
    this.ackChain = Promise.resolve();
    this.reconnectTimer = null;
  }

  get header() { return 0x80 | this.address; }
  get replyHeader() { return (this.address + 8) << 4; }

  open() {
    this.closed = false;
    if (this.mode === 'tcp') return this._openTcp();
    return this._openUdp();
  }

  _openUdp() {
    const sock = dgram.createSocket('udp4');
    this.socket = sock;
    sock.on('message', (msg) => this._onData(msg));
    sock.on('error', (err) => {
      this.emit('error', err);
    });
    return new Promise((resolve) => {
      sock.bind(0, () => {
        this.connected = true; // UDP: "connesso" = socket pronto; la salute si verifica con le inquiry
        if (this.mode === 'sony') this._sonyReset();
        resolve();
      });
    });
  }

  _openTcp() {
    return new Promise((resolve) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      this.socket = sock;
      sock.setNoDelay(true);
      sock.setKeepAlive(true, 5000);
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      const timer = setTimeout(() => {
        if (!this.connected) {
          sock.destroy(new Error(t('net.tcpTimeout')));
        }
      }, 3000);
      sock.on('connect', () => {
        clearTimeout(timer);
        this.connected = true;
        this.tcpBuffer = Buffer.alloc(0);
        this.emit('connected');
        done();
      });
      sock.on('data', (d) => {
        this.tcpBuffer = Buffer.concat([this.tcpBuffer, d]);
        const { messages, rest } = splitMessages(this.tcpBuffer);
        this.tcpBuffer = Buffer.from(rest);
        for (const m of messages) this._onMessage(m);
      });
      sock.on('error', (err) => this.emit('error', err));
      sock.on('close', () => {
        clearTimeout(timer);
        const was = this.connected;
        this.connected = false;
        if (was) this.emit('disconnected');
        done();
        if (!this.closed) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => { if (!this.closed) this._openTcp(); }, 2000);
        }
      });
    });
  }

  close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    if (this.pending) {
      this.pending.reject(new Error(t('net.closed')));
      this.pending = null;
    }
    if (this.pendingAck) {
      this.pendingAck.reject(new Error(t('net.closed')));
      this.pendingAck = null;
    }
    if (this.socket) {
      try {
        if (this.mode === 'tcp') this.socket.destroy(); else this.socket.close();
      } catch (_) { /* ignora */ }
    }
    this.socket = null;
    this.connected = false;
  }

  _sonyReset() {
    // Control command RESET: azzera il numero di sequenza lato camera
    const pkt = Buffer.from([0x02, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0x01]);
    this.seq = 0;
    this._rawSend(pkt);
  }

  _wrap(payload, type) {
    if (this.mode !== 'sony') return payload;
    const h = Buffer.alloc(8);
    h.writeUInt16BE(type, 0);
    h.writeUInt16BE(payload.length, 2);
    h.writeUInt32BE(this.seq >>> 0, 4);
    this.seq = (this.seq + 1) >>> 0;
    return Buffer.concat([h, payload]);
  }

  _rawSend(buf) {
    if (!this.socket) return;
    if (this.mode === 'tcp') {
      if (this.connected) this.socket.write(buf);
    } else {
      this.socket.send(buf, this.port, this.host, (err) => { if (err) this.emit('error', err); });
    }
  }

  // body: array di byte SENZA header (0x8x) e SENZA terminatore 0xFF
  send(body) {
    const payload = Buffer.from([this.header, ...body, 0xff]);
    this.emit('tx', payload);
    this._rawSend(this._wrap(payload, 0x0100));
  }

  // Invia un comando e resta in ascolto per un breve intervallo: se la camera risponde con
  // un errore (es. 0x03 "buffer pieno", perché ha solo 2 socket di esecuzione occupati)
  // la promessa viene rifiutata e il chiamante può ritentare. Non si abbinano gli ACK ai
  // comandi (un ACK in ritardo di un comando precedente li confonderebbe): conta solo
  // l'assenza di errori nella finestra.
  sendChecked(body, windowMs = 100) {
    const run = () => new Promise((resolve, reject) => {
      if (this.mode === 'tcp' && !this.connected) {
        reject(new Error(t('net.notConnected')));
        return;
      }
      const timer = setTimeout(() => {
        if (this.pendingAck && this.pendingAck.timer === timer) this.pendingAck = null;
        resolve(true);
      }, windowMs);
      this.pendingAck = {
        timer,
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      this.send(body);
    });
    const p = this.ackChain.then(run, run);
    this.ackChain = p.catch(() => {});
    return p;
  }

  inquire(body, timeoutMs = 900) {
    const run = () => new Promise((resolve, reject) => {
      if (this.mode === 'tcp' && !this.connected) {
        reject(new Error(t('net.notConnected')));
        return;
      }
      const timer = setTimeout(() => {
        if (this.pending && this.pending.timer === timer) this.pending = null;
        reject(new Error(t('net.noReply')));
      }, timeoutMs);
      this.pending = {
        timer,
        resolve: (m) => { clearTimeout(timer); resolve(m); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      const payload = Buffer.from([this.header, ...body, 0xff]);
      this.emit('tx', payload);
      this._rawSend(this._wrap(payload, 0x0110));
    });
    // le inquiry vengono serializzate per abbinare con certezza le risposte
    const p = this.inquiryChain.then(run, run);
    this.inquiryChain = p.catch(() => {});
    return p;
  }

  _onData(msg) {
    let data = msg;
    if (this.mode === 'sony') {
      if (msg.length < 8) return;
      const type = msg.readUInt16BE(0);
      if (type === 0x0201) return; // risposta a control command (reset)
      data = msg.subarray(8);
    }
    const { messages } = splitMessages(data);
    for (const m of messages) this._onMessage(m);
  }

  _onMessage(m) {
    this.emit('rx', m);
    if (m.length < 3) return;
    const kind = m[1] & 0xf0;
    if (kind === 0x40) return; // ACK
    if (kind === 0x50) {
      // Completion. Le risposte alle inquiry hanno dati (len > 3).
      if (m.length > 3 && this.pending) {
        const p = this.pending;
        this.pending = null;
        p.resolve(m);
      }
      return;
    }
    if (kind === 0x60) {
      const code = m[2];
      const socketNo = m[1] & 0x0f;
      const err = new Error(t('visca.error', { detail: ERROR_KEYS[code] ? t(ERROR_KEYS[code]) : t('visca.code', { code: code.toString(16) }) }));
      err.code = code;
      // "buffer pieno" e "non eseguibile" riguardano i comandi; gli altri errori sul
      // socket 0 sono delle inquiry
      if (this.pendingAck && (code === 0x03 || code === 0x41 || !this.pending)) {
        const a = this.pendingAck;
        this.pendingAck = null;
        a.reject(err);
      } else if (this.pending && socketNo === 0 && code !== 0x03) {
        const p = this.pending;
        this.pending = null;
        p.reject(err);
      } else {
        this.emit('visca-error', err);
      }
    }
  }
}

// ---------------------------------------------------------------------------

const PAN_MAX = 0x18;
const TILT_MAX = 0x14;

class ViscaCamera extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.kind = 'visca';
    this.t = new ViscaTransport({
      host: opts.host,
      port: opts.port,
      mode: opts.mode,
      address: opts.address || 1,
    });
    this.lastDrive = null;
    this.lastZoom = null;
    this.lastFocus = null;
    this.state = 'disconnected';
    this.healthTimer = null;
    this.failCount = 0;
    this.t.on('error', (e) => this.emit('log', t('net.error', { error: e.message })));
    this.t.on('visca-error', (e) => this.emit('log', e.message));
    this.t.on('disconnected', () => this._setState('disconnected', t('net.lostRetry')));
    this.t.on('connected', () => {
      // dopo una (ri)connessione TCP: i comandi inviati durante l'interruzione sono
      // andati persi, quindi si manda uno stop per non lasciare la testa in movimento
      this.stopAll();
      this._health();
    });
  }

  _setState(state, detail = '') {
    if (state === this.state && detail === this.detail) return;
    this.state = state;
    this.detail = detail;
    this.emit('status', { state, detail });
  }

  async connect() {
    this._setState('connecting', `${this.opts.host}:${this.opts.port}`);
    await this.t.open();
    this._health();
    this.healthTimer = setInterval(() => this._health(), 3000);
  }

  async _health() {
    try {
      await this.t.inquire([0x09, 0x04, 0x00], 1200); // power inquiry
      this.failCount = 0;
      this._setState('connected', '');
    } catch (e) {
      this.failCount++;
      if (this.failCount >= 2 || this.state !== 'connected') {
        this._setState('error', e.message);
      }
    }
  }

  // Restituisce una promessa: il socket si chiude solo dopo che gli stop sono partiti
  disconnect() {
    clearInterval(this.healthTimer);
    this.t.removeAllListeners('connected');
    try { this.stopAll(); } catch (_) { /* ignora */ }
    this._setState('disconnected', '');
    return new Promise((resolve) => {
      setTimeout(() => { this.t.close(); resolve(); }, 250);
    });
  }

  _ensureLink() {
    if (this.opts.mode === 'tcp' && !this.t.connected) throw new Error(t('net.notConnected'));
  }

  // comando controllato; se la camera è occupata (buffer pieno) si ritenta per ~3 s
  async _cmd(body, { retries = 25, delay = 120, cancelled = null } = {}) {
    for (let i = 0; ; i++) {
      if (cancelled && cancelled()) throw cancelledError();
      try {
        await this.t.sendChecked(body);
        return true;
      } catch (e) {
        if ((e.code === 0x03 || e.code === 0x41) && i < retries) {
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw e;
      }
    }
  }

  // x, y in [-1, 1]. x>0 = destra, y>0 = su.
  move(x, y) {
    const inv = this.opts;
    if (inv.invertPan) x = -x;
    if (inv.invertTilt) y = -y;
    // anche una deviazione minima del joystick deve muovere la testa alla velocità 1
    const ps = Math.abs(x) < 0.001 ? 0 : clamp(Math.round(Math.abs(x) * PAN_MAX), 1, PAN_MAX);
    const ts = Math.abs(y) < 0.001 ? 0 : clamp(Math.round(Math.abs(y) * TILT_MAX), 1, TILT_MAX);
    const panDir = ps === 0 ? 0x03 : (x < 0 ? 0x01 : 0x02);
    const tiltDir = ts === 0 ? 0x03 : (y > 0 ? 0x01 : 0x02);
    const body = [0x01, 0x06, 0x01, Math.max(ps, 1), Math.max(ts, 1), panDir, tiltDir];
    const key = body.join(',');
    if (key === this.lastDrive) return;
    this.lastDrive = key;
    this.t.send(body);
    if (panDir === 0x03 && tiltDir === 0x03) this._resendStop(body);
  }

  // Su UDP un pacchetto di stop perso farebbe continuare il movimento: lo ripetiamo.
  _resendStop(body) {
    if (this.opts.mode === 'tcp') return;
    setTimeout(() => {
      if (this.lastDrive === body.join(',')) this.t.send(body);
    }, 90);
  }

  // z in [-1, 1]: >0 tele (zoom in), <0 wide
  zoom(z) {
    const p = clamp(Math.round(Math.abs(z) * 7), 0, 7);
    let body;
    if (Math.abs(z) < 0.01) body = [0x01, 0x04, 0x07, 0x00];
    else body = [0x01, 0x04, 0x07, (z > 0 ? 0x20 : 0x30) | p];
    const key = body.join(',');
    if (key === this.lastZoom) return;
    this.lastZoom = key;
    this.t.send(body);
    if (body[3] === 0x00) this._resend(body, () => this.lastZoom === key);
  }

  // f in [-1, 1]: >0 lontano (far), <0 vicino (near)
  focus(f) {
    const p = clamp(Math.round(Math.abs(f) * 7), 0, 7);
    let body;
    if (Math.abs(f) < 0.01) body = [0x01, 0x04, 0x08, 0x00];
    else body = [0x01, 0x04, 0x08, (f > 0 ? 0x20 : 0x30) | p];
    const key = body.join(',');
    if (key === this.lastFocus) return;
    this.lastFocus = key;
    this.t.send(body);
    if (body[3] === 0x00) this._resend(body, () => this.lastFocus === key);
  }

  _resend(body, stillValid) {
    if (this.opts.mode === 'tcp') return;
    setTimeout(() => { if (stillValid()) this.t.send(body); }, 90);
  }

  setFocusAuto(on) {
    this.t.send([0x01, 0x04, 0x38, on ? 0x02 : 0x03]);
  }

  focusOnePush() {
    this.t.send([0x01, 0x04, 0x18, 0x01]);
  }

  home() {
    this.lastDrive = null;
    this.t.send([0x01, 0x06, 0x04]);
  }

  stopAll() {
    this.lastDrive = null;
    this.lastZoom = null;
    this.lastFocus = null;
    this.move(0, 0);
    this.zoom(0);
    this.focus(0);
  }

  async getPosition() {
    const pt = await this.t.inquire([0x09, 0x06, 0x12]);
    // risposta: y0 50 [pan: 4 o 5 nibble] [tilt: 4 nibble] FF
    const data = pt.subarray(2, pt.length - 1);
    if (data.length !== 8 && data.length !== 9) {
      throw new Error(t('visca.badPosition', { reply: hex(pt) }));
    }
    const panDigits = data.length - 4;
    const pan = { raw: fromNibbles(data.subarray(0, panDigits)), digits: panDigits };
    const tilt = { raw: fromNibbles(data.subarray(panDigits)), digits: 4 };

    const zr = await this.t.inquire([0x09, 0x04, 0x47]);
    if (zr.length !== 7) throw new Error(t('visca.badZoom', { reply: hex(zr) }));
    const zoom = fromNibbles(zr.subarray(2, 6));

    let focusAuto = true;
    let focus = null;
    try {
      const fm = await this.t.inquire([0x09, 0x04, 0x38]);
      focusAuto = fm[2] !== 0x03;
      if (!focusAuto) {
        const fp = await this.t.inquire([0x09, 0x04, 0x48]);
        if (fp.length === 7) focus = fromNibbles(fp.subarray(2, 6));
      }
    } catch (_) {
      // alcune camere non rispondono alle inquiry di fuoco: si tiene l'autofocus
    }
    return { kind: 'visca', pan, tilt, zoom, focusAuto, focus };
  }

  // speed01 in (0, 1]
  async gotoPosition(pos, speed01 = 1, cancelled = null) {
    if (!pos || pos.kind !== 'visca') throw new Error(t('visca.incompatible'));
    this._ensureLink();
    this.lastDrive = null;
    this.lastZoom = null;
    this.lastFocus = null;
    const ps = clamp(Math.round(speed01 * PAN_MAX), 1, PAN_MAX);
    const ts = clamp(Math.round(speed01 * TILT_MAX), 1, TILT_MAX);
    const manual = pos.focusAuto === false && pos.focus != null;
    // ordine: pan/tilt (parte subito), modalità fuoco, zoom, fuoco manuale.
    // Ogni comando che la camera rifiuta perché occupata viene ritentato.
    // cancelled(): vero se è arrivato STOP o un altro comando; i passi che mancano non partono
    const opt = { cancelled };
    const soft = async (what, body) => {
      try {
        await this._cmd(body, opt);
      } catch (e) {
        if (e.code === 'CANCELLED') throw e;
        this.emit('log', t('visca.recall', { what: t(`visca.what.${what}`), error: e.message }));
      }
    };
    await this._cmd([
      0x01, 0x06, 0x02, ps, ts,
      ...toNibbles(pos.pan.raw, pos.pan.digits),
      ...toNibbles(pos.tilt.raw, pos.tilt.digits),
    ], opt);
    await soft('focusMode', [0x01, 0x04, 0x38, manual ? 0x03 : 0x02]);
    await soft('zoom', [0x01, 0x04, 0x47, ...toNibbles(pos.zoom, 4)]);
    if (manual) await soft('focus', [0x01, 0x04, 0x48, ...toNibbles(pos.focus, 4)]);
  }

  async saveSlot(n) {
    this._ensureLink();
    await this._cmd([0x01, 0x04, 0x3f, 0x01, clamp(n | 0, 0, 254)]);
  }

  async recallSlot(n, cancelled = null) {
    this._ensureLink();
    this.lastDrive = null;
    this.lastZoom = null;
    this.lastFocus = null;
    await this._cmd([0x01, 0x04, 0x3f, 0x02, clamp(n | 0, 0, 254)], { cancelled });
  }
}

module.exports = { ViscaCamera, ViscaTransport, toNibbles, fromNibbles, splitMessages, hex };
