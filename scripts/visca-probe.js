#!/usr/bin/env node
'use strict';
// Mappa di una telecamera VISCA SENZA MUOVERLA.
// Manda solo domande (inquiry, byte 8x 09 …): niente comandi di movimento, zoom, fuoco o memorie.
// Si può lanciare mentre la camera è in diretta.
//
//   node scripts/visca-probe.js 192.168.1.50            prova UDP 1259, TCP 5678 e Sony 52381
//   node scripts/visca-probe.js 192.168.1.50 tcp 5678   solo quel trasporto
//
// Senza Node: ELECTRON_RUN_AS_NODE=1 "/Applications/PTZ Hub.app/Contents/MacOS/PTZ Hub" scripts/visca-probe.js 192.168.1.50
//
// Scrive il risultato a video e in visca-probe-<data>.json nella cartella da cui si lancia.

const dgram = require('dgram');
const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');

const [host, onlyMode, onlyPort] = process.argv.slice(2);
if (!host) {
  console.log('Uso: node scripts/visca-probe.js <indirizzo-camera> [udp|tcp|sony] [porta]');
  process.exit(1);
}

const ADDR = 1;
const hex = (b) => Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join(' ');
const nib = (bytes) => bytes.reduce((v, b) => v * 16 + (b & 0x0f), 0);
const signed16 = (v) => (v >= 0x8000 ? v - 0x10000 : v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- trasporto: solo inquiry -------------------------------------------------
class Link {
  constructor(mode, port) {
    this.mode = mode;
    this.port = port;
    this.seq = 1;
    this.buf = Buffer.alloc(0);
    this.waiter = null;
    this.extra = []; // messaggi arrivati senza che li aspettassimo
  }

  async open() {
    if (this.mode === 'tcp') {
      await new Promise((resolve, reject) => {
        const s = net.createConnection({ host, port: this.port });
        const timer = setTimeout(() => { s.destroy(); reject(new Error('nessuna connessione TCP in 2 s')); }, 2000);
        s.on('connect', () => { clearTimeout(timer); resolve(); });
        s.on('error', (e) => { clearTimeout(timer); reject(e); });
        s.on('data', (d) => this._data(d));
        this.sock = s;
      });
    } else {
      this.sock = dgram.createSocket('udp4');
      this.sock.on('message', (m) => {
        let d = m;
        if (this.mode === 'sony') {
          if (m.length < 8) return;
          if (m.readUInt16BE(0) !== 0x0111) return; // solo risposte VISCA
          d = m.subarray(8);
        }
        this._data(d);
      });
      await new Promise((r) => this.sock.bind(0, r));
    }
  }

  close() {
    try { if (this.mode === 'tcp') this.sock.destroy(); else this.sock.close(); } catch (_) { /* ignora */ }
  }

  _data(d) {
    this.buf = Buffer.concat([this.buf, d]);
    let i;
    while ((i = this.buf.indexOf(0xff)) >= 0) {
      const m = this.buf.subarray(0, i + 1);
      this.buf = this.buf.subarray(i + 1);
      if (this.waiter) this.waiter.got.push(Buffer.from(m));
      else this.extra.push(hex(m));
    }
    if (this.waiter && this.waiter.got.some((m) => (m[1] & 0xf0) === 0x50 || (m[1] & 0xf0) === 0x60)) {
      const w = this.waiter;
      this.waiter = null;
      clearTimeout(w.timer);
      w.resolve(w.got);
    }
  }

  // body senza header e senza FF; deve essere una inquiry (09 …): qualunque altra cosa è vietata
  ask(body, timeoutMs = 800) {
    if (body[0] !== 0x09) throw new Error('vietato: questo programma manda solo inquiry');
    const payload = Buffer.from([0x80 | ADDR, ...body, 0xff]);
    let pkt = payload;
    if (this.mode === 'sony') {
      const h = Buffer.alloc(8);
      h.writeUInt16BE(0x0110, 0); // VISCA inquiry
      h.writeUInt16BE(payload.length, 2);
      h.writeUInt32BE(this.seq++, 4);
      pkt = Buffer.concat([h, payload]);
    }
    const t0 = process.hrtime.bigint();
    return new Promise((resolve) => {
      this.waiter = {
        got: [],
        timer: setTimeout(() => { const w = this.waiter; this.waiter = null; resolve({ ok: false, ms: null, replies: (w ? w.got : []).map(hex) }); }, timeoutMs),
        resolve: (got) => resolve({ ok: true, ms: Number(process.hrtime.bigint() - t0) / 1e6, msgs: got, replies: got.map(hex) }),
      };
      if (this.mode === 'tcp') this.sock.write(pkt);
      else this.sock.send(pkt, this.port, host);
    });
  }
}

// --- domande ------------------------------------------------------------------
const decode = {
  power: (d) => ({ 2: 'accesa', 3: 'standby', 4: 'errore alimentazione' }[d[0]] || `codice ${d[0]}`),
  version: (d) => (d.length >= 7 ? {
    vendor: `0x${hex(d.subarray(0, 2)).replace(' ', '')}`,
    model: `0x${hex(d.subarray(2, 4)).replace(' ', '')}`,
    rom: `0x${hex(d.subarray(4, 6)).replace(' ', '')}`,
    sockets: d[6],
  } : null),
  ptPos: (d) => {
    if (d.length !== 8 && d.length !== 9) return { nonStandard: true, len: d.length };
    const pd = d.length - 4;
    const pan = nib(d.subarray(0, pd));
    const tilt = nib(d.subarray(pd));
    return { panRaw: pan, tiltRaw: tilt, panDigits: pd, panSigned: pd === 4 ? signed16(pan) : pan, tiltSigned: signed16(tilt) };
  },
  ptMaxSpeed: (d) => (d.length >= 2 ? { panMax: d[0], tiltMax: d[1] } : null),
  four: (d) => (d.length === 4 ? { raw: nib(d), hex: `0x${nib(d).toString(16)}` } : { nonStandard: true, len: d.length }),
  onOff: (d) => ({ 2: 'on', 3: 'off' }[d[0]] || `codice ${d[0]}`),
  focusMode: (d) => ({ 2: 'auto', 3: 'manuale' }[d[0]] || `codice ${d[0]}`),
  byte: (d) => d[0],
};

const QUESTIONS = [
  ['power', 'Alimentazione', [0x09, 0x04, 0x00], decode.power],
  ['version', 'Marca/modello/firmware (CAM_VersionInq)', [0x09, 0x00, 0x02], decode.version],
  ['ptPos', 'Posizione pan/tilt', [0x09, 0x06, 0x12], decode.ptPos],
  ['ptMaxSpeed', 'Velocità massima pan/tilt', [0x09, 0x06, 0x11], decode.ptMaxSpeed],
  ['ptMode', 'Modo pan/tilt (Pan-tiltModeInq)', [0x09, 0x06, 0x10], (d) => hex(d)],
  ['zoomPos', 'Posizione zoom', [0x09, 0x04, 0x47], decode.four],
  ['dzoomMode', 'Zoom digitale', [0x09, 0x04, 0x06], decode.onOff],
  ['dzoomPos', 'Posizione zoom digitale', [0x09, 0x04, 0x46], decode.four],
  ['focusMode', 'Modo fuoco', [0x09, 0x04, 0x38], decode.focusMode],
  ['focusPos', 'Posizione fuoco', [0x09, 0x04, 0x48], decode.four],
  ['afMode', 'Modo autofocus (normale/intervallo/zoom)', [0x09, 0x04, 0x57], decode.byte],
  ['flip', 'Immagine capovolta', [0x09, 0x04, 0x66], decode.onOff],
  ['mirror', 'Immagine specchiata', [0x09, 0x04, 0x61], decode.onOff],
  ['irReceive', 'Ricevitore del telecomando', [0x09, 0x06, 0x08], decode.onOff],
  ['menu', 'Menu a schermo aperto', [0x09, 0x06, 0x06], decode.onOff],
];

async function tryLink(mode, port) {
  const l = new Link(mode, port);
  try {
    await l.open();
  } catch (e) {
    return { mode, port, answers: false, error: e.message };
  }
  const r = await l.ask([0x09, 0x04, 0x00], 700);
  if (!r.ok) { l.close(); return { mode, port, answers: false, error: 'nessuna risposta' }; }
  return { mode, port, answers: true, link: l, firstReplyMs: Math.round(r.ms) };
}

function httpTitle() {
  return new Promise((resolve) => {
    const req = http.get({ host, port: 80, path: '/', timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (c) => { if (body.length < 20000) body += c; });
      res.on('end', () => {
        const m = /<title>([^<]*)<\/title>/i.exec(body);
        resolve({ status: res.statusCode, server: res.headers.server || '', title: m ? m[1].trim() : '' });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

(async () => {
  const out = { host, when: new Date().toISOString(), transports: [], answers: {}, stability: [], unexpected: [] };
  console.log(`\nMappa VISCA di ${host} — solo domande, la camera non si muove\n`);

  const candidates = onlyMode
    ? [[onlyMode, Number(onlyPort) || { udp: 1259, tcp: 5678, sony: 52381 }[onlyMode]]]
    : [['udp', 1259], ['tcp', 5678], ['sony', 52381]];
  let link = null;
  for (const [mode, port] of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const r = await tryLink(mode, port);
    out.transports.push({ mode, port, answers: r.answers, firstReplyMs: r.firstReplyMs, error: r.error });
    console.log(`  ${mode.toUpperCase().padEnd(4)} ${String(port).padEnd(5)} ${r.answers ? `risponde (${r.firstReplyMs} ms)` : `no — ${r.error}`}`);
    if (r.answers && !link) link = r.link; else if (r.link) r.link.close();
  }
  if (!link) {
    console.log('\nNessun trasporto VISCA risponde. Controlla indirizzo e che VISCA over IP sia attivo nella camera.');
    out.verdict = 'nessuna risposta VISCA';
  } else {
    console.log(`\nUso ${link.mode.toUpperCase()} ${link.port}\n`);
    for (const [key, label, body, dec] of QUESTIONS) {
      // eslint-disable-next-line no-await-in-loop
      const r = await link.ask(body);
      const last = r.ok ? r.msgs[r.msgs.length - 1] : null;
      let value = null;
      let status = 'nessuna risposta';
      if (last && (last[1] & 0xf0) === 0x50) {
        status = 'ok';
        try { value = dec(last.subarray(2, last.length - 1)); } catch (e) { value = `non decodificato: ${e.message}`; }
      } else if (last && (last[1] & 0xf0) === 0x60) {
        status = `errore 0x${last[2].toString(16)}${last[2] === 0x02 ? ' (domanda non supportata)' : ''}`;
      }
      out.answers[key] = { label, sent: hex([0x81, ...body, 0xff]), replies: r.replies, ms: r.ms && Math.round(r.ms), status, value };
      console.log(`  ${label.padEnd(44)} ${status === 'ok' ? JSON.stringify(value) : status}   [${r.replies.join(' | ')}]`);
      // eslint-disable-next-line no-await-in-loop
      await sleep(60);
    }

    // posizione letta 10 volte in 3 s: se la camera è ferma i valori devono essere identici
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop
      const p = await link.ask([0x09, 0x06, 0x12]);
      // eslint-disable-next-line no-await-in-loop
      const z = await link.ask([0x09, 0x04, 0x47]);
      const pv = p.ok ? decode.ptPos(p.msgs[p.msgs.length - 1].subarray(2, -1)) : null;
      const zv = z.ok ? decode.four(z.msgs[z.msgs.length - 1].subarray(2, -1)) : null;
      out.stability.push({ t: i * 300, pan: pv && pv.panRaw, tilt: pv && pv.tiltRaw, zoom: zv && zv.raw });
      // eslint-disable-next-line no-await-in-loop
      await sleep(300);
    }
    const uniq = (k) => new Set(out.stability.map((s) => s[k])).size;
    out.stabilitySummary = { panValues: uniq('pan'), tiltValues: uniq('tilt'), zoomValues: uniq('zoom') };
    console.log(`\n  Letture ripetute (3 s): pan ${uniq('pan')} valori, tilt ${uniq('tilt')}, zoom ${uniq('zoom')} (1 = stabile; di più = si stava muovendo o la lettura balla)`);
    out.unexpected = link.extra;
    if (link.extra.length) console.log(`  Messaggi arrivati senza domanda: ${link.extra.length} (es. ${link.extra.slice(0, 3).join(' | ')})`);
    link.close();
  }

  out.http = await httpTitle();
  if (out.http) console.log(`\n  Pagina web: HTTP ${out.http.status} «${out.http.title}» ${out.http.server}`);

  const file = path.join(process.cwd(), `visca-probe-${out.when.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nRisultato salvato in ${file}\n`);
  process.exit(0);
})().catch((e) => { console.error('Errore:', e.message); process.exit(1); });
