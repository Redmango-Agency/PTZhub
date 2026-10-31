'use strict';
// Collegamento tra il driver USB (processo principale) e la finestra nascosta che tiene aperto
// il MediaStreamTrack della camera. Il track esiste solo in una pagina: questa finestra non si
// vede mai, resta aperta anche nelle viste ridotte e senza anteprima, e riceve i comandi via IPC.
// Una finestra per ogni camera USB: si chiude con disconnect() del driver.

const path = require('path');
const { EventEmitter } = require('events');
const { BrowserWindow, ipcMain } = require('electron');

let seq = 0;

function remoteError(err) {
  const e = new Error((err && err.message) || 'errore USB');
  e.name = (err && err.name) || 'Error';
  return e;
}

class UvcLink extends EventEmitter {
  constructor() {
    super();
    this.win = null;
    this.loading = null;
    this.pending = new Map();
    this.destroyed = false;
    this._onRes = (e, msg) => {
      if (!this._fromHost(e) || !msg) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(remoteError(msg.error));
    };
    this._onEvent = (e, msg) => {
      if (!this._fromHost(e) || !msg || typeof msg.type !== 'string') return;
      if (msg.type === 'ended' || msg.type === 'devicechange') this.emit(msg.type, msg);
    };
    ipcMain.on('uvc:res', this._onRes);
    ipcMain.on('uvc:event', this._onEvent);
  }

  _fromHost(e) {
    return !!this.win && !this.win.isDestroyed() && e.sender === this.win.webContents;
  }

  _failAll(err) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  // apre (o riapre, dopo un crash) la finestra nascosta
  _ensure() {
    if (this.destroyed) return Promise.reject(remoteError({ name: 'InvalidStateError', message: 'USB chiuso' }));
    if (this.win && !this.win.isDestroyed() && this.loading) return this.loading;
    const w = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      skipTaskbar: true,
      focusable: false,
      title: 'PTZ Hub USB',
      webPreferences: {
        preload: path.join(__dirname, 'uvc-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false, // i comandi arrivano anche con la finestra nascosta
      },
    });
    this.win = w;
    w.setMenu(null);
    if (process.platform === 'darwin') w.excludedFromShownWindowsMenu = true; // non compare nel menu Finestra
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    const gone = () => {
      if (this.win !== w) return;
      this.win = null;
      this.loading = null;
      this._failAll(remoteError({ name: 'InvalidStateError', message: 'finestra USB chiusa' }));
      if (!w.isDestroyed()) w.destroy();
      if (!this.destroyed) this.emit('gone');
    };
    w.webContents.on('render-process-gone', gone);
    w.on('closed', gone);
    this.loading = w.loadFile(path.join(__dirname, '..', 'renderer', 'uvc.html'));
    return this.loading;
  }

  async request(op, args, timeoutMs = 8000) {
    await this._ensure();
    const w = this.win;
    if (!w || w.isDestroyed()) throw remoteError({ name: 'InvalidStateError', message: 'finestra USB chiusa' });
    seq += 1;
    const id = seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(remoteError({ name: 'AbortError', message: 'la camera USB non risponde' }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      w.webContents.send('uvc:req', { id, op, args });
    });
  }

  // getUserMedia può metterci qualche secondo (driver lenti, camera che si sveglia)
  open(o) { return this.request('open', o, 20000); }

  apply(values) { return this.request('apply', values, 5000); }

  settings() { return this.request('settings', null, 3000); }

  close() {
    if (!this.win || this.win.isDestroyed()) return Promise.resolve();
    return this.request('close', null, 2000).catch(() => {});
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    ipcMain.removeListener('uvc:res', this._onRes);
    ipcMain.removeListener('uvc:event', this._onEvent);
    this._failAll(remoteError({ name: 'InvalidStateError', message: 'USB chiuso' }));
    const w = this.win;
    this.win = null;
    this.loading = null;
    if (w && !w.isDestroyed()) w.destroy();
    this.removeAllListeners();
  }
}

module.exports = { UvcLink };
