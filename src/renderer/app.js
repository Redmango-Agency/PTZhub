'use strict';
/* global ptz */

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const PROTOCOL_LABEL = {
  'visca-udp': 'VISCA UDP', 'visca-tcp': 'VISCA TCP', 'visca-sony': 'Sony VISCA', onvif: 'ONVIF',
};
const DEFAULT_PORTS = { 'visca-udp': 1259, 'visca-tcp': 5678, 'visca-sony': 52381, onvif: 80 };
const HOTKEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

let settings = null;
let presets = [];
let info = {};
let activeId = null;
let camState = { state: 'disconnected', detail: '' };

// ---------------------------------------------------------------------------
// Utilità

const lastToastAt = new Map();

function toast(msg, kind = 'info', ms = 3800) {
  // lo stesso messaggio non si ripete prima di 10 secondi (es. errori di rete ricorrenti)
  const now = Date.now();
  if (now - (lastToastAt.get(msg) || 0) < 10000) return;
  lastToastAt.set(msg, now);
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function errMsg(e) {
  return String(e && e.message ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) || `p${Date.now()}${Math.random().toString(16).slice(2)}`;
}

function anyDialogOpen() {
  return $$('dialog').some((d) => d.open);
}

function choice(title, text, buttons) {
  return new Promise((resolve) => {
    const dlg = $('#dlgChoice');
    $('#cTitle').textContent = title;
    $('#cText').textContent = text;
    const box = $('#cActions');
    box.innerHTML = '';
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.value = b.value;
      btn.textContent = b.label;
      btn.className = b.className || '';
      box.appendChild(btn);
    }
    dlg.returnValue = '';
    dlg.onclose = () => resolve(dlg.returnValue || null);
    dlg.showModal();
  });
}

// ---------------------------------------------------------------------------
// Stato camera

function renderCamStatus() {
  const el = $('#camStatus');
  el.className = `cam-status ${camState.state}`;
  const c = settings.camera;
  $('#camLabel').textContent = c.host ? `${c.host} · ${PROTOCOL_LABEL[c.protocol] || c.protocol}` : 'Camera non configurata';
  const txt = {
    connected: 'connessa',
    connecting: 'connessione…',
    error: camState.detail || 'errore',
    disconnected: c.host ? 'disconnessa' : 'apri Impostazioni',
  }[camState.state] || '';
  $('#camDetail').textContent = txt;
  el.title = camState.detail || '';
}

// ---------------------------------------------------------------------------
// Movimento: joystick, tastiera, pulsanti

let moveTarget = { x: 0, y: 0 };
let moveSentAt = 0;
let moveTimer = null;
let moveActive = false;

function setMove(x, y) {
  moveTarget = { x, y };
  moveActive = x !== 0 || y !== 0;
  const now = performance.now();
  const flush = () => {
    moveSentAt = performance.now();
    ptz.cmd('move', moveTarget.x, moveTarget.y);
  };
  if (!moveActive) { clearTimeout(moveTimer); flush(); return; }
  if (now - moveSentAt > 50) flush();
  else { clearTimeout(moveTimer); moveTimer = setTimeout(flush, 50 - (now - moveSentAt)); }
}

function stopAll() {
  clearTimeout(moveTimer);
  moveTarget = { x: 0, y: 0 };
  moveActive = false;
  zoomActive = false;
  focusActive = false;
  keys.clear();
  $$('.hold.pressed').forEach((b) => b.classList.remove('pressed'));
  resetKnob();
  ptz.cmd('stop');
}

const joy = $('#joy');
const knob = joy.querySelector('.knob');
let joyPointer = null;

function resetKnob() {
  knob.style.transform = 'translate(-50%, -50%)';
  joy.classList.remove('active');
}

function shape(v) {
  const dz = 0.1;
  const a = Math.abs(v);
  if (a < dz) return 0;
  return Math.sign(v) * ((a - dz) / (1 - dz)) ** 1.6; // più precisione vicino al centro
}

function joyUpdate(e) {
  const r = joy.getBoundingClientRect();
  const R = r.width / 2 - 29; // raggio utile: bordo meno metà della manopola
  let dx = (e.clientX - (r.left + r.width / 2)) / R;
  let dy = (e.clientY - (r.top + r.height / 2)) / R;
  const m = Math.hypot(dx, dy);
  if (m > 1) { dx /= m; dy /= m; }
  knob.style.transform = `translate(calc(-50% + ${dx * R}px), calc(-50% + ${dy * R}px))`;
  const sp = settings.moveSpeed;
  setMove(shape(dx) * sp, -shape(dy) * sp);
}

joy.addEventListener('pointerdown', (e) => {
  joyPointer = e.pointerId;
  joy.setPointerCapture(e.pointerId);
  joy.classList.add('active');
  joyUpdate(e);
});
joy.addEventListener('pointermove', (e) => { if (e.pointerId === joyPointer) joyUpdate(e); });
const joyEnd = (e) => {
  if (e.pointerId !== joyPointer) return;
  joyPointer = null;
  resetKnob();
  setMove(0, 0);
};
joy.addEventListener('pointerup', joyEnd);
joy.addEventListener('pointercancel', joyEnd);
joy.addEventListener('lostpointercapture', joyEnd);

let zoomActive = false;
let focusActive = false;

function setAfUi(on) {
  $('#btnAF').classList.toggle('on', on);
  $('#btnAF').textContent = on ? 'Automatico' : 'Manuale';
}

for (const b of $$('.hold')) {
  const start = (e) => {
    e.preventDefault();
    b.setPointerCapture(e.pointerId);
    b.classList.add('pressed');
    if (b.dataset.zoom) {
      zoomActive = true;
      ptz.cmd('zoom', Number(b.dataset.zoom) * settings.moveSpeed);
    } else if (b.dataset.focus) {
      focusActive = true;
      setAfUi(false);
      ptz.cmd('focusAuto', false);
      ptz.cmd('focus', Number(b.dataset.focus) * 0.4);
    }
  };
  const end = () => {
    if (!b.classList.contains('pressed')) return;
    b.classList.remove('pressed');
    if (b.dataset.zoom) { zoomActive = false; ptz.cmd('zoom', 0); }
    if (b.dataset.focus) { focusActive = false; ptz.cmd('focus', 0); }
  };
  b.addEventListener('pointerdown', start);
  b.addEventListener('pointerup', end);
  b.addEventListener('pointercancel', end);
  b.addEventListener('lostpointercapture', end);
}

$('#btnAF').addEventListener('click', () => {
  const on = !$('#btnAF').classList.contains('on');
  setAfUi(on);
  ptz.cmd('focusAuto', on);
});
$('#btnOnePush').addEventListener('click', () => ptz.cmd('onePush'));
$('#btnHome').addEventListener('click', () => { activeId = null; renderPresets(); ptz.cmd('home'); });
$('#btnStop').addEventListener('click', () => stopAll());
$('#btnStopCompact').addEventListener('click', () => stopAll());

// Tastiera. Ogni tasto premuto viene ricordato per codice fisico (e.code): così il
// rilascio ferma sempre il movimento, anche se nel frattempo è cambiato Maiusc.
const keys = new Map(); // e.code -> azione
const isTyping = () => {
  const a = document.activeElement;
  if (!a) return false;
  if (a.tagName === 'INPUT') return !['range', 'checkbox', 'radio', 'button'].includes(a.type);
  return a.tagName === 'SELECT' || a.tagName === 'TEXTAREA';
};
const held = (action) => [...keys.values()].includes(action);

function keyMove(shift) {
  const x = (held('right') ? 1 : 0) - (held('left') ? 1 : 0);
  const y = (held('up') ? 1 : 0) - (held('down') ? 1 : 0);
  const sp = settings.moveSpeed * (shift ? 0.3 : 1);
  setMove(x * sp, y * sp);
}

function keyZoom(shift) {
  const z = (held('zoomIn') ? 1 : 0) - (held('zoomOut') ? 1 : 0);
  zoomActive = z !== 0;
  ptz.cmd('zoom', z * settings.moveSpeed * (shift ? 0.3 : 1));
}

const CODE_ACTIONS = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
  PageUp: 'zoomIn', NumpadAdd: 'zoomIn', PageDown: 'zoomOut', NumpadSubtract: 'zoomOut',
};
const KEY_ACTIONS = { '+': 'zoomIn', '-': 'zoomOut' }; // tasti +/- della tastiera principale

window.addEventListener('keydown', (e) => {
  if (anyDialogOpen() || isTyping()) return;
  if (e.key === 'Escape' || e.code === 'Space') {
    e.preventDefault();
    stopAll();
    return;
  }
  const action = CODE_ACTIONS[e.code] || (!e.ctrlKey && !e.altKey ? KEY_ACTIONS[e.key] : null);
  if (action) {
    e.preventDefault();
    if (e.repeat || keys.has(e.code)) return;
    keys.set(e.code, action);
    if (action.startsWith('zoom')) keyZoom(e.shiftKey); else keyMove(e.shiftKey);
    return;
  }
  if (!e.ctrlKey && !e.altKey && !e.metaKey && !e.repeat) {
    const digit = /^Digit(\d)$/.exec(e.code) || /^Numpad(\d)$/.exec(e.code);
    if (digit && !editor) {
      e.preventDefault();
      const idx = HOTKEYS.indexOf(digit[1]);
      if (presets[idx]) recall(presets[idx]);
    }
  }
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') e.preventDefault();
  const action = keys.get(e.code);
  if (!action) return;
  keys.delete(e.code);
  if (action.startsWith('zoom')) keyZoom(e.shiftKey); else keyMove(e.shiftKey);
});

// Se la finestra perde il fuoco durante un movimento manuale, si ferma la testa
// (non si interrompe il richiamo di un'inquadratura già avviato)
window.addEventListener('blur', () => {
  if (moveActive || zoomActive || focusActive || keys.size) stopAll();
});

// Velocità
function bindSlider(id, key) {
  const input = $(`#${id}`);
  const out = $(`#${id}Val`);
  input.value = settings[key];
  out.textContent = `${Math.round(settings[key] * 100)}%`;
  let t = null;
  input.addEventListener('input', () => {
    settings[key] = Number(input.value);
    out.textContent = `${Math.round(settings[key] * 100)}%`;
    clearTimeout(t);
    t = setTimeout(() => ptz.saveSettings({ [key]: settings[key] }), 400);
  });
}

// ---------------------------------------------------------------------------
// Anteprima

const canvas = $('#video');
const ctx = canvas.getContext('2d');
const usbVideo = $('#usbVideo');
let lastFrame = null; // ImageBitmap o elemento video
let usbStream = null;
let usbRaf = null;
let previewState = { state: 'off', detail: '' };

function fitCanvas() {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * dpr));
  const h = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    if (lastFrame) draw(lastFrame);
  }
}
new ResizeObserver(fitCanvas).observe($('#videoWrap'));

function sourceSize(src) {
  return src instanceof HTMLVideoElement ? [src.videoWidth, src.videoHeight] : [src.width, src.height];
}

function draw(src) {
  const [sw, sh] = sourceSize(src);
  if (!sw || !sh) return;
  const W = canvas.width;
  const H = canvas.height;
  const s = Math.min(W / sw, H / sh);
  const dw = sw * s;
  const dh = sh * s;
  const dx = (W - dw) / 2;
  const dy = (H - dh) / 2;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#050608';
  ctx.fillRect(0, 0, W, H);
  if (settings.preview.rotate180) {
    ctx.translate(W, H);
    ctx.rotate(Math.PI);
  }
  ctx.drawImage(src, dx, dy, dw, dh);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (settings.preview.grid) {
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = Math.max(1, (window.devicePixelRatio || 1));
    ctx.beginPath();
    for (let i = 1; i < 3; i++) {
      ctx.moveTo(dx + (dw * i) / 3, dy); ctx.lineTo(dx + (dw * i) / 3, dy + dh);
      ctx.moveTo(dx, dy + (dh * i) / 3); ctx.lineTo(dx + dw, dy + (dh * i) / 3);
    }
    ctx.stroke();
    ctx.beginPath();
    const cx = dx + dw / 2;
    const cy = dy + dh / 2;
    const k = 10 * (window.devicePixelRatio || 1);
    ctx.moveTo(cx - k, cy); ctx.lineTo(cx + k, cy);
    ctx.moveTo(cx, cy - k); ctx.lineTo(cx, cy + k);
    ctx.stroke();
  }
}

function setPreviewMsg(text) {
  const el = $('#previewMsg');
  el.textContent = text || '';
  el.classList.toggle('hidden', !text);
}

function renderPreviewState() {
  const src = settings.preview.source;
  const live = previewState.state === 'live';
  $('#liveBadge').classList.toggle('on', live);
  if (src === 'none') { setPreviewMsg('Anteprima disattivata'); return; }
  if (live) { setPreviewMsg(''); return; }
  if (src === 'rtsp' && !settings.preview.rtspUrl) { setPreviewMsg('Anteprima non configurata — apri Impostazioni e premi «Trova»'); return; }
  if (previewState.state === 'connecting') setPreviewMsg('Connessione al video…');
  else if (previewState.state === 'error') setPreviewMsg(`Video non disponibile: ${previewState.detail}`);
  else setPreviewMsg('');
}

ptz.onFrame(async (buf) => {
  try {
    const bmp = await createImageBitmap(new Blob([buf], { type: 'image/jpeg' }));
    if (lastFrame && lastFrame.close) lastFrame.close();
    lastFrame = bmp;
    draw(bmp);
  } catch (_) {
    // fotogramma corrotto: si salta
  } finally {
    ptz.ackFrame();
  }
});

ptz.onPreviewStatus((s) => {
  if (settings.preview.source !== 'rtsp') return;
  previewState = s;
  renderPreviewState();
});

async function startUsb() {
  stopUsb();
  try {
    const constraints = { video: settings.preview.usbDeviceId ? { deviceId: { exact: settings.preview.usbDeviceId } } : true, audio: false };
    usbStream = await navigator.mediaDevices.getUserMedia(constraints);
    usbVideo.srcObject = usbStream;
    await usbVideo.play();
    previewState = { state: 'live', detail: '' };
    renderPreviewState();
    const loop = () => {
      if (!usbStream) return;
      lastFrame = usbVideo;
      draw(usbVideo);
      usbRaf = requestAnimationFrame(loop);
    };
    loop();
  } catch (e) {
    previewState = { state: 'error', detail: `USB: ${e.message}` };
    renderPreviewState();
  }
}

function stopUsb() {
  cancelAnimationFrame(usbRaf);
  if (usbStream) usbStream.getTracks().forEach((t) => t.stop());
  usbStream = null;
  usbVideo.srcObject = null;
}

function applyPreviewSource() {
  if (settings.preview.source === 'usb') {
    startUsb();
  } else {
    stopUsb();
    if (lastFrame instanceof HTMLVideoElement) lastFrame = null;
    if (settings.preview.source === 'none') previewState = { state: 'off', detail: '' };
    renderPreviewState();
  }
}

function captureThumb() {
  if (!lastFrame) return null;
  const [sw, sh] = sourceSize(lastFrame);
  if (!sw || !sh) return null;
  const c = document.createElement('canvas');
  c.width = 320;
  c.height = 180;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, 320, 180);
  const s = Math.max(320 / sw, 180 / sh);
  if (settings.preview.rotate180) { g.translate(320, 180); g.rotate(Math.PI); }
  g.drawImage(lastFrame, (320 - sw * s) / 2, (180 - sh * s) / 2, sw * s, sh * s);
  return c.toDataURL('image/jpeg', 0.72);
}

// ---------------------------------------------------------------------------
// Inquadrature

function persist() {
  return ptz.savePresets(presets).catch((e) => toast(`Salvataggio non riuscito: ${errMsg(e)}`, 'err'));
}

function renderPresets() {
  const grid = $('#presetGrid');
  grid.innerHTML = '';
  if (!presets.length) {
    grid.innerHTML = '<div class="empty-presets">Nessuna inquadratura. Componi l’immagine con joystick e zoom, poi premi «Salva inquadratura».</div>';
    return;
  }
  presets.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = `preset${p.id === activeId ? ' active' : ''}`;
    b.dataset.id = p.id;
    b.title = `${p.name}${i < 10 ? ` — tasto ${HOTKEYS[i]}` : ''}`;
    const thumb = p.thumb ? `style="background-image:url('${p.thumb}')"` : '';
    b.innerHTML = `<div class="thumb" ${thumb}>${p.thumb ? '' : '◎'}</div>`
      + `<div class="meta"><span class="num">${i < 10 ? HOTKEYS[i] : '·'}</span><span class="name">${esc(p.name)}</span>`
      + '<span class="edit" title="Modifica">✎</span></div>'
      + (p.slot != null ? `<span class="slot-tag">mem. ${p.slot}</span>` : '');
    b.addEventListener('click', (e) => {
      if (e.target.closest('.edit')) { openEditor(p.id); return; }
      recall(p);
    });
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); openEditor(p.id); });
    grid.appendChild(b);
  });
}

async function recall(p) {
  if (!p) return;
  stopManualOnly();
  try {
    if (p.pos) await ptz.goto(p.pos, settings.recallSpeed);
    else if (p.slot != null) await ptz.recallSlot(p.slot);
    else throw new Error('inquadratura senza posizione salvata');
    activeId = p.id;
    if (p.pos && p.pos.focusAuto !== undefined) setAfUi(p.pos.focusAuto !== false);
    renderPresets();
  } catch (e) {
    toast(`«${p.name}»: ${errMsg(e)}`, 'err');
  }
}

// ferma solo i comandi manuali in corso, prima di un richiamo
function stopManualOnly() {
  // si "staccano" joystick, pulsanti e tasti tenuti premuti: al loro rilascio
  // non deve partire uno stop che interromperebbe il richiamo
  joyPointer = null;
  resetKnob();
  $$('.hold.pressed').forEach((btn) => btn.classList.remove('pressed'));
  keys.clear();
  if (moveActive) setMove(0, 0);
  if (zoomActive) { zoomActive = false; ptz.cmd('zoom', 0); }
  if (focusActive) { focusActive = false; ptz.cmd('focus', 0); }
}

function usedSlots() {
  return new Set(presets.filter((p) => p.slot != null).map((p) => p.slot));
}

function nextFreeSlot() {
  const used = usedSlots();
  for (let n = Math.max(0, settings.slotBase | 0); n <= 254; n++) {
    if (n >= 90 && n <= 99) continue; // memorie spesso riservate a funzioni speciali (menu, ecc.)
    if (!used.has(n)) return n;
  }
  throw new Error('nessuna memoria libera nella camera');
}

async function captureCurrent(existingSlot = null) {
  if (settings.presetMode === 'slot') {
    const slot = existingSlot != null ? existingSlot : nextFreeSlot();
    await ptz.saveSlot(slot);
    return { pos: null, slot };
  }
  const pos = await ptz.getPosition();
  return { pos, slot: null };
}

function explainCaptureError(e) {
  const m = errMsg(e);
  if (/nessuna risposta|posizione|non comunica|inattesa/i.test(m)) {
    return `${m}. Se la camera non sa dire dove si trova, in Impostazioni scegli «Nelle memorie della camera».`;
  }
  return m;
}

// ---------------------------------------------------------------------------
// Editor delle inquadrature: la schermata diventa "modifica", con anteprima grande e
// comandi della camera. Si posiziona la testa e con «Salva» si memorizzano le coordinate
// (pan, tilt, zoom, fuoco) lette dalla camera, più una miniatura.

let editor = null; // { mode: 'new' | 'edit', id, wasCompact }

function editorPreset() {
  return editor && editor.id ? presets.find((x) => x.id === editor.id) : null;
}

function renderEditor() {
  const p = editorPreset();
  const idx = p ? presets.indexOf(p) : -1;
  $('#edTitle').textContent = p ? `Modifica «${p.name}»` : 'Nuova inquadratura';
  $('#edSave').textContent = p ? 'Salva modifiche' : 'Salva inquadratura';
  $('#edExisting').style.display = p ? '' : 'none';
  $('#edLeft').disabled = idx <= 0;
  $('#edRight').disabled = idx < 0 || idx >= presets.length - 1;
  $('#edKey').textContent = p && idx < 10 ? `tasto ${HOTKEYS[idx]}` : (!p && presets.length < 10 ? `tasto ${HOTKEYS[presets.length]}` : '');
}

async function openEditor(id = null) {
  if (editor) return;
  const p = id ? presets.find((x) => x.id === id) : null;
  if (id && !p) return;
  stopManualOnly();
  editor = { mode: p ? 'edit' : 'new', id: p ? p.id : null, wasCompact: !!settings.compact };
  if (settings.compact) {
    settings.compact = await ptz.setCompact(false);
    renderCompact();
  }
  document.body.classList.add('editing');
  $('#edName').value = p ? p.name : `Inquadratura ${presets.length + 1}`;
  renderEditor();
  if (document.activeElement) document.activeElement.blur(); // le frecce muovono la camera
  if (camState.state !== 'connected') toast('La camera non risulta connessa: controlla le Impostazioni prima di salvare.', 'warn', 6000);
  if (p) await recall(p); // si parte dalla posizione salvata, poi la si ritocca
}

async function closeEditor() {
  if (!editor) return;
  const back = editor.wasCompact;
  editor = null;
  document.body.classList.remove('editing');
  renderPresets();
  if (back) {
    settings.compact = await ptz.setCompact(true);
    renderCompact();
  }
}

async function saveEditor() {
  if (!editor) return;
  const btn = $('#edSave');
  const existing = editorPreset();
  btn.disabled = true;
  let captured;
  try {
    captured = await captureCurrent(existing ? existing.slot : null);
  } catch (e) {
    toast(explainCaptureError(e), 'err', 7000);
    btn.disabled = false;
    return;
  }
  btn.disabled = false;
  const thumb = captureThumb();
  const now = new Date().toISOString();
  const name = $('#edName').value.trim() || (existing ? existing.name : `Inquadratura ${presets.length + 1}`);
  let p = existing;
  if (p) {
    Object.assign(p, {
      name, pos: captured.pos, slot: captured.slot, protocol: settings.camera.protocol, updatedAt: now,
    });
    if (thumb) p.thumb = thumb;
  } else {
    p = {
      id: uid(), name, protocol: settings.camera.protocol, pos: captured.pos, slot: captured.slot, thumb, createdAt: now, updatedAt: now,
    };
    presets.push(p);
  }
  activeId = p.id;
  await persist();
  const idx = presets.indexOf(p);
  toast(`${existing ? 'Aggiornata' : 'Salvata'} «${p.name}»${idx < 10 ? ` — tasto ${HOTKEYS[idx]}` : ''}`, 'ok');
  await closeEditor();
}

function moveEdited(delta) {
  const p = editorPreset();
  if (!p) return;
  const idx = presets.indexOf(p);
  const to = idx + delta;
  if (to < 0 || to >= presets.length) return;
  presets.splice(idx, 1);
  presets.splice(to, 0, p);
  persist();
  renderEditor();
}

$('#btnSavePreset').addEventListener('click', () => openEditor());
$('#edSave').addEventListener('click', saveEditor);
$('#edCancel').addEventListener('click', () => closeEditor());
$('#edLeft').addEventListener('click', () => moveEdited(-1));
$('#edRight').addEventListener('click', () => moveEdited(1));
$('#edName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); saveEditor(); }
  if (e.key === 'Escape') { e.preventDefault(); e.target.blur(); }
});
$('#edDelete').addEventListener('click', async () => {
  const p = editorPreset();
  if (!p) return;
  const r = await choice('Eliminare l’inquadratura?', `«${p.name}» verrà rimossa da questo account.`, [
    { label: 'Annulla', value: 'no', className: 'ghost' },
    { label: 'Elimina', value: 'yes', className: 'danger' },
  ]);
  if (r !== 'yes') return;
  presets = presets.filter((x) => x.id !== p.id);
  if (activeId === p.id) activeId = null;
  await persist();
  await closeEditor();
  toast(`Eliminata «${p.name}»`, 'ok');
});

// ---------------------------------------------------------------------------
// Impostazioni

function fillSettingsForm() {
  const c = settings.camera;
  const p = settings.preview;
  $('#sHost').value = c.host || '';
  $('#sProtocol').value = c.protocol;
  $('#sPort').value = c.port || DEFAULT_PORTS[c.protocol];
  $('#sAddress').value = c.address || 1;
  $('#sUser').value = c.user || '';
  $('#sPass').value = c.pass || '';
  $('#sInvertPan').checked = !!c.invertPan;
  $('#sInvertTilt').checked = !!c.invertTilt;
  $('#sSource').value = p.source;
  $('#sWidth').value = String(p.width || 960);
  $('#sRtsp').value = p.rtspUrl || '';
  $('#sRotate').checked = !!p.rotate180;
  $('#sGrid').checked = !!p.grid;
  $('#sPresetMode').value = settings.presetMode;
  $('#sSlotBase').value = settings.slotBase;
  $('#sGlobal').checked = !!settings.globalHotkeys;
  $('#discoverOut').innerHTML = '';
  $('#rtspOut').innerHTML = '';
  $('#aboutLine').textContent = `PTZ Panel ${info.version} · account ${info.user} · dati in ${info.dataDir}`;
  updateFormVisibility();
  if (p.source === 'usb') listUsbDevices(p.usbDeviceId);
}

function updateFormVisibility() {
  const src = $('#sSource').value;
  $$('.rtsp-only').forEach((el) => { el.style.display = src === 'rtsp' ? '' : 'none'; });
  $$('.usb-only').forEach((el) => { el.style.display = src === 'usb' ? '' : 'none'; });
  const slot = $('#sPresetMode').value === 'slot';
  $$('.slot-only').forEach((el) => { el.style.visibility = slot ? 'visible' : 'hidden'; });
  const onvif = $('#sProtocol').value === 'onvif';
  $('#sAddress').disabled = onvif;
  $('#presetModeNote').textContent = slot
    ? 'Le inquadrature restano nella camera: ogni account usa memorie diverse a partire da quella indicata (ad es. 10 per il primo, 60 per il secondo), così non si sovrascrivono.'
    : 'La posizione esatta (pan, tilt, zoom e fuoco) viene salvata nel programma, separata per ogni account di Windows. La camera deve saper comunicare la sua posizione.';
}

$('#sSource').addEventListener('change', () => {
  updateFormVisibility();
  if ($('#sSource').value === 'usb') listUsbDevices(settings.preview.usbDeviceId);
});
$('#sPresetMode').addEventListener('change', () => {
  updateFormVisibility();
  if ($('#sPresetMode').value === 'slot') {
    toast(`Questo account usa le memorie della camera da ${$('#sSlotBase').value} in su: verifica che gli altri account abbiano un numero diverso.`, 'warn', 7000);
  }
});
$('#sProtocol').addEventListener('change', () => {
  $('#sPort').value = DEFAULT_PORTS[$('#sProtocol').value];
  updateFormVisibility();
});

async function listUsbDevices(selected) {
  const sel = $('#sUsb');
  try {
    // serve un primo accesso per leggere i nomi dei dispositivi
    const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }).catch(() => null);
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    if (tmp) tmp.getTracks().forEach((t) => t.stop());
    sel.innerHTML = devs.map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || `Videocamera ${i + 1}`)}</option>`).join('')
      || '<option value="">Nessun dispositivo video trovato</option>';
    if (selected) sel.value = selected;
  } catch (e) {
    sel.innerHTML = `<option value="">${esc(e.message)}</option>`;
  }
}

function formCamera() {
  return {
    host: $('#sHost').value.trim(),
    protocol: $('#sProtocol').value,
    port: Number($('#sPort').value) || DEFAULT_PORTS[$('#sProtocol').value],
    address: clamp(Number($('#sAddress').value) || 1, 1, 7),
    user: $('#sUser').value.trim(),
    pass: $('#sPass').value,
    invertPan: $('#sInvertPan').checked,
    invertTilt: $('#sInvertTilt').checked,
  };
}

function line(html, cls = '') {
  return `<div class="line ${cls}">${html}</div>`;
}

$('#btnDiscover').addEventListener('click', async () => {
  const out = $('#discoverOut');
  const btn = $('#btnDiscover');
  btn.disabled = true;
  out.innerHTML = line('Ricerca nella rete locale in corso (circa 10–20 secondi)…');
  try {
    const r = await ptz.discover();
    const nets = r.networks.map((n) => `${n.address}`).join(', ') || 'nessuna';
    if (!r.devices.length) {
      out.innerHTML = line(`Nessun dispositivo video trovato. Reti di questo PC: ${esc(nets)}. Controlla che la camera sia sulla stessa rete (stessi primi tre numeri dell'IP).`, 'bad');
      return;
    }
    out.innerHTML = r.devices.map((d) => {
      const tags = [d.onvif ? 'ONVIF' : null, d.rtsp ? 'video RTSP' : null, d.http ? 'pagina web' : null].filter(Boolean).join(' · ');
      const name = [d.name, d.hardware].filter(Boolean).join(' ');
      return `<div class="line pick ok" data-ip="${esc(d.ip)}"><b>${esc(d.ip)}</b> — ${esc(tags)}${name ? ` — ${esc(name)}` : ''}</div>`;
    }).join('') + line(`Clicca un indirizzo per usarlo. Reti di questo PC: ${esc(nets)}`, 'bad');
    out.querySelectorAll('.pick').forEach((el) => el.addEventListener('click', () => {
      $('#sHost').value = el.dataset.ip;
      detectProtocol();
    }));
  } catch (e) {
    out.innerHTML = line(`Errore nella ricerca: ${esc(errMsg(e))}`, 'bad');
  } finally {
    btn.disabled = false;
  }
});

async function detectProtocol() {
  const out = $('#discoverOut');
  const c = formCamera();
  if (!c.host) { toast('Inserisci prima l’indirizzo IP', 'warn'); return; }
  const btn = $('#btnDetect');
  btn.disabled = true;
  out.innerHTML = line(`Verifico i protocolli di ${esc(c.host)}…`);
  try {
    const r = await ptz.detectProtocols({ host: c.host, user: c.user, pass: c.pass, address: c.address });
    const rows = [];
    for (const v of r.visca) {
      rows.push(line(`${esc(v.label)}: ${v.ok ? `risponde${v.position ? ', legge la posizione ✓' : ' (posizione non leggibile)'}` : 'nessuna risposta'}`, v.ok ? 'ok' : 'bad'));
    }
    if (r.onvif.ok) {
      const det = r.onvif.error ? `errore: ${esc(r.onvif.error)}` : `${r.onvif.ptz ? 'controllo PTZ ✓' : 'senza PTZ'}${r.onvif.position ? ', posizione ✓' : ''}`;
      rows.push(line(`ONVIF (porta ${r.onvif.port}): ${det}`, r.onvif.ptz ? 'ok' : 'bad'));
    } else {
      rows.push(line('ONVIF: non trovato', 'bad'));
    }
    if (r.http.ok) rows.push(line(`Pagina web: ${esc(r.http.title || 'presente')}${r.http.server ? ` (${esc(r.http.server)})` : ''}`, 'bad'));

    // scelta automatica: prima chi legge la posizione
    const order = ['udp', 'tcp', 'sony'];
    const proto = { udp: 'visca-udp', tcp: 'visca-tcp', sony: 'visca-sony' };
    const best = order.map((m) => r.visca.find((v) => v.mode === m)).find((v) => v && v.ok && v.position);
    const anyVisca = order.map((m) => r.visca.find((v) => v.mode === m)).find((v) => v && v.ok);
    let chosen = null;
    let needSlot = false;
    if (best) chosen = { protocol: proto[best.mode], port: best.port };
    else if (r.onvif.ok && r.onvif.ptz && r.onvif.position) chosen = { protocol: 'onvif', port: r.onvif.port };
    else if (anyVisca) { chosen = { protocol: proto[anyVisca.mode], port: anyVisca.port }; needSlot = true; }
    else if (r.onvif.ok && r.onvif.ptz) { chosen = { protocol: 'onvif', port: r.onvif.port }; needSlot = true; }

    if (chosen) {
      $('#sProtocol').value = chosen.protocol;
      $('#sPort').value = chosen.port;
      if (needSlot) $('#sPresetMode').value = 'slot';
      updateFormVisibility();
      rows.unshift(line(`<b>Impostato: ${esc(PROTOCOL_LABEL[chosen.protocol])} porta ${chosen.port}</b>${needSlot ? ' — la camera non comunica la posizione: inquadrature salvate nelle sue memorie' : ''}. Premi «Salva».`, 'ok'));
    } else if (r.onvif.ok && r.onvif.error && /author|autoriz|401/i.test(r.onvif.error)) {
      rows.unshift(line('ONVIF richiede utente e password: inseriscili e riprova.', 'bad'));
    } else {
      rows.unshift(line('Nessun protocollo di controllo ha risposto. Verifica IP, che VISCA over IP o ONVIF siano attivi nella pagina web della camera, o prova il cavo seriale.', 'bad'));
    }
    out.innerHTML = rows.join('');
    if (settings.preview.source === 'rtsp' && !$('#sRtsp').value && (r.onvif.ok || r.http.ok || anyVisca)) findRtsp();
  } catch (e) {
    out.innerHTML = line(`Errore: ${esc(errMsg(e))}`, 'bad');
  } finally {
    btn.disabled = false;
  }
}
$('#btnDetect').addEventListener('click', detectProtocol);

async function findRtsp() {
  const out = $('#rtspOut');
  const c = formCamera();
  if (!c.host) { toast('Inserisci prima l’indirizzo IP', 'warn'); return; }
  const btn = $('#btnFindRtsp');
  btn.disabled = true;
  out.innerHTML = line('Cerco il flusso video (può richiedere fino a un minuto)…');
  try {
    const onvifPort = c.protocol === 'onvif' ? c.port : 80;
    const r = await ptz.detectRtsp({ host: c.host, user: c.user, pass: c.pass, onvifPort });
    const ok = r.filter((x) => x.ok);
    if (!ok.length) {
      out.innerHTML = line('Nessun flusso trovato automaticamente. Inserisci l’indirizzo RTSP indicato nella pagina web della camera (sezione Rete/Stream) e premi «Prova».', 'bad')
        + r.map((x) => line(`${esc(x.display)} — ${esc(x.error || 'non valido')}`, 'bad')).join('');
      return;
    }
    $('#sRtsp').value = ok[0].url;
    out.innerHTML = line(`<b>Trovato:</b> ${esc(ok[0].display)} (${esc(ok[0].note)}). Clicca un'altra voce per cambiarlo.`, 'ok')
      + ok.map((x) => `<div class="line pick" data-url="${esc(x.url)}">${esc(x.display)} — ${esc(x.note)}</div>`).join('');
    out.querySelectorAll('.pick').forEach((el) => el.addEventListener('click', () => { $('#sRtsp').value = el.dataset.url; }));
  } catch (e) {
    out.innerHTML = line(`Errore: ${esc(errMsg(e))}`, 'bad');
  } finally {
    btn.disabled = false;
  }
}
$('#btnFindRtsp').addEventListener('click', findRtsp);

$('#btnTestRtsp').addEventListener('click', async () => {
  const url = $('#sRtsp').value.trim();
  if (!url) return;
  const out = $('#rtspOut');
  out.innerHTML = line('Provo il flusso…');
  const r = await ptz.testUrl(url);
  out.innerHTML = r.ok ? line('Il flusso funziona ✓', 'ok') : line(`Non funziona: ${esc(r.error || 'errore')}`, 'bad');
});

$('#btnExport').addEventListener('click', async () => {
  try {
    const f = await ptz.exportPresets(presets);
    if (f) toast(`Esportate ${presets.length} inquadrature`, 'ok');
  } catch (e) { toast(errMsg(e), 'err'); }
});

$('#btnImport').addEventListener('click', async () => {
  let list;
  try { list = await ptz.importPresets(); } catch (e) { toast(errMsg(e), 'err'); return; }
  if (!list) return;
  const valid = list.filter((p) => p && (p.pos || p.slot != null));
  if (!valid.length) { toast('Il file non contiene inquadrature valide', 'warn'); return; }
  const r = await choice('Importa inquadrature', `Il file contiene ${valid.length} inquadrature.`, [
    { label: 'Annulla', value: 'no', className: 'ghost' },
    { label: 'Aggiungi alle mie', value: 'add' },
    { label: 'Sostituisci le mie', value: 'replace', className: 'primary' },
  ]);
  if (r !== 'add' && r !== 'replace') return;
  const fresh = valid.map((p) => ({ ...p, id: uid() }));
  presets = r === 'replace' ? fresh : presets.concat(fresh);
  activeId = null;
  renderPresets();
  await persist();
  toast(`Importate ${fresh.length} inquadrature`, 'ok');
});

$('#btnDataFolder').addEventListener('click', () => ptz.openDataFolder());

$('#btnSettings').addEventListener('click', () => {
  fillSettingsForm();
  $('#dlgSettings').showModal();
});

$('#dlgSettings').addEventListener('close', async () => {
  if ($('#dlgSettings').returnValue !== 'save') return;
  const partial = {
    camera: formCamera(),
    preview: {
      source: $('#sSource').value,
      rtspUrl: $('#sRtsp').value.trim(),
      usbDeviceId: $('#sUsb').value || settings.preview.usbDeviceId || '',
      width: Number($('#sWidth').value) || 960,
      rotate180: $('#sRotate').checked,
      grid: $('#sGrid').checked,
    },
    presetMode: $('#sPresetMode').value,
    slotBase: clamp(Number($('#sSlotBase').value) || 0, 0, 240),
    globalHotkeys: $('#sGlobal').checked,
  };
  const prevSource = `${settings.preview.source}|${settings.preview.usbDeviceId}`;
  try {
    const r = await ptz.saveSettings(partial);
    settings = r.settings;
    if (r.hotkeys && !r.hotkeys.ok) {
      toast(`Alcune scorciatoie sono già usate da un altro programma: ${r.hotkeys.failed.join(', ')}`, 'warn', 6000);
    }
    if (`${settings.preview.source}|${settings.preview.usbDeviceId}` !== prevSource) applyPreviewSource();
    renderCamStatus();
    renderPreviewState();
    if (lastFrame) draw(lastFrame);
    toast('Impostazioni salvate', 'ok');
  } catch (e) {
    toast(`Impostazioni non salvate: ${errMsg(e)}`, 'err');
  }
});

// ---------------------------------------------------------------------------
// Finestra

function renderPin() {
  $('#btnPin').classList.toggle('on', !!settings.alwaysOnTop);
}

$('#btnPin').addEventListener('click', async () => {
  const r = await ptz.saveSettings({ alwaysOnTop: !settings.alwaysOnTop });
  settings = r.settings;
  renderPin();
});

function renderCompact() {
  document.body.classList.toggle('compact', !!settings.compact);
  $('#btnCompact').textContent = settings.compact ? 'Completa' : 'Compatta';
}

$('#btnCompact').addEventListener('click', async () => {
  settings.compact = await ptz.setCompact(!settings.compact);
  renderCompact();
});

// ---------------------------------------------------------------------------
// Avvio

(async () => {
  const s = await ptz.init();
  settings = s.settings;
  presets = s.presets || [];
  info = s.info;
  camState = s.camStatus;
  previewState = s.previewStatus;
  $('#account').textContent = info.user;
  bindSlider('moveSpeed', 'moveSpeed');
  bindSlider('recallSpeed', 'recallSpeed');
  renderCamStatus();
  renderPin();
  renderCompact();
  renderPresets();
  applyPreviewSource();

  ptz.onCamStatus((st) => {
    const was = camState.state;
    camState = st;
    renderCamStatus();
    if (was === 'connected' && st.state !== 'connected') toast(`Camera: ${st.detail || 'connessione persa'}`, 'warn');
  });
  ptz.onCamLog((m) => toast(m, 'warn'));
  ptz.onHotkey((h) => {
    if (h.type === 'preset' && !editor) recall(presets[h.index]);
    if (h.type === 'stop') stopAll();
  });

  if (!settings.camera.host) {
    fillSettingsForm();
    $('#dlgSettings').showModal();
  }
})();
