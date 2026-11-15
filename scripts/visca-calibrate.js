#!/usr/bin/env node
'use strict';
// Taratura VISCA: QUESTO PROGRAMMA MUOVE LA TELECAMERA. Va lanciato solo a camera libera (non in diretta).
// Misura come la camera risponde davvero ai comandi, per sistemare PTZ Hub su questo modello:
//   1. velocità vera di pan e tilt per ogni valore VISCA (quanto si sposta in 1 secondo);
//   2. impulso minimo che la fa muovere (per il clic «passo fine»);
//   3. richiamo di una posizione esatta: con lo zoom mandato subito dopo (come oggi), dopo l'arrivo,
//      o prima del pan/tilt; e confronto con la memoria interna della camera;
//   4. messaggi di arrivo (Completion) della camera.
// Alla fine riporta la camera dov'era. Ctrl+C = STOP immediato e uscita.
//
//   node scripts/visca-calibrate.js <indirizzo> <udp|tcp|sony> [porta] --muovi
//
// Scrive tutto in visca-calibrate-<data>.json nella cartella da cui si lancia.

const dgram = require('dgram');
const net = require('net');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const host = args[0];
const mode = args[1];
const port = Number(args[2]) || { udp: 1259, tcp: 5678, sony: 52381 }[mode];
if (!host || !mode || !args.includes('--muovi')) {
  console.log('Uso: node scripts/visca-calibrate.js <indirizzo> <udp|tcp|sony> [porta] --muovi');
  console.log('ATTENZIONE: muove la telecamera. Usalo solo quando non è in diretta.');
  process.exit(1);
}
const SLOT = 99; // memoria interna usata per il confronto (poi resta salvata lì)

const hex = (b) => Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join(' ');
const nib = (bytes) => bytes.reduce((v, b) => v * 16 + (b & 0x0f), 0);
const toNib = (v, n) => Array.from({ length: n }, (_, i) => (v >>> (4 * (n - 1 - i))) & 0x0f);
const s16 = (v) => (v >= 0x8000 ? v - 0x10000 : v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const now = () => Date.now() - t0;

// --- trasporto ------------------------------------------------------------------
let sock;
let seq = 1;
let buf = Buffer.alloc(0);
const rxLog = []; // tutti i messaggi ricevuti con l'istante
let waiter = null;

function onMsg(m) {
  rxLog.push({ t: now(), m: hex(m) });
  if (waiter && waiter.match(m)) { const w = waiter; waiter = null; clearTimeout(w.timer); w.resolve(m); }
}
function onData(d) {
  buf = Buffer.concat([buf, d]);
  let i;
  while ((i = buf.indexOf(0xff)) >= 0) { onMsg(Buffer.from(buf.subarray(0, i + 1))); buf = buf.subarray(i + 1); }
}
async function open() {
  if (mode === 'tcp') {
    await new Promise((resolve, reject) => {
      sock = net.createConnection({ host, port }, resolve);
      sock.on('error', reject);
      sock.on('data', onData);
    });
  } else {
    sock = dgram.createSocket('udp4');
    sock.on('message', (m) => onData(mode === 'sony' ? m.subarray(8) : m));
    await new Promise((r) => sock.bind(0, r));
    if (mode === 'sony') { const p = Buffer.from([0x02, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0x01]); sock.send(p, port, host); seq = 0; await sleep(100); }
  }
}
function raw(body, inquiry = false) {
  const payload = Buffer.from([0x81, ...body, 0xff]);
  let pkt = payload;
  if (mode === 'sony') {
    const h = Buffer.alloc(8);
    h.writeUInt16BE(inquiry ? 0x0110 : 0x0100, 0);
    h.writeUInt16BE(payload.length, 2);
    h.writeUInt32BE(seq++, 4);
    pkt = Buffer.concat([h, payload]);
  }
  if (mode === 'tcp') sock.write(pkt); else sock.send(pkt, port, host);
}
const cmd = (body) => raw(body, false);
function ask(body, ms = 800) {
  return new Promise((resolve) => {
    waiter = {
      match: (m) => (m[1] & 0xf0) === 0x50 && m.length > 3 || (m[1] & 0xf0) === 0x60,
      timer: setTimeout(() => { waiter = null; resolve(null); }, ms),
      resolve,
    };
    raw(body, true);
  });
}
async function pos() {
  const p = await ask([0x09, 0x06, 0x12]);
  const z = await ask([0x09, 0x04, 0x47]);
  if (!p || (p[1] & 0xf0) !== 0x50) return null;
  const d = p.subarray(2, -1);
  const pd = d.length - 4;
  return { pan: nib(d.subarray(0, pd)), tilt: nib(d.subarray(pd)), pd, zoom: z && (z[1] & 0xf0) === 0x50 ? nib(z.subarray(2, -1)) : null };
}
// attende che la camera sia ferma (3 letture uguali) o il tempo massimo
async function settle(maxMs = 15000) {
  const start = Date.now();
  let last = null;
  let same = 0;
  while (Date.now() - start < maxMs) {
    // eslint-disable-next-line no-await-in-loop
    const p = await pos();
    if (p && last && p.pan === last.pan && p.tilt === last.tilt && p.zoom === last.zoom) same++; else same = 0;
    last = p;
    if (same >= 2) return { p, ms: Date.now() - start };
    // eslint-disable-next-line no-await-in-loop
    await sleep(150);
  }
  return { p: last, ms: Date.now() - start, timeout: true };
}
const STOP = [0x01, 0x06, 0x01, 0x01, 0x01, 0x03, 0x03];
function stopAll() { cmd(STOP); cmd([0x01, 0x04, 0x07, 0x00]); }
const drive = (ps, ts, pd, td) => cmd([0x01, 0x06, 0x01, ps, ts, pd, td]);
const absPT = (p, sp, digits) => cmd([0x01, 0x06, 0x02, sp, Math.min(sp, 0x14), ...toNib(p.pan, digits), ...toNib(p.tilt, 4)]);
const absZoom = (z) => cmd([0x01, 0x04, 0x47, ...toNib(z, 4)]);
const dPan = (a, b, digits) => { const m = 1 << (4 * digits); let d = (b - a) % m; if (d > m / 2) d -= m; if (d < -m / 2) d += m; return d; };

process.on('SIGINT', () => { stopAll(); setTimeout(() => { stopAll(); process.exit(130); }, 150); });

(async () => {
  await open();
  const out = { host, mode, port, when: new Date().toISOString(), speeds: { pan: [], tilt: [] }, pulses: [], recall: [], completion: [] };
  const start = await pos();
  if (!start) { console.log('La camera non risponde alle domande di posizione: impossibile tarare.'); process.exit(1); }
  out.start = start;
  const D = start.pd;
  console.log(`Partenza: pan ${start.pan} tilt ${start.tilt} zoom ${start.zoom}`);
  const back = async () => { absPT(start, 0x10, D); await sleep(300); absZoom(start.zoom); await settle(); };

  // 1. velocità: 1 s a ogni valore, avanti e poi indietro (così resta vicino al punto di partenza)
  for (const axis of ['pan', 'tilt']) {
    const list = axis === 'pan' ? [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24] : [1, 2, 3, 4, 5, 6, 8, 10, 14, 20];
    for (const v of list) {
      for (const dir of [1, -1]) {
        // eslint-disable-next-line no-await-in-loop
        const a = (await settle(4000)).p;
        if (axis === 'pan') drive(v, 1, dir > 0 ? 0x02 : 0x01, 0x03); else drive(1, v, 0x03, dir > 0 ? 0x01 : 0x02);
        // eslint-disable-next-line no-await-in-loop
        await sleep(1000);
        cmd(STOP);
        // eslint-disable-next-line no-await-in-loop
        const b = (await settle(4000)).p;
        const delta = axis === 'pan' ? dPan(a.pan, b.pan, D) : s16(b.tilt) - s16(a.tilt);
        out.speeds[axis].push({ v, dir, delta });
        console.log(`  ${axis} velocità ${String(v).padStart(2)} ${dir > 0 ? '+' : '-'}: ${delta} unità in 1 s`);
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await back();
  }

  // 2. impulso minimo: velocità 1–4, durata 40–400 ms
  for (const v of [1, 2, 3, 4]) {
    for (const ms of [40, 80, 120, 200, 300, 400]) {
      // eslint-disable-next-line no-await-in-loop
      const a = (await settle(3000)).p;
      drive(v, 1, 0x02, 0x03);
      // eslint-disable-next-line no-await-in-loop
      await sleep(ms);
      cmd(STOP);
      // eslint-disable-next-line no-await-in-loop
      const b = (await settle(3000)).p;
      const delta = dPan(a.pan, b.pan, D);
      out.pulses.push({ v, ms, delta });
      console.log(`  impulso pan velocità ${v} per ${ms} ms: ${delta} unità`);
      if (delta > 0) break; // basta la prima durata che muove
    }
  }
  await back();

  // 3. richiamo: bersaglio = partenza spostata, con zoom diverso
  const span = Math.max(...out.speeds.pan.filter((s) => s.v === 8).map((s) => Math.abs(s.delta)), 200);
  const target = {
    pan: (start.pan + Math.round(span * 1.5)) & ((1 << (4 * D)) - 1),
    tilt: (start.tilt + Math.round(span * 0.4)) & 0xffff,
    zoom: start.zoom > 0x2000 ? start.zoom - 0x1000 : start.zoom + 0x1000,
  };
  out.target = target;
  const variants = {
    // come PTZ Hub oggi: pan/tilt, poi zoom 100 ms dopo
    subito: async () => { absPT(target, 0x10, D); await sleep(100); absZoom(target.zoom); },
    // zoom solo quando pan/tilt è arrivato
    dopoArrivo: async () => { absPT(target, 0x10, D); await settle(); absZoom(target.zoom); },
    // prima lo zoom, poi pan/tilt quando lo zoom è arrivato
    zoomPrima: async () => { absZoom(target.zoom); await settle(); absPT(target, 0x10, D); },
  };
  for (let rep = 0; rep < 2; rep++) {
    for (const [name, fn] of Object.entries(variants)) {
      // eslint-disable-next-line no-await-in-loop
      await back();
      const rx0 = rxLog.length;
      const tStart = now();
      // eslint-disable-next-line no-await-in-loop
      await fn();
      // eslint-disable-next-line no-await-in-loop
      const s = await settle();
      const e = { variant: name, rep, ms: now() - tStart, pan: dPan(target.pan, s.p.pan, D), tilt: s16(s.p.tilt) - s16(target.tilt), zoom: s.p.zoom - target.zoom };
      out.recall.push(e);
      out.completion.push({ variant: name, rep, rx: rxLog.slice(rx0).filter((r) => !/^90 50 0[0-9a-f] 0/.test(r.m) || r.m.length < 12).map((r) => ({ t: r.t - tStart, m: r.m })) });
      console.log(`  richiamo «${name}» #${rep + 1}: errore pan ${e.pan}, tilt ${e.tilt}, zoom ${e.zoom} (${e.ms} ms)`);
    }
  }

  // memoria interna della camera, per confronto
  absPT(target, 0x10, D); await settle(); absZoom(target.zoom); await settle();
  const ref = (await settle()).p;
  cmd([0x01, 0x04, 0x3f, 0x01, SLOT]);
  await sleep(1500);
  for (let rep = 0; rep < 2; rep++) {
    // eslint-disable-next-line no-await-in-loop
    await back();
    cmd([0x01, 0x04, 0x3f, 0x02, SLOT]);
    // eslint-disable-next-line no-await-in-loop
    const s = await settle();
    const e = { variant: 'memoriaCamera', rep, pan: dPan(ref.pan, s.p.pan, D), tilt: s16(s.p.tilt) - s16(ref.tilt), zoom: s.p.zoom - ref.zoom };
    out.recall.push(e);
    console.log(`  memoria della camera #${rep + 1}: errore pan ${e.pan}, tilt ${e.tilt}, zoom ${e.zoom}`);
  }

  await back();
  out.end = (await settle()).p;
  out.rxSample = rxLog.slice(0, 400);
  const file = path.join(process.cwd(), `visca-calibrate-${out.when.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nFinito, camera riportata al punto di partenza. Risultato in ${file}`);
  process.exit(0);
})().catch((e) => { stopAll(); console.error('Errore:', e.message); setTimeout(() => process.exit(1), 200); });
