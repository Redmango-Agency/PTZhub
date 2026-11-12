'use strict';
// Aiuto finto con lo stesso protocollo di ptzhub-uvc.exe (vedi native/uvc-win/ptzhub-uvc.cpp),
// per provare su qualsiasi sistema il collegamento USB di Windows senza camera vera.
// FAKE_UVC: 'ptz' (default) | 'noptz' (camera senza comandi via USB) | 'unplug' (si stacca dopo 3 comandi set)
// FAKE_UVC_REL: '1' (default) la camera accetta i comandi a velocità | '0' no | 'refuse' li elenca ma li rifiuta
// Casi della Tenveo vera (1.5.6), per riprodurre i problemi senza la camera:
// FAKE_UVC_READS: 'set' (default) le letture danno l'ultimo valore ricevuto via USB anche se il
//   telecomando ha spostato la testa | 'phys' le letture danno la posizione vera
// FAKE_UVC_SAME=1: la camera ignora un valore assoluto uguale a quello che ha già (l'ultimo via USB)
// FAKE_UVC_QUANTUM=n: pan e tilt si muovono davvero solo a multipli di n (passo vero più grosso della griglia)
// FAKE_UVC_REL_START_MS=n: un comando a velocità muove la testa solo se dura almeno n ms
// FAKE_UVC_REL_FLOOR=n: velocità minima vera della camera (sotto n va comunque a n)
// Comando in più: «ir pan=.. tilt=.. zoom=.. focusMode=..» = telecomando IR (sposta la testa, non i valori USB)
const readline = require('readline');

const mode = process.env.FAKE_UVC || 'ptz';
const DEVICES = [
  { name: 'Integrated Camera', path: '\\\\?\\usb#vid_04f2&pid_b6d9#0001#{65e8773d}', ptz: false },
  { name: 'USB Camera', path: '\\\\?\\usb#vid_1bcf&pid_2c99#0002#{65e8773d}', ptz: mode !== 'noptz' },
];
const CAPS = {
  pan: { min: -170, max: 170, step: 1 },
  tilt: { min: -30, max: 90, step: 1 },
  zoom: { min: 100, max: 400, step: 1 },
  focusDistance: { min: 0, max: 100, step: 1 },
  focusMode: ['manual', 'continuous'],
};
const REL = process.env.FAKE_UVC_REL || '1';
const REL_CAPS = { pan: { min: -24, max: 24, step: 1 }, tilt: { min: -20, max: 20, step: 1 } };
const READS = process.env.FAKE_UVC_READS || 'set';
const SAME = process.env.FAKE_UVC_SAME === '1';
const QUANTUM = Number(process.env.FAKE_UVC_QUANTUM) || 0;
const REL_START = Number(process.env.FAKE_UVC_REL_START_MS) || 0;
const REL_FLOOR = Number(process.env.FAKE_UVC_REL_FLOOR) || 0;
const cur = { pan: 0, tilt: 0, zoom: 100, focusDistance: 50, focusMode: 'continuous' }; // valori ricevuti via USB
const phys = { ...cur }; // dove si trova davvero la testa
const physOf = (k, v) => (QUANTUM && (k === 'pan' || k === 'tilt') ? Math.round(v / QUANTUM) * QUANTUM : v);
const reads = () => (READS === 'phys' ? { ...cur, ...phys } : cur);
let open = null;
let sets = 0;
// movimento a velocità: la testa si sposta da sola; posizione letta arrotondata (come una camera vera)
const rel = { pan: 0, tilt: 0, at: 0, since: 0 };
const relLog = [];
const exact = { pan: 0, tilt: 0 };
setInterval(() => {
  if ((rel.pan || rel.tilt) && Date.now() - rel.at > 1500) { rel.pan = 0; rel.tilt = 0; rel.since = 0; relLog.push({ watchdog: true }); }
  if (REL_START && Date.now() - rel.since < REL_START) return; // motore non ancora partito
  for (const k of ['pan', 'tilt']) {
    if (!rel[k]) continue;
    const sp = Math.sign(rel[k]) * Math.max(Math.abs(rel[k]), REL_FLOOR);
    exact[k] = Math.min(CAPS[k].max, Math.max(CAPS[k].min, exact[k] + sp * 0.05));
    cur[k] = Math.round(exact[k]);
    phys[k] = cur[k];
  }
}, 10).unref();
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const caps = (d) => (d.ptz ? CAPS : {});

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const [id, cmd, ...args] = line.split('\t');
  if (!/^\d+$/.test(id)) return;
  const n = Number(id);
  if (cmd === 'list') return out({ id: n, ok: true, value: DEVICES.map((d) => ({ name: d.name, path: d.path, caps: caps(d) })) });
  if (cmd === 'open') {
    const [name, vidpid] = args;
    if (mode === 'unplug' && sets > 3) return out({ id: n, ok: false, name: 'NotFoundError', message: 'camera USB scollegata' });
    const d = DEVICES.find((x) => vidpid && x.path.toLowerCase().includes(vidpid)) || DEVICES.find((x) => x.name === name);
    if (!d) return out({ id: n, ok: false, name: 'NotFoundError', message: 'camera USB non trovata' });
    open = d;
    return out({ id: n, ok: true, value: { label: d.name, path: d.path, caps: caps(d), settings: d.ptz ? reads() : {} } });
  }
  if (cmd === 'set' || cmd === 'get') {
    if (!open) return out({ id: n, ok: false, name: 'InvalidStateError', message: 'nessuna camera USB aperta' });
    if (cmd === 'set') {
      sets += 1;
      if (mode === 'unplug' && sets > 3) return out({ id: n, ok: false, name: 'NotFoundError', message: 'camera USB scollegata' });
      for (const a of args) {
        const [k, v] = a.split('=');
        if (k === 'focusMode') { cur.focusMode = v; phys.focusMode = v; continue; }
        if (!CAPS[k]) continue;
        const x = Math.min(CAPS[k].max, Math.max(CAPS[k].min, Math.round(Number(v))));
        if (SAME && x === cur[k]) continue; // valore che la camera ha già: ignorato
        cur[k] = x;
        phys[k] = physOf(k, x);
        if (k === 'pan' || k === 'tilt') exact[k] = phys[k];
      }
    }
    return out({ id: n, ok: true, value: open.ptz ? reads() : {} });
  }
  if (cmd === 'relcaps') {
    if (!open) return out({ id: n, ok: false, name: 'InvalidStateError', message: 'nessuna camera USB aperta' });
    return out({ id: n, ok: true, value: open.ptz && REL !== '0' ? REL_CAPS : {} });
  }
  if (cmd === 'rel') {
    if (!open) return out({ id: n, ok: false, name: 'InvalidStateError', message: 'nessuna camera USB aperta' });
    if (REL === 'refuse') return out({ id: n, ok: false, name: 'NotSupportedError', message: 'comando a velocità rifiutato dalla camera' });
    const v = {};
    for (const a of args) {
      const [k, x] = a.split('=');
      if (k === 'pan' || k === 'tilt') { rel[k] = Number(x); v[k] = Number(x); }
    }
    if (!rel.pan && !rel.tilt) rel.since = 0;
    else if (!rel.since) rel.since = Date.now();
    rel.at = Date.now();
    relLog.push(v);
    return out({ id: n, ok: true, value: null });
  }
  if (cmd === 'ir') {
    // telecomando: la testa si sposta, i valori USB restano quelli di prima
    for (const a of args) {
      const [k, v] = a.split('=');
      if (k === 'focusMode') { phys.focusMode = v; if (READS === 'phys') cur.focusMode = v; } else if (CAPS[k]) phys[k] = Number(v);
      if (k === 'pan' || k === 'tilt') exact[k] = phys[k];
    }
    return out({ id: n, ok: true, value: null });
  }
  if (cmd === 'debug') return out({ id: n, ok: true, value: { relLog, rel, cur, phys } });
  if (cmd === 'close') { rel.pan = 0; rel.tilt = 0; open = null; return out({ id: n, ok: true, value: null }); }
  return out({ id: n, ok: false, name: 'TypeError', message: `comando sconosciuto: ${cmd}` });
});
