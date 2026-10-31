'use strict';
// Client ONVIF minimale (Device, Media, PTZ, Imaging) senza dipendenze.

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { t } = require('../shared/i18n');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const NS = [
  'xmlns:s="http://www.w3.org/2003/05/soap-envelope"',
  'xmlns:tds="http://www.onvif.org/ver10/device/wsdl"',
  'xmlns:trt="http://www.onvif.org/ver10/media/wsdl"',
  'xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl"',
  'xmlns:timg="http://www.onvif.org/ver20/imaging/wsdl"',
  'xmlns:tt="http://www.onvif.org/ver10/schema"',
].join(' ');

function xmlEsc(s) {
  return String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

// Contenuto del primo elemento con quel nome locale (ignora i prefissi di namespace)
function section(xml, name) {
  const re = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`);
  const m = re.exec(xml);
  return m ? m[1] : null;
}

function sections(xml, name) {
  const re = new RegExp(`<(?:[\\w.-]+:)?${name}((?:\\s[^>]*)?)>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push({ attrs: m[1], body: m[2] });
  return out;
}

function attr(attrsOrTag, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrsOrTag || '');
  return m ? m[1] : null;
}

function emptyTagAttrs(xml, name) {
  const m = new RegExp(`<(?:[\\w.-]+:)?${name}(\\s[^>]*?)/?>`).exec(xml);
  return m ? m[1] : null;
}

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function parseDigestChallenge(h) {
  const out = {};
  const re = /(\w+)=(?:"([^"]*)"|([^\s,]+))/g;
  let m;
  while ((m = re.exec(h))) out[m[1].toLowerCase()] = m[2] ?? m[3];
  return out;
}

function digestHeader(ch, { user, pass, method, uri }) {
  const ha1 = md5(`${user}:${ch.realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);
  const nc = '00000001';
  const cnonce = crypto.randomBytes(8).toString('hex');
  const qop = ch.qop ? ch.qop.split(',').map((q) => q.trim()).find((q) => q === 'auth') : null;
  const response = qop
    ? md5(`${ha1}:${ch.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${ch.nonce}:${ha2}`);
  let h = `Digest username="${user}", realm="${ch.realm}", nonce="${ch.nonce}", uri="${uri}", response="${response}"`;
  if (ch.opaque) h += `, opaque="${ch.opaque}"`;
  if (qop) h += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (ch.algorithm) h += `, algorithm=${ch.algorithm}`;
  return h;
}

// GET/POST con supporto Basic/Digest, usato anche dal rilevamento
async function httpRequest(url, { method = 'GET', body, headers = {}, user, pass, timeout = 3000 } = {}) {
  const doFetch = (extra = {}) => fetch(url, {
    method,
    body,
    headers: { ...headers, ...extra },
    signal: AbortSignal.timeout(timeout),
    redirect: 'follow',
  });
  let res = await doFetch();
  if (res.status === 401 && user) {
    const wa = res.headers.get('www-authenticate') || '';
    await res.arrayBuffer().catch(() => {});
    if (/^digest/i.test(wa)) {
      const ch = parseDigestChallenge(wa.replace(/^digest\s+/i, ''));
      const u = new URL(url);
      res = await doFetch({ Authorization: digestHeader(ch, { user, pass, method, uri: u.pathname + u.search }) });
    } else {
      res = await doFetch({ Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') });
    }
  }
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

function cancelledError() {
  const e = new Error('cancelled');
  e.code = 'CANCELLED';
  return e;
}

class OnvifClient {
  constructor({ host, port = 80, user = '', pass = '' }) {
    this.host = host;
    this.port = port;
    this.user = user;
    this.pass = pass;
    this.timeOffset = 0;
    this.deviceUrl = `http://${host}:${port}/onvif/device_service`;
    this.mediaUrl = null;
    this.ptzUrl = null;
    this.imagingUrl = null;
    this.profiles = [];
    this.profileToken = null;
    this.videoSourceToken = null;
  }

  // Alcune camere restituiscono XAddr con IP sbagliati: si forza l'host configurato
  fixAddr(addr) {
    try {
      const u = new URL(addr.trim().split(/\s+/)[0]);
      u.hostname = this.host;
      if (!u.port && this.port !== 80) u.port = String(this.port);
      return u.toString();
    } catch (_) {
      return null;
    }
  }

  security() {
    if (!this.user) return '';
    const nonce = crypto.randomBytes(16);
    const created = new Date(Date.now() + this.timeOffset).toISOString().replace(/\.\d+Z$/, 'Z');
    const digest = crypto.createHash('sha1')
      .update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(this.pass)]))
      .digest('base64');
    return '<Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">'
      + `<UsernameToken><Username>${xmlEsc(this.user)}</Username>`
      + `<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password>`
      + `<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</Nonce>`
      + `<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created>`
      + '</UsernameToken></Security>';
  }

  async call(url, body, { auth = true, timeout = 3000 } = {}) {
    const envelope = `<?xml version="1.0" encoding="UTF-8"?><s:Envelope ${NS}><s:Header>${auth ? this.security() : ''}</s:Header><s:Body>${body}</s:Body></s:Envelope>`;
    const res = await httpRequest(url, {
      method: 'POST',
      body: envelope,
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
      user: this.user,
      pass: this.pass,
      timeout,
    });
    if (res.status >= 400 || /<(?:\w+:)?Fault[\s>]/.test(res.text)) {
      const reason = section(res.text, 'Text') || section(res.text, 'Reason') || `HTTP ${res.status}`;
      const err = new Error(`ONVIF: ${reason.replace(/<[^>]+>/g, '').trim()}`);
      err.status = res.status;
      throw err;
    }
    return res.text;
  }

  async init() {
    try {
      const t = await this.call(this.deviceUrl, '<tds:GetSystemDateAndTime/>', { auth: false });
      const utc = section(t, 'UTCDateTime');
      if (utc) {
        const n = (k) => parseInt(section(utc, k), 10);
        const camMs = Date.UTC(n('Year'), n('Month') - 1, n('Day'), n('Hour'), n('Minute'), n('Second'));
        if (!Number.isNaN(camMs)) this.timeOffset = camMs - Date.now();
      }
    } catch (_) { /* non tutte le camere lo espongono senza autenticazione */ }

    const caps = await this.call(this.deviceUrl, '<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>');
    const pick = (name) => {
      const s = section(caps, name);
      const x = s ? section(s, 'XAddr') : null;
      return x ? this.fixAddr(x) : null;
    };
    this.mediaUrl = pick('Media');
    this.ptzUrl = pick('PTZ');
    this.imagingUrl = pick('Imaging');
    if (!this.mediaUrl) throw new Error(t('onvif.noMedia'));

    const prof = await this.call(this.mediaUrl, '<trt:GetProfiles/>');
    this.profiles = sections(prof, 'Profiles').map((p) => ({
      token: attr(p.attrs, 'token'),
      name: section(p.body, 'Name'),
      hasPtz: /PTZConfiguration/.test(p.body),
      sourceToken: section(section(p.body, 'VideoSourceConfiguration') || '', 'SourceToken'),
      width: parseInt(section(section(p.body, 'Resolution') || '', 'Width'), 10) || null,
      height: parseInt(section(section(p.body, 'Resolution') || '', 'Height'), 10) || null,
    }));
    const main = this.profiles.find((p) => p.hasPtz) || this.profiles[0];
    if (!main) throw new Error(t('onvif.noProfile'));
    this.profileToken = main.token;
    this.videoSourceToken = main.sourceToken;
    if (!this.ptzUrl) throw new Error(t('onvif.noPtz'));
  }

  async streamUris() {
    const out = [];
    for (const p of this.profiles) {
      try {
        const r = await this.call(this.mediaUrl,
          '<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup>'
          + `<trt:ProfileToken>${xmlEsc(p.token)}</trt:ProfileToken></trt:GetStreamUri>`);
        const uri = section(r, 'Uri');
        if (uri) {
          const u = new URL(uri.trim().replace(/&amp;/g, '&'));
          u.hostname = this.host;
          out.push({ uri: u.toString(), width: p.width, height: p.height, name: p.name });
        }
      } catch (_) { /* profilo senza stream */ }
    }
    return out;
  }

  ptz(body) { return this.call(this.ptzUrl, body); }
  pt() { return `<tptz:ProfileToken>${xmlEsc(this.profileToken)}</tptz:ProfileToken>`; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class OnvifCamera extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.kind = 'onvif';
    this.c = new OnvifClient({ host: opts.host, port: opts.port || 80, user: opts.user, pass: opts.pass });
    this.vel = { x: 0, y: 0, z: 0 };
    this.inflight = false;
    this.dirty = false;
    this.idle = Promise.resolve();
    this.useTimeout = true; // ContinuousMove con Timeout: se l'app si blocca, la camera si ferma da sola
    this.imgChain = Promise.resolve();
    this.state = 'disconnected';
    this.healthTimer = null;
    this.keepAlive = null;
  }

  _setState(state, detail = '') {
    if (state === this.state && detail === this.detail) return;
    this.state = state;
    this.detail = detail;
    this.emit('status', { state, detail });
  }

  async connect() {
    this._setState('connecting', `${this.opts.host}:${this.opts.port || 80}`);
    try {
      await this.c.init();
      this._setState('connected');
    } catch (e) {
      this._setState('error', e.message);
      clearTimeout(this.retryTimer);
      if (!this.closed) this.retryTimer = setTimeout(() => { if (!this.closed) this.connect(); }, 5000);
      return;
    }
    clearInterval(this.healthTimer);
    this.healthTimer = setInterval(async () => {
      if (this.inflight) return;
      try {
        await this.c.ptz(`<tptz:GetStatus>${this.c.pt()}</tptz:GetStatus>`);
        this._setState('connected');
      } catch (e) {
        this._setState('error', e.message);
      }
    }, 4000);
    // durante un movimento continuo il comando viene rinnovato prima che scada il Timeout
    clearInterval(this.keepAlive);
    this.keepAlive = setInterval(() => {
      const { x, y, z } = this.vel;
      if ((x || y || z) && !this.inflight) this._flush();
    }, 1000);
  }

  async disconnect() {
    this.closed = true;
    clearInterval(this.healthTimer);
    clearInterval(this.keepAlive);
    clearTimeout(this.retryTimer);
    if (this.c.ptzUrl) {
      this.vel = { x: 0, y: 0, z: 0 };
      await Promise.race([this._flush(), sleep(1500)]);
    }
    this._setState('disconnected');
  }

  // Invia sempre l'ultima velocità richiesta, una richiesta alla volta (l'ordine non si inverte).
  // Lo stop viene ritentato se fallisce.
  _flush() {
    if (this.inflight) { this.dirty = true; return this.idle; }
    this.inflight = true;
    this.idle = (async () => {
      try {
        do {
          this.dirty = false;
          const { x, y, z } = this.vel;
          const isStop = x === 0 && y === 0 && z === 0;
          for (let attempt = 0; attempt < (isStop ? 3 : 2); attempt++) {
            try {
              if (isStop) {
                await this.c.ptz(`<tptz:Stop>${this.c.pt()}<tptz:PanTilt>true</tptz:PanTilt><tptz:Zoom>true</tptz:Zoom></tptz:Stop>`);
              } else {
                const to = this.useTimeout ? '<tptz:Timeout>PT2S</tptz:Timeout>' : '';
                await this.c.ptz(`<tptz:ContinuousMove>${this.c.pt()}<tptz:Velocity><tt:PanTilt x="${x.toFixed(3)}" y="${y.toFixed(3)}"/><tt:Zoom x="${z.toFixed(3)}"/></tptz:Velocity>${to}</tptz:ContinuousMove>`);
              }
              break;
            } catch (e) {
              if (this.dirty) break; // c'è già un comando più recente
              if (!isStop && this.useTimeout && e.status) {
                this.useTimeout = false; // camera che non accetta il Timeout: si riprova senza
                continue;
              }
              this.emit('log', e.message);
              if (isStop) await sleep(200); else break;
            }
          }
        } while (this.dirty);
      } finally {
        this.inflight = false;
      }
    })();
    return this.idle;
  }

  async _waitIdle() {
    let guard = 0;
    while (this.inflight && guard++ < 10) {
      // eslint-disable-next-line no-await-in-loop
      await this.idle;
    }
  }

  // comandi Imaging in coda: l'ordine (manuale → muovi → ferma) è garantito
  _img(fn) {
    if (!this.c.imagingUrl || !this.c.videoSourceToken) return Promise.resolve();
    const p = this.imgChain.then(fn).catch((e) => this.emit('log', t('onvif.focus', { error: e.message })));
    this.imgChain = p;
    return p;
  }

  move(x, y) {
    if (this.opts.invertPan) x = -x;
    if (this.opts.invertTilt) y = -y;
    this.vel.x = clamp(x, -1, 1);
    this.vel.y = clamp(y, -1, 1);
    this._flush();
  }

  zoom(z) {
    this.vel.z = clamp(z, -1, 1);
    this._flush();
  }

  focus(f) {
    const tok = () => `<timg:VideoSourceToken>${xmlEsc(this.c.videoSourceToken)}</timg:VideoSourceToken>`;
    if (Math.abs(f) < 0.01) {
      return this._img(async () => {
        try {
          await this.c.call(this.c.imagingUrl, `<timg:Stop>${tok()}</timg:Stop>`);
        } catch (e) {
          await sleep(150);
          await this.c.call(this.c.imagingUrl, `<timg:Stop>${tok()}</timg:Stop>`);
        }
      });
    }
    const speed = clamp(f, -1, 1).toFixed(2);
    return this._img(() => this.c.call(this.c.imagingUrl,
      `<timg:Move>${tok()}<timg:Focus><tt:Continuous><tt:Speed>${speed}</tt:Speed></tt:Continuous></timg:Focus></timg:Move>`));
  }

  setFocusAuto(on) {
    return this._img(() => this.c.call(this.c.imagingUrl,
      `<timg:SetImagingSettings><timg:VideoSourceToken>${xmlEsc(this.c.videoSourceToken)}</timg:VideoSourceToken>`
      + `<timg:ImagingSettings><tt:Focus><tt:AutoFocusMode>${on ? 'AUTO' : 'MANUAL'}</tt:AutoFocusMode></tt:Focus></timg:ImagingSettings>`
      + '<timg:ForcePersistence>false</timg:ForcePersistence></timg:SetImagingSettings>'));
  }

  focusOnePush() {
    // ONVIF non ha un comando standard: si riattiva l'autofocus
    return this.setFocusAuto(true);
  }

  async home() {
    await this._waitIdle();
    try { await this.c.ptz(`<tptz:GotoHomePosition>${this.c.pt()}</tptz:GotoHomePosition>`); } catch (e) { this.emit('log', e.message); }
  }

  stopAll() {
    this.vel = { x: 0, y: 0, z: 0 };
    this._flush();
    this.focus(0);
  }

  async getPosition() {
    await this._waitIdle();
    const r = await this.c.ptz(`<tptz:GetStatus>${this.c.pt()}</tptz:GetStatus>`);
    const pos = section(r, 'Position');
    if (!pos) throw new Error(t('onvif.noPosition'));
    const pt = emptyTagAttrs(pos, 'PanTilt');
    const zm = emptyTagAttrs(pos, 'Zoom');
    const x = parseFloat(attr(pt, 'x'));
    const y = parseFloat(attr(pt, 'y'));
    const zoom = parseFloat(attr(zm, 'x'));
    if ([x, y].some(Number.isNaN)) throw new Error(t('onvif.badPosition'));
    return { kind: 'onvif', x, y, zoom: Number.isNaN(zoom) ? null : zoom };
  }

  async gotoPosition(pos, speed01 = 1, cancelled = null) {
    if (!pos || pos.kind !== 'onvif') throw new Error(t('onvif.incompatible'));
    // uno stop ancora in coda non deve interrompere il richiamo
    await this._waitIdle();
    // ma se nel frattempo è arrivato STOP (o un altro comando) il richiamo non parte più
    if (cancelled && cancelled()) throw cancelledError();
    const s = clamp(speed01, 0.05, 1).toFixed(2);
    const zoomPart = pos.zoom == null ? '' : `<tt:Zoom x="${pos.zoom}"/>`;
    const zoomSpeed = pos.zoom == null ? '' : '<tt:Zoom x="1"/>';
    await this.c.ptz(`<tptz:AbsoluteMove>${this.c.pt()}<tptz:Position><tt:PanTilt x="${pos.x}" y="${pos.y}"/>${zoomPart}</tptz:Position>`
      + `<tptz:Speed><tt:PanTilt x="${s}" y="${s}"/>${zoomSpeed}</tptz:Speed></tptz:AbsoluteMove>`);
  }

  async saveSlot(n) {
    await this._waitIdle();
    await this.c.ptz(`<tptz:SetPreset>${this.c.pt()}<tptz:PresetName>PTZPanel-${n}</tptz:PresetName><tptz:PresetToken>${n}</tptz:PresetToken></tptz:SetPreset>`);
  }

  async recallSlot(n, cancelled = null) {
    await this._waitIdle();
    if (cancelled && cancelled()) throw cancelledError();
    await this.c.ptz(`<tptz:GotoPreset>${this.c.pt()}<tptz:PresetToken>${n}</tptz:PresetToken></tptz:GotoPreset>`);
  }
}

module.exports = { OnvifCamera, OnvifClient, httpRequest, section, sections, attr };
