'use strict';
// Aiuto finto con lo stesso protocollo di ptzhub-uvc.exe (vedi native/uvc-win/ptzhub-uvc.cpp),
// per provare su qualsiasi sistema il collegamento USB di Windows senza camera vera.
// FAKE_UVC: 'ptz' (default) | 'noptz' (camera senza comandi via USB) | 'unplug' (si stacca dopo 3 comandi set)
// FAKE_UVC_REL: '1' (default) la camera accetta i comandi a velocità | '0' no | 'refuse' li elenca ma li rifiuta
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
const cur = { pan: 0, tilt: 0, zoom: 100, focusDistance: 50, focusMode: 'continuous' };
let open = null;
let sets = 0;
// movimento a velocità: la testa si sposta da sola; posizione letta arrotondata (come una camera vera)
const rel = { pan: 0, tilt: 0, at: 0 };
const relLog = [];
const exact = { pan: 0, tilt: 0 };
setInterval(() => {
  if ((rel.pan || rel.tilt) && Date.now() - rel.at > 1500) { rel.pan = 0; rel.tilt = 0; relLog.push({ watchdog: true }); }
  for (const k of ['pan', 'tilt']) {
    if (!rel[k]) continue;
    exact[k] = Math.min(CAPS[k].max, Math.max(CAPS[k].min, exact[k] + rel[k] * 0.05));
    cur[k] = Math.round(exact[k]);
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
    return out({ id: n, ok: true, value: { label: d.name, path: d.path, caps: caps(d), settings: d.ptz ? cur : {} } });
  }
  if (cmd === 'set' || cmd === 'get') {
    if (!open) return out({ id: n, ok: false, name: 'InvalidStateError', message: 'nessuna camera USB aperta' });
    if (cmd === 'set') {
      sets += 1;
      if (mode === 'unplug' && sets > 3) return out({ id: n, ok: false, name: 'NotFoundError', message: 'camera USB scollegata' });
      for (const a of args) {
        const [k, v] = a.split('=');
        if (k === 'focusMode') cur.focusMode = v;
        else if (CAPS[k]) cur[k] = Math.min(CAPS[k].max, Math.max(CAPS[k].min, Math.round(Number(v))));
        if (k === 'pan' || k === 'tilt') exact[k] = cur[k];
      }
    }
    return out({ id: n, ok: true, value: open.ptz ? cur : {} });
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
    rel.at = Date.now();
    relLog.push(v);
    return out({ id: n, ok: true, value: null });
  }
  if (cmd === 'debug') return out({ id: n, ok: true, value: { relLog, rel, cur } });
  if (cmd === 'close') { rel.pan = 0; rel.tilt = 0; open = null; return out({ id: n, ok: true, value: null }); }
  return out({ id: n, ok: false, name: 'TypeError', message: `comando sconosciuto: ${cmd}` });
});
