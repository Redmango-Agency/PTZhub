'use strict';
/* global uvcHost */
/* Finestra nascosta della camera USB (UVC): tiene aperto il MediaStreamTrack con pan, tilt e zoom
 * ed esegue i comandi del driver (src/main/uvc.js). Dentro PTZ Hub la cattura è condivisa:
 * l'anteprima USB della Regia può usare la stessa camera nello stesso momento. */

let stream = null;
let track = null;

const plain = (o) => JSON.parse(JSON.stringify(o || {}));

function named(name, message) {
  const e = new Error(message);
  e.name = name;
  return e;
}

function pick(s) {
  const out = {};
  for (const k of ['deviceId', 'pan', 'tilt', 'zoom', 'focusMode', 'focusDistance', 'width', 'height']) {
    if (s && s[k] !== undefined) out[k] = s[k];
  }
  return out;
}

function liveTrack() {
  if (!track || track.readyState !== 'live') throw named('NotFoundError', 'camera USB non collegata');
  return track;
}

function close() {
  if (stream) {
    stream.getTracks().forEach((tr) => { tr.onended = null; tr.stop(); });
  }
  stream = null;
  track = null;
}

async function open({ deviceId, label } = {}) {
  close();
  let id = deviceId || '';
  // il codice del dispositivo può cambiare (altra presa USB): si ritrova dal nome
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  if (!devs.some((d) => d.deviceId && d.deviceId === id) && label) {
    const byLabel = devs.find((d) => d.label === label);
    if (byLabel && byLabel.deviceId) id = byLabel.deviceId;
  }
  // risoluzione predefinita: l'anteprima USB, che condivide la cattura, resta come prima
  const video = { pan: true, tilt: true, zoom: true };
  if (id) video.deviceId = { exact: id };
  const s = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  const tr = s.getVideoTracks()[0];
  if (!tr) {
    s.getTracks().forEach((x) => x.stop());
    throw named('NotFoundError', 'nessun video dalla camera USB');
  }
  stream = s;
  track = tr;
  // camera scollegata: il track finisce da solo
  tr.onended = () => {
    if (track !== tr) return;
    close();
    uvcHost.event({ type: 'ended' });
  };
  return {
    deviceId: tr.getSettings().deviceId || id,
    label: tr.label,
    caps: plain(tr.getCapabilities()),
    settings: plain(pick(tr.getSettings())),
  };
}

async function apply(values) {
  const tr = liveTrack();
  await tr.applyConstraints({ advanced: [values] });
  return plain(pick(tr.getSettings()));
}

uvcHost.onRequest(async (msg) => {
  const { id, op, args } = msg || {};
  try {
    let value = null;
    if (op === 'open') value = await open(args);
    else if (op === 'apply') value = await apply(args || {});
    else if (op === 'settings') value = plain(pick(liveTrack().getSettings()));
    else if (op === 'close') close();
    else throw named('TypeError', `comando sconosciuto: ${op}`);
    uvcHost.reply({ id, ok: true, value });
  } catch (e) {
    uvcHost.reply({ id, ok: false, error: { name: (e && e.name) || 'Error', message: String((e && e.message) || e) } });
  }
});

// camera collegata o scollegata: il driver riprova subito
navigator.mediaDevices.addEventListener('devicechange', () => uvcHost.event({ type: 'devicechange' }));
