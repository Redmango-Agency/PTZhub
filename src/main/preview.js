'use strict';
// Anteprima RTSP: ffmpeg decodifica lo stream e produce JPEG che il pannello disegna.

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { t } = require('../shared/i18n');
const path = require('path');
const fs = require('fs');

function ffmpegPath() {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  if (process.resourcesPath) {
    const packed = path.join(process.resourcesPath, 'ffmpeg', exe);
    if (fs.existsSync(packed)) return packed;
  }
  try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return p;
  } catch (_) { /* non installato in produzione */ }
  return exe; // dal PATH
}

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

class Preview extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.url = null;
    this.opts = {};
    this.buf = Buffer.alloc(0);
    this.wanted = false;
    this.restartTimer = null;
    this.backoff = 1000;
    this.lastFrameAt = 0;
    this.stderrTail = '';
    this.watchdog = null;
  }

  start(url, opts = {}) {
    this.stop();
    if (!url) return;
    this.url = url;
    this.opts = opts;
    this.wanted = true;
    this.backoff = 1000;
    this._spawn();
    this.watchdog = setInterval(() => {
      // nessun fotogramma da 8 s con processo vivo: si riavvia
      if (this.proc && this.lastFrameAt && Date.now() - this.lastFrameAt > 8000) {
        this.emit('status', { state: 'error', detail: t('ffmpeg.stalled') });
        this.proc.kill();
      }
    }, 2000);
  }

  _spawn() {
    const width = this.opts.width || 960;
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
    ];
    if (/^rtsp:/i.test(this.url)) {
      args.push('-rtsp_transport', this.opts.transport || 'tcp', '-timeout', '5000000');
    }
    args.push(
      '-fflags', 'nobuffer', '-flags', 'low_delay',
      '-probesize', '500000', '-analyzeduration', '500000',
      '-i', this.url,
      '-an', '-sn', '-dn',
      '-vf', `scale='min(${width},iw)':-2`,
      '-q:v', String(this.opts.quality || 5),
      '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1',
    );
    this.emit('status', { state: 'connecting', detail: '' });
    this.lastFrameAt = 0;
    this.stderrTail = '';
    let proc;
    try {
      proc = spawn(ffmpegPath(), args, { windowsHide: true });
    } catch (e) {
      this.emit('status', { state: 'error', detail: t('ffmpeg.cannotStart', { error: e.message }) });
      return;
    }
    this.proc = proc;
    this.buf = Buffer.alloc(0);
    proc.stdout.on('data', (d) => this._onData(d));
    proc.stderr.on('data', (d) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-400);
    });
    proc.on('error', (e) => {
      this.emit('status', { state: 'error', detail: `ffmpeg: ${e.message}` });
    });
    proc.on('close', () => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (!this.wanted) return;
      const msg = this.stderrTail.trim().split('\n').pop() || t('ffmpeg.interrupted');
      this.emit('status', { state: 'error', detail: msg });
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => { if (this.wanted) this._spawn(); }, this.backoff);
      this.backoff = Math.min(this.backoff * 2, 10000);
    });
  }

  _onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      const s = this.buf.indexOf(SOI);
      if (s < 0) { this.buf = Buffer.alloc(0); return; }
      const e = this.buf.indexOf(EOI, s + 2);
      if (e < 0) {
        if (s > 0) this.buf = this.buf.subarray(s);
        if (this.buf.length > 8 * 1024 * 1024) this.buf = Buffer.alloc(0);
        return;
      }
      const frame = Buffer.from(this.buf.subarray(s, e + 2));
      this.buf = this.buf.subarray(e + 2);
      if (!this.lastFrameAt) {
        this.backoff = 1000;
        this.emit('status', { state: 'live', detail: '' });
      }
      this.lastFrameAt = Date.now();
      this.emit('frame', frame);
    }
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.restartTimer);
    clearInterval(this.watchdog);
    if (this.proc) {
      const p = this.proc;
      this.proc = null;
      try { p.kill(); } catch (_) { /* già chiuso */ }
      // se ffmpeg non si chiude da solo (succede su Linux e Mac con alcune sorgenti) lo si chiude d'autorità
      const force = setTimeout(() => { try { if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL'); } catch (_) { /* ignora */ } }, 1500);
      p.once('exit', () => clearTimeout(force));
    }
    this.emit('status', { state: 'off', detail: '' });
  }
}

// Verifica rapida di un URL: prova a decodificare un fotogramma
function testUrl(url, timeoutMs = 7000) {
  return new Promise((resolve) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    if (/^rtsp:/i.test(url)) args.push('-rtsp_transport', 'tcp', '-timeout', '4000000');
    args.push('-i', url, '-frames:v', '1', '-f', 'null', '-');
    let err = '';
    let proc;
    try {
      proc = spawn(ffmpegPath(), args, { windowsHide: true });
    } catch (e) {
      resolve({ ok: false, error: e.message });
      return;
    }
    const t = setTimeout(() => { proc.kill(); }, timeoutMs);
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => { clearTimeout(t); resolve({ ok: false, error: e.message }); });
    proc.on('close', (code) => {
      clearTimeout(t);
      resolve({ ok: code === 0, error: code === 0 ? null : (err.trim().split('\n').pop() || 'timeout') });
    });
  });
}

module.exports = { Preview, testUrl, ffmpegPath };
