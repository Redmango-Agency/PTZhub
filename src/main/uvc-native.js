'use strict';
// Camera USB su Windows senza aprire il video: i comandi passano da ptzhub-uvc.exe
// (DirectShow IAMCameraControl, la stessa interfaccia della scheda «Controllo telecamera» di OBS).
// Così OBS o Zoom possono usare il video della camera mentre PTZ Hub la muove, anche su Windows 10,
// dove non c'è l'opzione «più app insieme» di Windows 11.
// Stessa interfaccia di UvcLink (finestra nascosta con getUserMedia), usata da UvcCamera in uvc.js.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

let seq = 0;

function remoteError(err) {
  const e = new Error((err && err.message) || 'errore USB');
  e.name = (err && err.name) || 'Error';
  return e;
}

// Etichetta di Chromium su Windows: «Nome della camera (046d:0825)» -> nome e «vid_046d&pid_0825»
function parseLabel(label) {
  const s = String(label || '').replace(/[\t\r\n]/g, ' ').trim();
  const m = /^(.*?)\s*\(([0-9a-f]{4}):([0-9a-f]{4})\)\s*$/i.exec(s);
  if (!m) return { name: s, vidpid: '' };
  return { name: m[1].trim(), vidpid: `vid_${m[2].toLowerCase()}&pid_${m[3].toLowerCase()}` };
}

// Dove si trova l'aiuto: nel pacchetto (resources/uvc) o, in sviluppo, in vendor/uvc-win
function helperPath({ packaged = false, resourcesPath = '' } = {}) {
  if (process.platform !== 'win32') return null;
  const p = packaged
    ? path.join(resourcesPath, 'uvc', 'ptzhub-uvc.exe')
    : path.join(__dirname, '..', '..', 'vendor', 'uvc-win', 'ptzhub-uvc.exe');
  return fs.existsSync(p) ? p : null;
}

class UvcNativeLink extends EventEmitter {
  // exe: percorso di ptzhub-uvc.exe; args: solo per i test (aiuto finto in Node)
  constructor({ exe, args = [] } = {}) {
    super();
    this.exe = exe;
    this.args = args;
    this.proc = null;
    this.buf = '';
    this.pending = new Map();
    this.destroyed = false;
  }

  _failAll(err) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  _ensure() {
    if (this.destroyed) throw remoteError({ name: 'InvalidStateError', message: 'USB chiuso' });
    if (this.proc) return this.proc;
    if (!this.exe) throw remoteError({ name: 'NotFoundError', message: 'ptzhub-uvc.exe mancante' });
    const proc = spawn(this.exe, this.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.proc = proc;
    this.buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => this._onData(d));
    proc.stdin.on('error', () => {}); // aiuto già chiuso: lo segnala 'exit'
    const gone = () => {
      if (this.proc !== proc) return;
      this.proc = null;
      this._failAll(remoteError({ name: 'InvalidStateError', message: 'aiuto USB chiuso' }));
      if (!this.destroyed) this.emit('gone');
    };
    proc.on('error', gone);
    proc.on('exit', gone);
    return proc;
  }

  _onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(remoteError(msg));
    }
  }

  request(cmd, args = [], timeoutMs = 4000) {
    let proc;
    try { proc = this._ensure(); } catch (e) { return Promise.reject(e); }
    seq += 1;
    const id = seq;
    const clean = args.map((a) => String(a).replace(/[\t\r\n]/g, ' '));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(remoteError({ name: 'AbortError', message: 'la camera USB non risponde' }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      proc.stdin.write(`${[id, cmd, ...clean].join('\t')}\n`);
    });
  }

  async open({ deviceId = '', label = '' } = {}) {
    const { name, vidpid } = parseLabel(label);
    const v = await this.request('open', [name, vidpid], 10000);
    return {
      deviceId,
      label: label || (v && v.label) || '',
      caps: (v && v.caps) || {},
      settings: (v && v.settings) || {},
    };
  }

  apply(values) {
    const parts = [];
    for (const [k, v] of Object.entries(values || {})) {
      if (k === 'focusMode') {
        if (v === 'manual' || v === 'continuous' || v === 'single-shot') parts.push(`focusMode=${v === 'manual' ? 'manual' : 'continuous'}`);
      } else if (['pan', 'tilt', 'zoom', 'focusDistance'].includes(k) && Number.isFinite(Number(v))) {
        parts.push(`${k}=${Number(v)}`);
      }
    }
    return this.request('set', parts, 3000);
  }

  settings() { return this.request('get', [], 3000); }

  // elenco delle camere con le capacità (verifica nelle Impostazioni e nel primo avvio)
  list() { return this.request('list', [], 15000); }

  close() {
    if (!this.proc) return Promise.resolve();
    return this.request('close', [], 2000).catch(() => {});
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._failAll(remoteError({ name: 'InvalidStateError', message: 'USB chiuso' }));
    const p = this.proc;
    this.proc = null;
    if (p) {
      try { p.stdin.end(); } catch (_) { /* già chiuso */ }
      setTimeout(() => { try { p.kill(); } catch (_) { /* già uscito */ } }, 500).unref();
    }
    this.removeAllListeners();
  }
}

// Verifica di una camera (Impostazioni, primo avvio): apre, legge le capacità e chiude
async function probeNative(exe, label) {
  const link = new UvcNativeLink({ exe });
  try {
    const r = await link.open({ label });
    return { ok: true, label: r.label, caps: r.caps };
  } catch (e) {
    return { ok: false, name: e.name || 'Error', message: e.message || String(e) };
  } finally {
    await link.close();
    link.destroy();
  }
}

module.exports = { UvcNativeLink, parseLabel, helperPath, probeNative };
