'use strict';
/* global ptz */

const { t } = window.I18N;
const {
  esc, HOTKEYS, presetNum, PROTOCOL_LABEL, ICONS, thumbHtml, cameraName, camLevel,
} = window.UI;
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const DEFAULT_PORTS = { 'visca-udp': 1259, 'visca-tcp': 5678, 'visca-sony': 52381, onvif: 80 };
const PROTOCOL_DESC = {
  'visca-udp': 'VISCA over IP, UDP', 'visca-tcp': 'VISCA over IP, TCP', 'visca-sony': 'Sony VISCA over IP', onvif: 'ONVIF',
};

let settings = null;
let presets = [];
let info = {};
let activeId = null;
let recallingId = null; // inquadratura verso cui la camera sta andando (richiesta da qui)
let camState = { state: 'disconnected', detail: '' };
let view = { mode: 'full', side: 'right', alwaysOnTop: false };

// vista compatta già all'apertura (?view=compact): niente Regia schiacciata a 260 px nel primo istante
if (new URLSearchParams(window.location.search).get('view') === 'compact') document.body.classList.add('compact');

// ---------------------------------------------------------------------------
// Utilità

const lastToastAt = new Map();
const TOAST_ICON = { ok: 'check', err: 'fail', warn: 'warnDot' };

function toast(msg, kind = 'info', ms = 3800) {
  // lo stesso messaggio non si ripete prima di 10 secondi (es. errori di rete ricorrenti)
  const now = Date.now();
  if (now - (lastToastAt.get(msg) || 0) < 10000) return;
  lastToastAt.set(msg, now);
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${TOAST_ICON[kind] ? `<span class="ti">${ICONS[TOAST_ICON[kind]]}</span>` : ''}<span class="tt"></span>`;
  el.querySelector('.tt').textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function errMsg(e) {
  return String(e && e.message ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) || `p${Date.now()}${Math.random().toString(16).slice(2)}`;
}

const pageOpen = () => document.body.classList.contains('settings-open') || document.body.classList.contains('wizard-open');
function anyDialogOpen() {
  return $$('dialog').some((d) => d.open);
}

// controlli segmentati (pulsanti con data-v)
function segSet(el, v) {
  el.dataset.value = v;
  el.querySelectorAll('button[data-v]').forEach((b) => b.classList.toggle('on', b.dataset.v === String(v)));
}
const segGet = (el) => el.dataset.value;
function segBind(el, onChange) {
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b || b.disabled) return;
    segSet(el, b.dataset.v);
    if (onChange) onChange(b.dataset.v);
  });
}

// Conferma con icona (eliminare, nuova chiave, importare…): true se si conferma
function confirmDlg({
  icon = 'question', title, text, ok, danger = false,
}) {
  return new Promise((resolve) => {
    const dlg = $('#dlgConfirm');
    const ico = $('#cfIcon');
    ico.className = `cf-icon ${icon}`;
    ico.innerHTML = ICONS[{ delete: 'trash', key: 'key', import: 'importIcon' }[icon] || 'question'];
    $('#cfTitle').textContent = title;
    $('#cfText').textContent = text;
    const okBtn = $('#cfOk');
    okBtn.textContent = ok;
    okBtn.classList.toggle('btn-danger', danger);
    dlg.returnValue = '';
    dlg.onclose = () => resolve(dlg.returnValue === 'ok');
    dlg.showModal();
    $('#cfCancel').focus();
  });
}
$('#cfOk').addEventListener('click', () => $('#dlgConfirm').close('ok'));
$('#cfCancel').addEventListener('click', () => $('#dlgConfirm').close('cancel'));

// ---------------------------------------------------------------------------
// Barra del titolo

$$('.tb-controls [data-win]').forEach((b) => b.addEventListener('click', () => ptz.winControl(b.dataset.win)));
function renderMaximized(on) {
  const b = $('#tbMax');
  b.innerHTML = on ? ICONS.restore : ICONS.maximize;
  b.title = on ? t('win.restore') : t('win.maximize');
  b.setAttribute('aria-label', b.title);
}
function setWindowTitle(text) {
  $('#tbTitle').textContent = text;
  document.title = text;
}

// ---------------------------------------------------------------------------
// Stato camera e avviso «non risponde»

let camFirstAttempt = true; // primo tentativo di collegamento: niente avviso finché non fallisce
let offlineTimer = null;

function camStateText() {
  const c = settings.camera;
  if (!c.host) return t('cam.openSettings');
  return {
    connected: t('cam.connected'),
    connecting: t('cam.connecting'),
    error: t('cam.noReply'),
    disconnected: t('cam.noReply'),
  }[camState.state] || '';
}

function renderCamStatus() {
  const c = settings.camera;
  const lvl = camLevel(camState, c.host);
  const pill = $('#camStatus');
  pill.className = `status-pill ${lvl}`;
  pill.querySelector('.dot').className = `dot ${lvl}`;
  $('#camLabel').textContent = c.host ? `${cameraName(c)} · ${c.host}` : t('top.notConfigured');
  const stateTxt = camStateText();
  $('#camDetail').textContent = document.body.classList.contains('editing') && camState.state === 'connected' && c.name
    ? `${PROTOCOL_DESC[c.protocol] || ''} · ${stateTxt}` : stateTxt;
  pill.title = camState.detail || '';
  // vista compatta
  $('#cDot').className = `dot ${lvl}`;
  $('#cName').textContent = c.host ? (c.name || c.host) : t('top.notConfigured');
  $('#cName').title = c.host ? `${cameraName(c)} · ${c.host} — ${stateTxt}` : '';
  // impostazioni
  const badge = $('#sCamBadge');
  badge.className = `state-badge ${{ ok: 'ok', wait: 'wait', bad: 'bad', off: 'off' }[lvl]}`;
  badge.textContent = c.host ? {
    ok: t('cam.badgeOk'), wait: t('cam.badgeWait'), bad: t('cam.badgeBad'), off: '',
  }[lvl] : t('cam.badgeOff');
  updateOffline();
}

function showOffline(on) {
  $('#offlineBanner').hidden = !on;
  document.body.classList.toggle('offline', !!on);
  renderPreviewState();
}

function updateOffline() {
  const host = settings.camera.host;
  const st = camState.state;
  if (!host || st === 'connected') {
    if (st === 'connected') camFirstAttempt = false;
    clearTimeout(offlineTimer);
    offlineTimer = null;
    if (!$('#offlineBanner').hidden) showOffline(false);
    return;
  }
  if (st === 'error' || st === 'disconnected') camFirstAttempt = false;
  if (st === 'connecting' && camFirstAttempt) return;
  if (!offlineTimer && $('#offlineBanner').hidden) {
    offlineTimer = setTimeout(() => {
      offlineTimer = null;
      if (camState.state !== 'connected' && settings.camera.host) showOffline(true);
    }, 3000);
  }
}

$('#btnRetry').addEventListener('click', async () => {
  const b = $('#btnRetry');
  b.disabled = true;
  b.textContent = t('off.retrying');
  try { await ptz.reconnect(); } catch (_) { /* lo stato arriva comunque */ }
  setTimeout(() => { b.disabled = false; b.textContent = t('off.retry'); }, 2500);
});
$('#btnCamSettings').addEventListener('click', () => openSettings('camera'));

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

// riporta a riposo joystick, pulsanti e tasti (senza mandare comandi)
function resetManualUi() {
  clearTimeout(moveTimer);
  moveTarget = { x: 0, y: 0 };
  moveActive = false;
  zoomActive = false;
  focusActive = false;
  keys.clear();
  joyPointer = null;
  $$('.hold.pressed').forEach((b) => b.classList.remove('pressed'));
  resetKnob();
}

$('#btnStopPage').addEventListener('click', () => stopAll());

function stopAll() {
  resetManualUi();
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
  const R = r.width / 2 - knob.offsetWidth / 2 + 1; // raggio utile: bordo meno metà della manopola
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
  segSet($('#focusSeg'), on ? '1' : '0');
}
$$('#focusSeg button').forEach((b) => { b.dataset.v = b.dataset.af; });
segBind($('#focusSeg'), (v) => ptz.cmd('focusAuto', v === '1'));

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

function goHome() {
  activeId = null;
  renderPresets();
  ptz.cmd('home');
}
$('#btnOnePush').addEventListener('click', () => ptz.cmd('onePush'));
$('#btnHome').addEventListener('click', goHome);
$('#btnStop').addEventListener('click', () => stopAll());
$('#cHome').addEventListener('click', goHome);
$('#cStop').addEventListener('click', () => stopAll());

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
  if (anyDialogOpen() || pageOpen() || isTyping()) return;
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
  let tm = null;
  input.addEventListener('input', () => {
    settings[key] = Number(input.value);
    out.textContent = `${Math.round(settings[key] * 100)}%`;
    clearTimeout(tm);
    tm = setTimeout(() => ptz.saveSettings({ [key]: settings[key] }), 400);
  });
}

// Tasti rapidi
$('#btnKeys').addEventListener('click', () => {
  $('#dlgKeys').showModal();
  if (document.activeElement) document.activeElement.blur();
});
$('#keysDone').addEventListener('click', () => $('#dlgKeys').close());
$('#keysToSettings').addEventListener('click', () => {
  $('#dlgKeys').close();
  openSettings('external');
});

// ---------------------------------------------------------------------------
// Anteprima

const canvas = $('#video');
const ctx = canvas.getContext('2d');
const wzCanvas = $('#wzCanvas');
const wzCtx = wzCanvas.getContext('2d');
const usbVideo = $('#usbVideo');
let lastFrame = null; // ImageBitmap o elemento video
let usbStream = null;
let usbRaf = null;
let previewState = { state: 'off', detail: '' };

function fitCanvas(cv) {
  const r = cv.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * dpr));
  const h = Math.max(1, Math.round(r.height * dpr));
  if (cv.width !== w || cv.height !== h) {
    cv.width = w;
    cv.height = h;
    if (lastFrame) draw(lastFrame);
  }
}
new ResizeObserver(() => fitCanvas(canvas)).observe($('#videoWrap'));
new ResizeObserver(() => fitCanvas(wzCanvas)).observe($('#wzPreview'));

function sourceSize(src) {
  return src instanceof HTMLVideoElement ? [src.videoWidth, src.videoHeight] : [src.width, src.height];
}

function drawOn(cv, g, src, withGrid) {
  const [sw, sh] = sourceSize(src);
  if (!sw || !sh || !cv.width || !cv.height) return;
  const W = cv.width;
  const H = cv.height;
  const s = Math.min(W / sw, H / sh);
  const dw = sw * s;
  const dh = sh * s;
  const dx = (W - dw) / 2;
  const dy = (H - dh) / 2;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#000000';
  g.fillRect(0, 0, W, H);
  if (settings.preview.rotate180) {
    g.translate(W, H);
    g.rotate(Math.PI);
  }
  g.drawImage(src, dx, dy, dw, dh);
  g.setTransform(1, 0, 0, 1, 0, 0);
  if (withGrid) {
    const dpr = window.devicePixelRatio || 1;
    g.strokeStyle = 'rgba(255,255,255,0.45)';
    g.lineWidth = Math.max(1, dpr);
    g.beginPath();
    for (let i = 1; i < 3; i++) {
      g.moveTo(dx + (dw * i) / 3, dy); g.lineTo(dx + (dw * i) / 3, dy + dh);
      g.moveTo(dx, dy + (dh * i) / 3); g.lineTo(dx + dw, dy + (dh * i) / 3);
    }
    g.stroke();
    if (!document.body.classList.contains('editing')) {
      // nell'editor il mirino centrale è già disegnato sopra l'anteprima
      g.beginPath();
      const cx = dx + dw / 2;
      const cy = dy + dh / 2;
      const k = 10 * dpr;
      g.moveTo(cx - k, cy); g.lineTo(cx + k, cy);
      g.moveTo(cx, cy - k); g.lineTo(cx, cy + k);
      g.stroke();
    }
  }
}

function draw(src) {
  drawOn(canvas, ctx, src, settings.preview.grid);
  if (wz.step === 2 && document.body.classList.contains('wizard-open')) drawOn(wzCanvas, wzCtx, src, false);
}

function setPreviewMsg(title, sub = '', cls = '') {
  const el = $('#previewMsg');
  el.classList.toggle('hidden', !title);
  el.classList.toggle('connecting', cls === 'connecting');
  $('#previewTitle').textContent = title || '';
  $('#previewSub').textContent = sub || '';
}

const camOffline = () => !!settings.camera.host && !$('#offlineBanner').hidden;

function renderPreviewState() {
  if (!settings) return;
  const src = settings.preview.source;
  const live = previewState.state === 'live';
  $('#liveBadge').classList.toggle('on', live);
  $('#videoWrap').classList.toggle('live', live);
  canvas.classList.toggle('off', !live);
  if (src === 'none') setPreviewMsg(t('preview.off'), t('preview.offSub'));
  else if (live) setPreviewMsg('');
  else if (src === 'rtsp' && !settings.preview.rtspUrl) setPreviewMsg(t('preview.notConfigured'), t('preview.needUrl'));
  else if (camOffline()) setPreviewMsg(t('preview.noSignal'), t('preview.noSignalSub'));
  else if (previewState.state === 'connecting') setPreviewMsg(t('preview.connecting'), '', 'connecting');
  else if (previewState.state === 'error') setPreviewMsg(t('preview.noSignal'), t('preview.error', { detail: previewState.detail }));
  else setPreviewMsg(t('preview.noSignal'));
  renderVideoBadge();
  renderWzVideo();
}

function renderVideoBadge() {
  const b = $('#sVideoBadge');
  const src = settings.preview.source;
  let cls = 'off';
  let txt = t('pv.badgeOff');
  if (src !== 'none') {
    if (previewState.state === 'live') { cls = 'ok'; txt = t('pv.badgeLive'); } else if (previewState.state === 'connecting') { cls = 'wait'; txt = t('pv.badgeWait'); } else if (previewState.state === 'error') { cls = 'bad'; txt = t('pv.badgeBad'); } else { txt = t('pv.badgeIdle'); }
  }
  b.className = `state-badge ${cls}`;
  b.textContent = txt;
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
    previewState = { state: 'error', detail: t('preview.usbError', { detail: e.message }) };
    renderPreviewState();
  }
}

function stopUsb() {
  cancelAnimationFrame(usbRaf);
  if (usbStream) usbStream.getTracks().forEach((tr) => tr.stop());
  usbStream = null;
  usbVideo.srcObject = null;
}

function applyPreviewSource() {
  // nelle viste ridotte l'anteprima non si vede: anche la camera USB si ferma
  if (settings.preview.source === 'usb' && view.mode === 'full') {
    if (!usbStream) startUsb();
  } else {
    stopUsb();
    if (lastFrame instanceof HTMLVideoElement) lastFrame = null;
    if (settings.preview.source !== 'rtsp') previewState = { state: 'off', detail: '' };
    renderPreviewState();
  }
}

function captureThumb() {
  if (!lastFrame || previewState.state !== 'live') return null; // niente fotogrammi vecchi
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
  return ptz.savePresets(presets).catch((e) => toast(t('presets.saveFailed', { error: errMsg(e) }), 'err'));
}

function renderActiveBadge() {
  const i = presets.findIndex((p) => p.id === activeId);
  const b = $('#activeBadge');
  b.classList.toggle('on', i >= 0);
  b.textContent = i >= 0 ? `${presetNum(i)} · ${presets[i].name}` : '';
}

function renderPresets() {
  const grid = $('#presetGrid');
  grid.innerHTML = '';
  renderActiveBadge();
  renderCompactList();
  if (!presets.length) {
    grid.innerHTML = `<div class="empty-state">
      <span class="thumb placeholder es-icon"><span class="ph-glyph">${ICONS.camera}</span><span class="num-big">1</span></span>
      <div class="es-text"><b>${esc(t('presets.emptyTitle'))}</b><span>${esc(t('presets.emptyText'))}</span></div>
      <div class="es-action"><button class="btn-primary" id="btnFirstPreset">${esc(t('presets.emptyAction'))}</button>
      <small>${esc(t('presets.emptyHint'))}</small></div></div>`;
    $('#btnFirstPreset').addEventListener('click', () => openEditor());
    return;
  }
  presets.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = `preset${p.id === activeId ? ' active' : ''}${p.id === recallingId ? ' busy' : ''}`;
    b.dataset.id = p.id;
    b.title = i < 10 ? t('presets.withKey', { text: p.name, key: HOTKEYS[i] }) : p.name;
    b.innerHTML = `<span class="tw">${thumbHtml(p, i)}`
      + `<span class="onair">${esc(t('presets.onAir'))}</span><span class="arriving">${esc(t('presets.arriving'))}</span>`
      + `${p.slot != null ? `<span class="slot-tag">${esc(t('presets.slot', { n: p.slot }))}</span>` : ''}</span>`
      + `<span class="meta"><span class="name">${esc(p.name)}</span>`
      + `<span class="edit" role="button" title="${esc(t('presets.edit'))}" aria-label="${esc(t('presets.edit'))}">${ICONS.pencil}</span></span>`;
    b.addEventListener('click', (e) => {
      if (e.target.closest('.edit')) { openEditor(p.id); return; }
      recall(p);
    });
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); openEditor(p.id); });
    grid.appendChild(b);
  });
}

function renderCompactList() {
  const box = $('#compactList');
  if (!presets.length) {
    box.innerHTML = `<div class="p-empty">${esc(t('presets.emptyShort'))}</div>`;
    return;
  }
  box.innerHTML = presets.map((p, i) => `<button class="p-row${p.id === activeId ? ' active' : ''}${p.id === recallingId ? ' busy' : ''}" data-id="${esc(p.id)}" title="${esc(p.name)}">`
    + `${thumbHtml(p, i, { big: false })}<span class="p-name">${esc(p.name)}</span></button>`).join('');
}
$('#compactList').addEventListener('click', (e) => {
  const row = e.target.closest('.p-row');
  if (!row) return;
  const p = presets.find((x) => x.id === row.dataset.id);
  if (p) recall(p);
});

// il richiamo passa dal centro operativo del programma, come quelli da OBS e Stream Deck
async function recall(p, opts) {
  if (!p) return;
  stopManualOnly();
  recallingId = p.id;
  if (!editor) renderPresets();
  try {
    const r = await ptz.recallPreset(p.id, settings.recallSpeed, opts);
    if (!r || !r.id) return; // superato da STOP o da un altro comando
    activeId = p.id;
    if (p.pos && p.pos.focusAuto !== undefined) setAfUi(p.pos.focusAuto !== false);
  } catch (e) {
    toast(t('presets.recallError', { name: p.name, error: errMsg(e) }), 'err');
  } finally {
    if (recallingId === p.id) recallingId = null;
    if (!editor) renderPresets();
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
  throw new Error(t('presets.noFreeSlot'));
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
  if (/nessuna risposta|posizione|non comunica|inattesa|no reply|position|unexpected/i.test(m)) {
    return t('presets.captureHint', { error: m });
  }
  return m;
}

// ---------------------------------------------------------------------------
// Editor delle inquadrature: la Regia diventa "modifica", con l'anteprima incorniciata di blu.
// Si posiziona la testa e con «Salva» si memorizzano le coordinate (pan, tilt, zoom, fuoco)
// lette dalla camera, più una miniatura.

let editor = null; // { mode: 'new' | 'edit', id }

function editorPreset() {
  return editor && editor.id ? presets.find((x) => x.id === editor.id) : null;
}

function renderEditor() {
  const p = editorPreset();
  const idx = p ? presets.indexOf(p) : -1;
  $('#edTitle').textContent = p ? t('ed.editTitle', { name: p.name }) : t('ed.new');
  $('#edSave').textContent = p ? t('ed.saveChanges') : t('ed.save');
  $('#edExisting').style.display = p ? '' : 'none';
  $('#edLeft').disabled = idx <= 0;
  $('#edRight').disabled = idx < 0 || idx >= presets.length - 1;
  const keyIdx = p ? idx : presets.length;
  $('#edKey').textContent = keyIdx >= 0 && keyIdx < 10 ? t('presets.key', { key: HOTKEYS[keyIdx] }) : '';
  $('#edHint').textContent = p ? t('ed.hintEdit') : t('ed.hintNew');
  $('#editNote').textContent = settings.presetMode === 'slot' ? t('ed.noteSlot') : t('ed.noteApp');
}

async function openEditor(id = null) {
  if (editor) return;
  const p = id ? presets.find((x) => x.id === id) : null;
  if (id && !p) return;
  stopManualOnly();
  if (view.mode !== 'full') applyView(await ptz.setView('full'));
  editor = { mode: p ? 'edit' : 'new', id: p ? p.id : null };
  document.body.classList.add('editing');
  $('#edName').value = p ? p.name : t('presets.defaultName', { n: presets.length + 1 });
  renderEditor();
  renderCamStatus();
  if (lastFrame) draw(lastFrame);
  if (document.activeElement) document.activeElement.blur(); // le frecce muovono la camera
  if (camState.state !== 'connected') toast(t('ed.notConnected'), 'warn', 6000);
  // da qui i richiami esterni (OBS, Stream Deck, tasti) restano in attesa;
  // il richiamo dell'editor stesso passa comunque
  ptz.setEditing(true);
  if (p) await recall(p, { editor: true }); // si parte dalla posizione salvata, poi la si ritocca
  if (!editor) ptz.setEditing(false); // editor chiuso mentre la camera arrivava
}

async function closeEditor() {
  if (!editor) return;
  editor = null;
  ptz.setEditing(false);
  document.body.classList.remove('editing');
  renderCamStatus();
  renderPresets();
  if (lastFrame) draw(lastFrame);
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
  const name = $('#edName').value.trim() || (existing ? existing.name : t('presets.defaultName', { n: presets.length + 1 }));
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
  ptz.setActive(p.id); // la camera è su questa inquadratura: lo sanno anche OBS e successiva/precedente
  const idx = presets.indexOf(p);
  const msg = t(existing ? 'presets.updated' : 'presets.saved', { name: p.name });
  toast(idx < 10 ? t('presets.withKey', { text: msg, key: HOTKEYS[idx] }) : msg, 'ok');
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
  const ok = await confirmDlg({
    icon: 'delete', title: t('presets.deleteTitle', { name: p.name }), text: t('presets.deleteText'), ok: t('common.delete'), danger: true,
  });
  if (!ok || !editorPreset()) return;
  presets = presets.filter((x) => x.id !== p.id);
  if (activeId === p.id) activeId = null;
  await persist();
  await closeEditor();
  toast(t('presets.deleted', { name: p.name }), 'ok');
});

// ---------------------------------------------------------------------------
// Viste: completa, compatta (colonna sul bordo), laterale (linguetta sul bordo)

function applyView(v) {
  if (!v) return;
  const prevMode = view.mode;
  view = v;
  settings.alwaysOnTop = !!v.alwaysOnTop;
  document.body.classList.toggle('compact', v.mode === 'compact');
  $$('#viewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.view === v.mode));
  $$('#sideSeg button').forEach((b) => b.classList.toggle('on', b.dataset.side === v.side));
  for (const id of ['#btnPin', '#cPin']) $(id).setAttribute('aria-pressed', v.alwaysOnTop ? 'true' : 'false');
  const other = v.side === 'left' ? 'right' : 'left';
  const swapTitle = t(other === 'left' ? 'v.toLeft' : 'v.toRight');
  $('#cSwap').title = swapTitle;
  $('#cSwap').setAttribute('aria-label', swapTitle);
  // in Compatta la finestra resta sempre in primo piano: la puntina è accesa e bloccata
  const cPinOn = v.mode === 'compact' || v.alwaysOnTop;
  $('#cPin').setAttribute('aria-pressed', cPinOn ? 'true' : 'false');
  $('#cPin').disabled = v.mode === 'compact';
  if (prevMode !== v.mode) {
    if (v.mode !== 'full') stopManualOnly(); // manda lo stop se un movimento manuale era in corso
    applyPreviewSource();
  }
}

async function setViewMode(mode) {
  if (editor && mode !== 'full') return;
  // un tasto o il joystick tenuti premuti non devono lasciare la camera in movimento
  // quando la finestra cambia o sparisce (vista Laterale)
  if (mode !== 'full') stopManualOnly();
  applyView(await ptz.setView(mode));
}

$('#viewSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b) setViewMode(b.dataset.view);
});
$('#sideSeg').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-side]');
  if (b) applyView(await ptz.setSide(b.dataset.side));
});
const togglePin = async () => applyView(await ptz.setOnTop(!view.alwaysOnTop));
$('#btnPin').addEventListener('click', togglePin);
$('#cPin').addEventListener('click', togglePin);
$('#cSwap').addEventListener('click', async () => applyView(await ptz.setSide(view.side === 'left' ? 'right' : 'left')));
$('#cFull').addEventListener('click', () => setViewMode('full'));
$('#cOpen').addEventListener('click', () => setViewMode('full'));

// ---------------------------------------------------------------------------
// Rilevamento della camera (impostazioni e primo avvio)

// sceglie il protocollo dai risultati: prima chi legge la posizione
function analyzeDetection(r) {
  const order = ['udp', 'tcp', 'sony'];
  const proto = { udp: 'visca-udp', tcp: 'visca-tcp', sony: 'visca-sony' };
  const visca = order.map((m) => r.visca.find((v) => v.mode === m)).filter(Boolean);
  const best = visca.find((v) => v.ok && v.position);
  const anyVisca = visca.find((v) => v.ok);
  let chosen = null;
  let needSlot = false;
  if (best) chosen = { protocol: proto[best.mode], port: best.port };
  else if (r.onvif.ok && r.onvif.ptz && r.onvif.position) chosen = { protocol: 'onvif', port: r.onvif.port };
  else if (anyVisca) { chosen = { protocol: proto[anyVisca.mode], port: anyVisca.port }; needSlot = true; }
  else if (r.onvif.ok && r.onvif.ptz) { chosen = { protocol: 'onvif', port: r.onvif.port }; needSlot = true; }
  const onvifAuth = !chosen && r.onvif.ok && r.onvif.error && /author|autoriz|401/i.test(r.onvif.error);
  const line = (html, cls = '') => `<div class="line ${cls}">${html}</div>`;
  const rows = [];
  for (const v of r.visca) {
    const st = v.ok ? `${t('d.replies')}${v.position ? t('d.position') : t('d.noPosition')}` : t('d.noReply');
    rows.push(line(`${esc(v.label)}: ${esc(st)}`, v.ok ? 'ok' : 'bad'));
  }
  if (r.onvif.ok) {
    const det = r.onvif.error ? t('d.onvifErr', { error: r.onvif.error }) : `${r.onvif.ptz ? t('d.onvifPtz') : t('d.onvifNoPtz')}${r.onvif.position ? t('d.onvifPos') : ''}`;
    rows.push(line(esc(t('d.onvif', { port: r.onvif.port, detail: det })), r.onvif.ptz ? 'ok' : 'bad'));
  } else {
    rows.push(line(esc(t('d.onvifNone')), 'bad'));
  }
  if (r.http.ok) rows.push(line(`${esc(t('d.web', { title: r.http.title || t('d.webPresent') }))}${r.http.server ? ` (${esc(r.http.server)})` : ''}`, 'bad'));
  if (chosen) rows.unshift(line(`<b>${esc(t('d.set', { protocol: PROTOCOL_LABEL[chosen.protocol], port: chosen.port }))}</b>${needSlot ? esc(t('d.setSlot')) : ''}`, 'ok'));
  return {
    chosen, needSlot, onvifAuth, anyReply: !!(r.onvif.ok || r.http.ok || anyVisca), rows,
  };
}

function deviceTags(d) {
  return [d.onvif ? 'ONVIF' : null, d.rtsp ? t('d.tagRtsp') : null, d.http ? t('d.tagWeb') : null].filter(Boolean).join(' · ');
}
const deviceName = (d) => [d.name, d.hardware].filter(Boolean).join(' ').trim();
const discoveredNames = new Map(); // ip -> nome letto dalla rete

function deviceHtml(d, { selected = false, recommended = false } = {}) {
  const name = deviceName(d);
  return `<button type="button" class="device${selected ? ' sel' : ''}" data-ip="${esc(d.ip)}">`
    + `<span class="dev-thumb">${ICONS.camera}</span>`
    + `<span class="dev-text"><b>${esc(name || t('w.deviceGeneric'))}</b><span>${esc([d.ip, deviceTags(d)].filter(Boolean).join(' · '))}</span></span>`
    + `${recommended ? `<span class="tag ok">${esc(t('w.recommended'))}</span>` : ''}</button>`;
}

// ---------------------------------------------------------------------------
// Impostazioni: pagina a tutta finestra con le sezioni a sinistra

let settingsSnapshot = '';
let detectedProtocol = null;

// linea sopra Annulla/Salva solo quando sotto c'è altro da scorrere
function updateFootLine() {
  const sc = $('#sScroll');
  $('.s-foot').classList.toggle('scrolled', sc.scrollTop + sc.clientHeight < sc.scrollHeight - 2);
}

function showSection(sec) {
  $$('.s-link').forEach((b) => b.classList.toggle('on', b.dataset.sec === sec));
  $$('.s-panel').forEach((p) => p.classList.toggle('on', p.dataset.panel === sec));
  $('#sScroll').scrollTop = 0;
  updateFootLine();
}
$$('.s-link').forEach((b) => b.addEventListener('click', () => showSection(b.dataset.sec)));
$('#sScroll').addEventListener('scroll', updateFootLine);
new ResizeObserver(updateFootLine).observe($('#sScroll'));

function setLine(iconEl, textEl, kind, text) {
  iconEl.innerHTML = { ok: ICONS.check, bad: ICONS.fail, warn: ICONS.warnDot, busy: ICONS.spinner }[kind] || '';
  textEl.textContent = text || '';
}

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
  segSet($('#sSource'), p.source);
  $('#sWidth').value = String(p.width || 960);
  $('#sRtsp').value = p.rtspUrl || '';
  $('#sRotate').checked = !!p.rotate180;
  $('#sGrid').checked = !!p.grid;
  $(settings.presetMode === 'slot' ? '#sModeSlot' : '#sModeApp').checked = true;
  $('#sSlotBase').value = settings.slotBase;
  $('#sGlobal').checked = !!settings.globalHotkeys;
  $('#discoverOut').innerHTML = '';
  $('#detectDetails').hidden = true;
  $('#foundList').hidden = true;
  $('#foundList').innerHTML = '';
  detectedProtocol = null;
  setLine($('#detectIcon'), $('#detectText'), '', t('d.hint'));
  $('#btnDetect').textContent = t('s.detect');
  $('#rtspOut').innerHTML = '';
  setLine($('#rtspIcon'), $('#rtspText'), '', t('r.hint'));
  $('#sLanguage').value = settings.language || 'auto';
  $('#xEnable').checked = !!settings.api.enabled;
  $('#xPort').value = settings.api.port || 8765;
  $('#xLan').checked = !!settings.api.lan;
  $('#xLanWarn').hidden = !settings.api.lan;
  $('#sUpdates').checked = !settings.updates || settings.updates.check !== false;
  segSet($('#sSide'), view.side);
  $('#sOnTop').checked = !!view.alwaysOnTop;
  $('#sDataDir').textContent = info.dataDir;
  $('#gDataDir').textContent = info.dataDir;
  $('#gAccount').textContent = info.user;
  $('#sPresetsBadge').textContent = t('s.presetsBadge', { user: info.user, n: presets.length });
  $('#aboutName').textContent = t('g.appVersion', { version: info.version });
  $('#updVersion').textContent = t('g.version', { version: info.version });
  $('#btnProject').hidden = !info.hasProject;
  renderUpdate(updateState);
  refreshApiInfo();
  updateFormVisibility();
  renderCamStatus();
  renderVideoBadge();
  if (p.source === 'usb') listUsbDevices(p.usbDeviceId);
}

function updateFormVisibility() {
  const src = segGet($('#sSource'));
  $$('.rtsp-only').forEach((el) => { el.hidden = src !== 'rtsp'; });
  $$('.usb-only').forEach((el) => { el.hidden = src !== 'usb'; });
  const slot = $('#sModeSlot').checked;
  $('#modeSlotRow').classList.toggle('sel', slot);
  $('#modeAppRow').classList.toggle('sel', !slot);
  $('#sSlotBase').disabled = !slot;
  const onvif = $('#sProtocol').value === 'onvif';
  $('#sAddress').disabled = onvif;
  $('#rowAddress').style.opacity = onvif ? '.55' : '';
  $('#sDetected').hidden = !detectedProtocol || $('#sProtocol').value !== detectedProtocol;
}

segBind($('#sSource'), (v) => {
  updateFormVisibility();
  if (v === 'usb') listUsbDevices(settings.preview.usbDeviceId);
});
$$('input[name="presetMode"]').forEach((r) => r.addEventListener('change', () => {
  updateFormVisibility();
  if ($('#sModeSlot').checked) toast(t('s.slotWarn', { n: $('#sSlotBase').value }), 'warn', 7000);
}));
$('#sProtocol').addEventListener('change', () => {
  $('#sPort').value = DEFAULT_PORTS[$('#sProtocol').value];
  updateFormVisibility();
});
segBind($('#sSide'));

async function listUsbDevices(selected) {
  const sel = $('#sUsb');
  try {
    // serve un primo accesso per leggere i nomi dei dispositivi
    const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }).catch(() => null);
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    if (tmp) tmp.getTracks().forEach((tr) => tr.stop());
    sel.innerHTML = devs.map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || t('s.usbCamera', { n: i + 1 }))}</option>`).join('')
      || `<option value="">${esc(t('s.usbNone'))}</option>`;
    if (selected) sel.value = selected;
  } catch (e) {
    sel.innerHTML = `<option value="">${esc(e.message)}</option>`;
  }
}

function formCamera() {
  const host = $('#sHost').value.trim();
  let name = '';
  if (discoveredNames.has(host)) name = discoveredNames.get(host);
  else if (host === settings.camera.host) name = settings.camera.name || '';
  return {
    host,
    name,
    protocol: $('#sProtocol').value,
    port: Number($('#sPort').value) || DEFAULT_PORTS[$('#sProtocol').value],
    address: clamp(Number($('#sAddress').value) || 1, 1, 7),
    user: $('#sUser').value.trim(),
    pass: $('#sPass').value,
    invertPan: $('#sInvertPan').checked,
    invertTilt: $('#sInvertTilt').checked,
  };
}

function formPartial() {
  return {
    camera: formCamera(),
    preview: {
      source: segGet($('#sSource')),
      rtspUrl: $('#sRtsp').value.trim(),
      usbDeviceId: $('#sUsb').value || settings.preview.usbDeviceId || '',
      width: Number($('#sWidth').value) || 960,
      rotate180: $('#sRotate').checked,
      grid: $('#sGrid').checked,
    },
    presetMode: $('#sModeSlot').checked ? 'slot' : 'app',
    slotBase: clamp(Number($('#sSlotBase').value) || 0, 0, 240),
    globalHotkeys: $('#sGlobal').checked,
    language: $('#sLanguage').value,
    api: {
      enabled: $('#xEnable').checked,
      port: clamp(Number($('#xPort').value) || 8765, 1024, 65535),
      lan: $('#xLan').checked,
    },
    updates: { check: $('#sUpdates').checked },
    alwaysOnTop: $('#sOnTop').checked,
    view: { side: segGet($('#sSide')) },
  };
}

// confronto per «uscire senza salvare?» (il dispositivo USB si legge in ritardo: non conta)
function formSignature() {
  const f = formPartial();
  delete f.preview.usbDeviceId;
  return JSON.stringify(f);
}

function openSettings(section = 'camera') {
  if (anyDialogOpen()) $$('dialog').forEach((d) => { if (d.open) d.close(); });
  if (moveActive || zoomActive || focusActive || keys.size) stopAll();
  fillSettingsForm();
  showSection(section);
  document.body.classList.add('settings-open');
  setWindowTitle(t('s.windowTitle'));
  settingsSnapshot = formSignature();
  requestAnimationFrame(updateFootLine);
}

function closeSettings() {
  stopCapture();
  document.body.classList.remove('settings-open');
  setWindowTitle(t('app.name'));
}

async function cancelSettings() {
  if (formSignature() !== settingsSnapshot) {
    const ok = await confirmDlg({
      icon: 'question', title: t('s.discardTitle'), text: t('s.discardText'), ok: t('s.discard'), danger: true,
    });
    if (!ok) return;
  }
  closeSettings();
}

async function saveSettingsPage() {
  const partial = formPartial();
  const langChanged = partial.language !== (settings.language || 'auto');
  const camNow = Object.fromEntries(Object.keys(partial.camera).map((k) => [k, k === 'name' ? (settings.camera.name || '') : settings.camera[k]]));
  const camChanged = JSON.stringify(partial.camera) !== JSON.stringify(camNow);
  const prevSource = `${settings.preview.source}|${settings.preview.usbDeviceId}`;
  const btn = $('#btnSaveSettings');
  btn.disabled = true;
  try {
    const r = await ptz.saveSettings(partial);
    settings = r.settings;
    if (r.hotkeys && !r.hotkeys.ok) {
      toast(t('s.hotkeysBusy', { keys: r.hotkeys.failed.join(', ') }), 'warn', 6000);
    }
    if (camChanged) { camFirstAttempt = true; showOffline(false); }
    if (`${settings.preview.source}|${settings.preview.usbDeviceId}` !== prevSource) applyPreviewSource();
    closeSettings();
    renderCamStatus();
    renderPreviewState();
    renderEditor();
    if (lastFrame) draw(lastFrame);
    if (langChanged) { window.location.reload(); return; }
    toast(t('s.saved'), 'ok');
  } catch (e) {
    toast(t('s.notSaved', { error: errMsg(e) }), 'err');
  } finally {
    btn.disabled = false;
  }
}

$('#btnSettings').addEventListener('click', () => openSettings('camera'));
$('#btnSaveSettings').addEventListener('click', saveSettingsPage);
$('#btnCancelSettings').addEventListener('click', cancelSettings);
$('#btnCloseSettings').addEventListener('click', cancelSettings);
$('#btnBackRegia').addEventListener('click', cancelSettings);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('settings-open') && !anyDialogOpen() && !capture) {
    e.preventDefault();
    cancelSettings();
  }
});

// ---- telecamera: ricerca in rete e rilevamento del protocollo

$('#btnDiscover').addEventListener('click', async () => {
  const btn = $('#btnDiscover');
  const box = $('#foundList');
  btn.disabled = true;
  setLine($('#detectIcon'), $('#detectText'), 'busy', t('d.searching'));
  box.hidden = true;
  try {
    const r = await ptz.discover();
    const nets = r.networks.map((n) => `${n.address}`).join(', ') || t('d.netsNone');
    if (!r.devices.length) {
      setLine($('#detectIcon'), $('#detectText'), 'bad', t('d.none', { nets }));
      return;
    }
    for (const d of r.devices) if (deviceName(d)) discoveredNames.set(d.ip, deviceName(d));
    box.innerHTML = r.devices.map((d) => deviceHtml(d, { selected: d.ip === $('#sHost').value.trim() })).join('');
    box.hidden = false;
    setLine($('#detectIcon'), $('#detectText'), 'ok', t('d.pick', { nets }));
  } catch (e) {
    setLine($('#detectIcon'), $('#detectText'), 'bad', t('d.searchError', { error: errMsg(e) }));
  } finally {
    btn.disabled = false;
  }
});
$('#foundList').addEventListener('click', (e) => {
  const el = e.target.closest('.device');
  if (!el) return;
  $('#sHost').value = el.dataset.ip;
  $$('#foundList .device').forEach((d) => d.classList.toggle('sel', d === el));
  detectProtocol();
});

async function detectProtocol() {
  const c = formCamera();
  if (!c.host) { toast(t('s.needIp'), 'warn'); return; }
  const btn = $('#btnDetect');
  btn.disabled = true;
  setLine($('#detectIcon'), $('#detectText'), 'busy', t('d.checking', { host: c.host }));
  try {
    const r = await ptz.detectProtocols({ host: c.host, user: c.user, pass: c.pass, address: c.address });
    const a = analyzeDetection(r);
    $('#discoverOut').innerHTML = a.rows.join('');
    $('#detectDetails').hidden = false;
    if (a.chosen) {
      $('#sProtocol').value = a.chosen.protocol;
      $('#sPort').value = a.chosen.port;
      detectedProtocol = a.chosen.protocol;
      if (a.needSlot) $('#sModeSlot').checked = true;
      setLine($('#detectIcon'), $('#detectText'), a.needSlot ? 'warn' : 'ok', a.needSlot ? t('d.sumSlot') : t('d.sumOk'));
    } else if (a.onvifAuth) {
      detectedProtocol = null;
      setLine($('#detectIcon'), $('#detectText'), 'bad', t('d.onvifAuth'));
    } else {
      detectedProtocol = null;
      setLine($('#detectIcon'), $('#detectText'), 'bad', t('d.nothing'));
    }
    updateFormVisibility();
    btn.textContent = t('s.detectAgain');
    if (segGet($('#sSource')) === 'rtsp' && !$('#sRtsp').value && a.anyReply) findRtsp();
  } catch (e) {
    setLine($('#detectIcon'), $('#detectText'), 'bad', t('common.error', { error: errMsg(e) }));
  } finally {
    btn.disabled = false;
  }
}
$('#btnDetect').addEventListener('click', detectProtocol);

// ---- anteprima: ricerca e prova del flusso

async function findRtsp() {
  const out = $('#rtspOut');
  const c = formCamera();
  if (!c.host) { toast(t('s.needIp'), 'warn'); return; }
  const btn = $('#btnFindRtsp');
  btn.disabled = true;
  out.innerHTML = '';
  setLine($('#rtspIcon'), $('#rtspText'), 'busy', t('r.searching'));
  try {
    const onvifPort = c.protocol === 'onvif' ? c.port : 80;
    const r = await ptz.detectRtsp({ host: c.host, user: c.user, pass: c.pass, onvifPort });
    const ok = r.filter((x) => x.ok);
    if (!ok.length) {
      setLine($('#rtspIcon'), $('#rtspText'), 'bad', t('r.none'));
      out.innerHTML = r.map((x) => `<div class="line bad">${esc(x.display)} — ${esc(x.error || t('r.invalid'))}</div>`).join('');
      return;
    }
    $('#sRtsp').value = ok[0].url;
    setLine($('#rtspIcon'), $('#rtspText'), 'ok', `${t('r.found')} ${ok[0].display} (${ok[0].note}).${ok.length > 1 ? ` ${t('r.foundHint')}` : ''}`);
    if (ok.length > 1) {
      out.innerHTML = ok.map((x) => `<div class="line pick" data-url="${esc(x.url)}">${esc(x.display)} — ${esc(x.note)}</div>`).join('');
    }
  } catch (e) {
    setLine($('#rtspIcon'), $('#rtspText'), 'bad', t('common.error', { error: errMsg(e) }));
  } finally {
    btn.disabled = false;
  }
}
$('#btnFindRtsp').addEventListener('click', findRtsp);
$('#rtspOut').addEventListener('click', (e) => {
  const el = e.target.closest('.pick');
  if (el) $('#sRtsp').value = el.dataset.url;
});

$('#btnTestRtsp').addEventListener('click', async () => {
  const url = $('#sRtsp').value.trim();
  if (!url) return;
  const btn = $('#btnTestRtsp');
  btn.disabled = true;
  setLine($('#rtspIcon'), $('#rtspText'), 'busy', t('r.testing'));
  const r = await ptz.testUrl(url);
  btn.disabled = false;
  if (r.ok) setLine($('#rtspIcon'), $('#rtspText'), 'ok', t('r.works'));
  else setLine($('#rtspIcon'), $('#rtspText'), 'bad', t('r.fails', { error: r.error || t('cam.error') }));
});

// ---- inquadrature: esporta, importa, cartella dati

$('#btnExport').addEventListener('click', async () => {
  try {
    const f = await ptz.exportPresets(presets);
    if (f) toast(t('presets.exported', { n: presets.length }), 'ok');
  } catch (e) { toast(errMsg(e), 'err'); }
});

// Inquadratura da un file importato: si tengono solo campi del tipo giusto
// (un file preparato ad arte non deve poter alterare l'interfaccia, per esempio nascondere STOP)
const THUMB_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
function cleanPos(pos) {
  if (!pos || typeof pos !== 'object') return null;
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const raw = (o) => o && num(o.raw) && (o.digits === 4 || o.digits === 5) ? { raw: o.raw, digits: o.digits } : null;
  if (pos.kind === 'visca') {
    const pan = raw(pos.pan);
    const tilt = raw(pos.tilt);
    if (!pan || !tilt || !num(pos.zoom)) return null;
    return { kind: 'visca', pan, tilt, zoom: pos.zoom, focusAuto: pos.focusAuto !== false, focus: num(pos.focus) ? pos.focus : null };
  }
  if (pos.kind === 'onvif') {
    if (!num(pos.x) || !num(pos.y)) return null;
    return { kind: 'onvif', x: pos.x, y: pos.y, zoom: num(pos.zoom) ? pos.zoom : null };
  }
  return null;
}
function cleanImported(p) {
  if (!p || typeof p !== 'object') return null;
  const pos = cleanPos(p.pos);
  const slot = Number.isInteger(p.slot) && p.slot >= 0 && p.slot <= 254 ? p.slot : null;
  if (!pos && slot == null) return null;
  const now = new Date().toISOString();
  return {
    name: String(p.name || '').slice(0, 80) || t('presets.defaultName', { n: presets.length + 1 }),
    protocol: typeof p.protocol === 'string' ? p.protocol.slice(0, 20) : '',
    pos, slot,
    thumb: typeof p.thumb === 'string' && THUMB_RE.test(p.thumb) ? p.thumb : null,
    createdAt: now,
    updatedAt: now,
  };
}

$('#btnImport').addEventListener('click', async () => {
  let res;
  try { res = await ptz.importPresets(); } catch (e) { toast(errMsg(e), 'err'); return; }
  if (!res) return;
  const list = Array.isArray(res) ? res : res.presets;
  const file = Array.isArray(res) ? '' : res.name;
  const valid = (list || []).map(cleanImported).filter(Boolean);
  if (!valid.length) { toast(t('presets.importInvalid'), 'warn'); return; }
  const ok = await confirmDlg({
    icon: 'import',
    title: t('presets.importTitle', { n: valid.length }),
    text: t('presets.importText', { file, n: presets.length }),
    ok: t('presets.importAdd'),
  });
  if (!ok) return;
  // si aggiungono in fondo, con un codice nuovo (così non si confondono con quelle che ci sono già)
  const fresh = valid.map((p) => ({ ...p, id: uid() }));
  presets = presets.concat(fresh);
  renderPresets();
  await persist();
  $('#sPresetsBadge').textContent = t('s.presetsBadge', { user: info.user, n: presets.length });
  toast(t('presets.imported', { n: fresh.length }), 'ok');
});

$('#btnDataFolder').addEventListener('click', () => ptz.openDataFolder());
$('#btnDataFolder2').addEventListener('click', () => ptz.openDataFolder());
$('#btnProject').addEventListener('click', () => ptz.openProject());

// ---------------------------------------------------------------------------
// Aggiornamenti: avviso discreto in alto quando su GitHub c'è una versione più recente

let updateState = null;
let updateDismissed = false; // «più tardi»: l'avviso torna al prossimo avvio

function updateText(st) {
  if (!st) return '';
  switch (st.state) {
    case 'checking': return t('up.checking');
    case 'available': return t('up.newer', { v: st.latest });
    case 'current': return t('up.current', { v: st.current || info.version });
    case 'none': return t('up.none');
    case 'error': return t('up.error', { error: st.detail || '' });
    case 'disabled': return t('up.disabled');
    default: return '';
  }
}

function renderUpdate(st) {
  if (st) updateState = st;
  const s = updateState;
  const show = !!s && s.state === 'available' && !updateDismissed;
  $('#updatePill').hidden = !show;
  if (show) $('#btnUpdateText').textContent = t('up.available', { v: s.latest });
  const status = $('#updStatus');
  status.textContent = updateText(s);
  status.classList.toggle('upd-link', !!s && s.state === 'available');
  $('#btnCheckUpdate').disabled = !!s && (s.state === 'checking' || s.state === 'disabled');
}

$('#btnUpdate').addEventListener('click', () => { ptz.openUpdate(); });
$('#updStatus').addEventListener('click', () => { if (updateState && updateState.state === 'available') ptz.openUpdate(); });
$('#btnUpdateLater').addEventListener('click', () => { updateDismissed = true; renderUpdate(); });
$('#btnCheckUpdate').addEventListener('click', async () => {
  renderUpdate({ state: 'checking' });
  const r = await ptz.checkUpdate().catch((e) => ({ state: 'error', detail: errMsg(e) }));
  updateDismissed = false;
  renderUpdate(r);
});

// ---------------------------------------------------------------------------
// Comandi esterni: pannello OBS, indirizzi per Stream Deck/Companion, tasti globali

let api = null; // informazioni del collegamento (indirizzi, chiave, stato)

function renderApiStatus(st) {
  if (!st) return;
  const on = st.state === 'on';
  const err = st.state === 'error';
  $('#xDot').className = `big-dot ${on ? 'ok' : err ? 'bad' : ''}`;
  $('#xStatusTitle').textContent = on ? t('x.activeTitle') : err ? t('x.errorTitle') : t('x.offTitle');
  const lan = /^0\.0\.0\.0/.test(st.detail || '');
  $('#xStatus').textContent = on ? `${lan ? t('x.fromLan') : t('x.fromLocal')} · ${st.detail}`
    : err ? t('x.statusError', { error: st.detail }) : t('x.offNote');
}

const maskKey = (url) => url.replace(/k=[^&]*/, 'k=•••••••••••');

async function refreshApiInfo() {
  api = await ptz.apiInfo();
  $('#xObsUrl').value = maskKey(api.obsUrl);
  renderApiStatus(api.status);
  const keyed = Object.keys(settings.shortcuts || {}).filter((a) => api.actions.includes(a)).length;
  $('#xCommandsInfo').textContent = t('x.commandsInfo', { n: api.actions.length, k: keyed });
  return api;
}

async function copyText(text, note) {
  await ptz.copy(text);
  if (note) $('#cmdCopied').textContent = note;
  else toast(t('x.copied'), 'ok', 2000);
}

const ACTION_PATHS = {
  stop: 'stop', home: 'home', next: 'next', prev: 'prev', onepush: 'onepush',
  'zoom:in': 'zoom/in', 'zoom:out': 'zoom/out',
  'nudge:up': 'nudge/up', 'nudge:down': 'nudge/down', 'nudge:left': 'nudge/left', 'nudge:right': 'nudge/right',
};

const FIXED_ACTIONS_UI = Object.keys(ACTION_PATHS);

function actionPath(action) {
  return action.startsWith('preset:')
    ? `recall/id/${encodeURIComponent(action.slice(7))}`
    : ACTION_PATHS[action];
}

function actionUrl(action) {
  return `${api.base}/api/${actionPath(action)}?k=${encodeURIComponent(api.token)}`;
}

function actionLabel(action) {
  if (action.startsWith('preset:')) {
    const p = presets.find((x) => x.id === action.slice(7));
    return t('a.preset', { name: p ? p.name : '?' });
  }
  return t(`a.${action}`);
}

// Combinazione per i tasti globali (formato Electron) a partire dal tasto premuto
const SPECIAL_KEYS = {
  Space: 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  PageUp: 'PageUp', PageDown: 'PageDown', Home: 'Home', End: 'End', Insert: 'Insert', Delete: 'Delete',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
};
function accelFromEvent(e) {
  const c = e.code;
  let key = null;
  if (/^Key[A-Z]$/.test(c)) key = c.slice(3);
  else if (/^Digit\d$/.test(c)) key = c.slice(5);
  else if (/^F(\d{1,2})$/.test(c) && Number(c.slice(1)) <= 24) key = c;
  else if (/^Numpad\d$/.test(c)) key = `num${c.slice(6)}`;
  else if (SPECIAL_KEYS[c]) key = SPECIAL_KEYS[c];
  if (!key) return { pending: true }; // solo modificatori: si aspetta il tasto
  const extraF = /^F(1[3-9]|2[0-4])$/.test(key);
  if (!extraF && !e.ctrlKey && !e.altKey && !e.metaKey) return { error: t('c.needModifier') };
  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  return { accel: [...mods, key].join('+') };
}

let capture = null; // { action, handler }

function stopCapture() {
  if (!capture) return;
  window.removeEventListener('keydown', capture.handler, true);
  capture = null;
  renderCommands();
}

// combinazioni che Windows e quasi tutti i programmi usano già: un tasto globale le "ruberebbe"
const RESERVED = new Set([
  ...'ACVXZYSFPWNTOR'.split('').map((k) => `Control+${k}`),
  'Alt+F4', 'Alt+Tab', 'Alt+Space', 'Control+Alt+Delete', 'Control+Shift+Escape', 'Control+Escape',
  'Control+Shift+Z', 'Control+Shift+S', 'Control+Shift+N', 'Control+Shift+T',
]);

function validActions() {
  return [...FIXED_ACTIONS_UI, ...presets.map((p) => `preset:${p.id}`)];
}

async function saveShortcut(action, accel) {
  const valid = new Set(validActions());
  const sc = Object.fromEntries(Object.entries(settings.shortcuts || {}).filter(([a]) => valid.has(a)));
  if (accel) sc[action] = accel; else delete sc[action];
  const r = await ptz.saveSettings({ shortcuts: sc });
  settings = r.settings;
  if (accel && r.hotkeys && r.hotkeys.failed.includes(accel)) {
    toast(t('s.hotkeysBusy', { keys: accel }), 'warn', 6000);
  } else if (accel) {
    toast(t('c.saved', { key: accel }), 'ok', 2500);
  }
  renderCommands();
  if (api) refreshApiInfo();
}

function startCapture(action) {
  stopCapture();
  const handler = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { stopCapture(); return; }
    const r = accelFromEvent(e);
    if (r.pending) return;
    if (r.error) { toast(r.error, 'warn', 5000); return; }
    if (RESERVED.has(r.accel)) { toast(t('c.reserved', { key: r.accel }), 'warn', 5000); return; }
    const valid = new Set(validActions());
    const other = Object.entries(settings.shortcuts || {}).find(([a, k]) => k === r.accel && a !== action && valid.has(a));
    const fixed = settings.globalHotkeys && (/^Control\+Alt\+\d$/.test(r.accel) || r.accel === 'Control+Alt+S');
    if (other || fixed) {
      toast(t('c.taken', { name: other ? actionLabel(other[0]) : t('x.ready') }), 'warn', 5000);
      return;
    }
    const act = capture.action;
    stopCapture();
    saveShortcut(act, r.accel);
  };
  capture = { action, handler };
  window.addEventListener('keydown', handler, true);
  renderCommands();
}

function commandRow(action) {
  const row = document.createElement('div');
  const capturing = !!capture && capture.action === action;
  row.className = `cmd-row${capturing ? ' capturing' : ''}`;
  row.dataset.action = action;
  const idx = action.startsWith('preset:') ? presets.findIndex((p) => `preset:${p.id}` === action) : -1;
  const accel = (settings.shortcuts || {})[action];
  const name = idx >= 0 ? presets[idx].name : actionLabel(action);
  const thumb = idx >= 0 ? thumbHtml(presets[idx], idx, { big: false }) : '';
  const chipText = capturing ? t('c.press') : (accel || '—');
  row.innerHTML = `<div class="label" title="${esc(actionLabel(action))}">${thumb}<span class="lname">${esc(name)}</span></div>`
    + `<div class="key-cell"><div class="key-chip${accel && !capturing ? ' set' : ''}${capturing ? ' capturing' : ''}">${esc(chipText)}</div>`
    + `${accel && !capturing ? `<button type="button" class="kc-clear b-clear" title="${esc(t('c.clear'))}" aria-label="${esc(t('c.clear'))}">${ICONS.x}</button>` : ''}</div>`
    + `<button type="button" class="b-assign">${esc(capturing ? t('common.cancel') : accel ? t('c.change') : t('c.assign'))}</button>`
    + `<button type="button" class="b-url" title="${esc(t('c.copyUrl'))}" aria-label="${esc(t('c.copyUrlOf', { name }))}">${ICONS.link}</button>`;
  row.querySelector('.b-assign').addEventListener('click', () => (capturing ? stopCapture() : startCapture(action)));
  const clr = row.querySelector('.b-clear');
  if (clr) clr.addEventListener('click', () => saveShortcut(action, null));
  row.querySelector('.b-url').addEventListener('click', () => copyText(actionUrl(action), t('c.copiedUrl', { path: actionPath(action) })));
  return row;
}

function renderCommands() {
  const box = $('#cmdTable');
  if (!box || !api) return;
  $('#cmdApiOff').hidden = !!settings.api.enabled;
  const keyedOnly = segGet($('#cmdFilter')) === 'keyed';
  const sc = settings.shortcuts || {};
  const keep = (a) => !keyedOnly || !!sc[a] || (capture && capture.action === a);
  const fixed = api.actions.filter((a) => !a.startsWith('preset:')).filter(keep);
  const pres = presets.map((p) => `preset:${p.id}`).filter(keep);
  box.innerHTML = '';
  const section = (title, list) => {
    if (!list.length) return;
    const h = document.createElement('h3');
    h.className = 'cmd-sec';
    h.textContent = title;
    box.appendChild(h);
    list.forEach((a) => box.appendChild(commandRow(a)));
  };
  section(t('c.secControl'), fixed);
  section(t('c.secPresets'), pres);
  if (!box.children.length) box.innerHTML = `<div class="cmd-empty">${esc(t('c.noneKeyed'))}</div>`;
}

segBind($('#cmdFilter'), () => renderCommands());
$('#xCopyObs').addEventListener('click', () => copyText(api ? api.obsUrl : ''));
$('#xCommands').addEventListener('click', async () => {
  await refreshApiInfo();
  segSet($('#cmdFilter'), 'all');
  $('#cmdCopied').textContent = '';
  renderCommands();
  $('#dlgCommands').showModal();
  if (document.activeElement) document.activeElement.blur(); // niente anello di selezione all'apertura
});
$('#cmdDone').addEventListener('click', () => $('#dlgCommands').close());
$('#dlgCommands').addEventListener('close', () => stopCapture());
$('#dlgCommands').addEventListener('cancel', (e) => {
  // Esc durante la cattura annulla solo la cattura
  if (capture) e.preventDefault();
});
$('#xNewKey').addEventListener('click', async () => {
  const ok = await confirmDlg({
    icon: 'key', title: t('x.newKeyTitle'), text: t('x.newKeyText'), ok: t('x.newKey'),
  });
  if (!ok) return;
  api = await ptz.newApiToken();
  settings.api.token = api.token;
  $('#xObsUrl').value = maskKey(api.obsUrl);
  renderApiStatus(api.status);
  toast(t('x.newKeyDone'), 'ok');
});
$('#xLan').addEventListener('change', () => { $('#xLanWarn').hidden = !$('#xLan').checked; });

// ---------------------------------------------------------------------------
// Primo avvio: trova la telecamera, l'anteprima video, poi «tutto pronto»

const wz = {
  step: 1, devices: [], selected: null, name: '', manual: false, analysis: null, rtsp: null,
  token: 0, searching: false, saved: false,
};

function renderWzSteps() {
  const names = [t('w.stepCamera'), t('w.stepVideo'), t('w.stepReady')];
  const html = names.map((n, i) => {
    const s = i + 1;
    const cls = s < wz.step ? 'done' : s === wz.step ? 'cur' : 'todo';
    return `<li class="${cls}"><span class="n">${s < wz.step ? '✓' : s}</span>${esc(n)}</li>`;
  }).join('');
  $$('.wz-steps').forEach((ol) => { ol.innerHTML = html; });
}

function wzGo(n) {
  wz.step = n;
  $$('.wz-step').forEach((el) => el.classList.toggle('on', Number(el.dataset.step) === n));
  renderWzSteps();
  if (n === 2) {
    fitCanvas(wzCanvas);
    const src = settings.preview.source;
    $$('input[name="wzSrc"]').forEach((r) => { r.checked = r.value === src; });
    // flusso non trovato da solo: si chiede subito l'indirizzo
    const missing = src === 'rtsp' && !settings.preview.rtspUrl;
    $('#wzUrlBox').hidden = !missing;
    if (missing) $('#wzRtsp').value = '';
    renderWzVideo();
    if (lastFrame) draw(lastFrame);
  }
  if (n === 3) renderWzReady();
  $('.wz-scroll').scrollTop = 0;
}

function openWizard() {
  document.body.classList.add('wizard-open');
  setWindowTitle(t('app.name'));
  wzGo(1);
  wzSearch();
}

function closeWizard() {
  document.body.classList.remove('wizard-open');
  renderAll();
}

function wzSetSearch(kind, title, sub) {
  $('#wzSearchIcon').innerHTML = { ok: ICONS.check, bad: ICONS.fail, busy: ICONS.spinner, warn: ICONS.warnDot }[kind] || '';
  $('#wzSearchTitle').textContent = title;
  $('#wzSearchSub').textContent = sub || '';
}

function renderWzDevices() {
  const best = wz.devices[0] && (wz.devices[0].onvif || wz.devices[0].rtsp) ? wz.devices[0].ip : null;
  $('#wzDevices').innerHTML = wz.devices.map((d) => deviceHtml(d, { selected: d.ip === wz.selected, recommended: d.ip === best })).join('');
}

async function wzSearch() {
  if (wz.searching) return;
  wz.searching = true;
  $('#wzSearchAgain').disabled = true;
  wzSetSearch('busy', t('w.searching'), t('w.searchingSub'));
  try {
    const r = await ptz.discover();
    wz.devices = r.devices;
    for (const d of r.devices) if (deviceName(d)) discoveredNames.set(d.ip, deviceName(d));
    const nets = r.networks.map((n) => n.address.replace(/\.\d+$/, '.x')).join(', ') || t('d.netsNone');
    if (!r.devices.length) {
      wzSetSearch('warn', t('w.noneTitle'), t('w.noneSub', { nets }));
      if (!wz.selected) wzShowManual(true);
    } else {
      wzSetSearch('ok', t('w.doneTitle'), t('w.doneSub', { nets, n: r.devices.length }));
      const best = r.devices[0];
      if (!wz.selected && !wz.manual && (best.onvif || best.rtsp)) wzSelect(best.ip);
    }
    renderWzDevices();
  } catch (e) {
    wzSetSearch('bad', t('d.searchError', { error: errMsg(e) }), '');
    wzShowManual(true);
  } finally {
    wz.searching = false;
    $('#wzSearchAgain').disabled = false;
  }
}

function wzShowManual(on) {
  wz.manual = on;
  $('#wzManual').hidden = !on;
  if (on) setTimeout(() => $('#wzHost').focus(), 0);
}

function wzSelect(ip) {
  wz.selected = ip;
  wz.name = discoveredNames.get(ip) || '';
  renderWzDevices();
  wzCheck(ip);
}

function wzCheckLine(el, kind, text, result) {
  const icon = { ok: ICONS.check, bad: ICONS.fail, warn: ICONS.warnDot, wait: ICONS.spinner }[kind] || '';
  el.innerHTML = `${icon}<span class="t">${esc(text)}</span><span class="r ${kind}">${esc(result)}</span>`;
}

async function wzCheck(host) {
  wz.token += 1;
  const token = wz.token;
  wz.analysis = null;
  wz.rtsp = null;
  $('#wzUse').disabled = true;
  $('#wzChecks').hidden = false;
  $('#wzChecksTitle').textContent = t('w.checkOf', { host });
  wzCheckLine($('#wzCheckCmd'), 'wait', t('w.cmd'), t('w.checkingShort'));
  wzCheckLine($('#wzCheckPos'), 'wait', t('w.pos'), t('w.checkingShort'));
  wzCheckLine($('#wzCheckVideo'), 'wait', t('w.video'), t('w.checkingShort'));
  const user = settings.camera.user || 'admin';
  const pass = settings.camera.pass || '';
  let a;
  try {
    const r = await ptz.detectProtocols({ host, user, pass, address: 1 });
    if (token !== wz.token) return;
    a = analyzeDetection(r);
  } catch (e) {
    if (token !== wz.token) return;
    wzCheckLine($('#wzCheckCmd'), 'bad', t('w.cmd'), errMsg(e));
    return;
  }
  wz.analysis = { ...a, host };
  if (a.chosen) {
    wzCheckLine($('#wzCheckCmd'), 'ok', `${t('w.cmd')} · ${PROTOCOL_DESC[a.chosen.protocol]} ${a.chosen.port}`, t('w.replies'));
    if (a.needSlot) wzCheckLine($('#wzCheckPos'), 'warn', t('w.pos'), t('w.posSlot'));
    else wzCheckLine($('#wzCheckPos'), 'ok', t('w.pos'), t('w.posOk'));
    $('#wzUse').disabled = false;
  } else {
    wzCheckLine($('#wzCheckCmd'), 'bad', a.onvifAuth ? t('d.onvifAuth') : t('w.cmd'), t('w.noReply'));
    wzCheckLine($('#wzCheckPos'), '', t('w.pos'), '—');
  }
  // flusso video: può richiedere fino a un minuto, intanto si può già andare avanti
  try {
    const onvifPort = a.chosen && a.chosen.protocol === 'onvif' ? a.chosen.port : 80;
    const list = await ptz.detectRtsp({ host, user, pass, onvifPort });
    if (token !== wz.token) return;
    const ok = list.find((x) => x.ok);
    wz.rtsp = ok ? { url: ok.url, display: ok.display } : { url: '', display: '' };
    if (ok) wzCheckLine($('#wzCheckVideo'), 'ok', `${t('w.video')} · ${ok.display}`, t('w.videoOk'));
    else wzCheckLine($('#wzCheckVideo'), 'warn', t('w.video'), t('w.videoNone'));
    // la camera è già stata scelta mentre si cercava il video: si usa subito il flusso trovato
    if (ok && wz.saved && wz.saved === host && !settings.preview.rtspUrl
      && document.body.classList.contains('wizard-open') && !wz.sourcePicked) await wzSavePreview('rtsp', ok.url);
  } catch (e) {
    if (token !== wz.token) return;
    wz.rtsp = { url: '', display: '' };
    wzCheckLine($('#wzCheckVideo'), 'warn', t('w.video'), t('w.videoNone'));
  }
}

$('#wzSearchAgain').addEventListener('click', () => wzSearch());
$('#wzDevices').addEventListener('click', (e) => {
  const el = e.target.closest('.device');
  if (el) wzSelect(el.dataset.ip);
});
$('#wzManualBtn').addEventListener('click', () => wzShowManual(!wz.manual));
$('#wzCheck').addEventListener('click', () => {
  const host = $('#wzHost').value.trim();
  if (!host) { toast(t('s.needIp'), 'warn'); return; }
  wz.selected = host;
  wz.name = discoveredNames.get(host) || '';
  renderWzDevices();
  wzCheck(host);
});
$('#wzHost').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#wzCheck').click(); } });
$('#wzSkip').addEventListener('click', () => { closeWizard(); openSettings('camera'); });

async function wzSave(partial) {
  const r = await ptz.saveSettings(partial);
  settings = r.settings;
  return settings;
}

async function wzSavePreview(source, rtspUrl) {
  const p = { source };
  if (rtspUrl != null) p.rtspUrl = rtspUrl;
  await wzSave({ preview: p });
  if (source !== 'rtsp') previewState = { state: 'off', detail: '' };
  applyPreviewSource();
  renderWzVideo();
}

$('#wzUse').addEventListener('click', async () => {
  const a = wz.analysis;
  if (!a || !a.chosen) return;
  const btn = $('#wzUse');
  btn.disabled = true;
  try {
    const camera = {
      ...settings.camera,
      host: a.host,
      name: wz.name || '',
      protocol: a.chosen.protocol,
      port: a.chosen.port,
      address: 1,
    };
    const partial = { camera, presetMode: a.needSlot ? 'slot' : 'app' };
    if (wz.rtsp && wz.rtsp.url) partial.preview = { source: 'rtsp', rtspUrl: wz.rtsp.url };
    await wzSave(partial);
    wz.saved = a.host;
    camFirstAttempt = true;
    applyPreviewSource();
    renderCamStatus();
    wzGo(2);
  } catch (e) {
    toast(t('s.notSaved', { error: errMsg(e) }), 'err');
  } finally {
    btn.disabled = false;
  }
});

function renderWzVideo() {
  if (!settings || wz.step !== 2) return;
  const src = settings.preview.source;
  const live = previewState.state === 'live';
  const url = settings.preview.rtspUrl;
  $$('.choice').forEach((c) => c.classList.toggle('sel', c.querySelector('input').checked));
  $('#wzLive').hidden = !live;
  wzCanvas.style.visibility = live ? 'visible' : 'hidden';
  $('#wzNoVideo').classList.toggle('hidden', live);
  $('#wzChangeUrl').hidden = src !== 'rtsp';
  let kind = '';
  let title = '';
  let sub = '';
  if (src === 'none') {
    kind = 'ok'; title = t('w.noVideoChosen');
    $('#wzNoVideoText').textContent = t('preview.off');
  } else if (src === 'usb') {
    kind = live ? 'ok' : previewState.state === 'error' ? 'bad' : 'busy';
    title = live ? t('w.usbFound') : previewState.state === 'error' ? t('w.usbFail') : t('preview.connecting');
    sub = previewState.state === 'error' ? previewState.detail : '';
    $('#wzNoVideoText').textContent = title;
  } else if (!url) {
    kind = 'warn'; title = t('w.videoMissing');
    $('#wzNoVideoText').textContent = t('w.videoMissingSub');
  } else {
    kind = live ? 'ok' : previewState.state === 'error' ? 'bad' : 'busy';
    title = live ? t('w.videoFound') : previewState.state === 'error' ? t('preview.noSignal') : t('preview.connecting');
    sub = url.replace(/\/\/[^@/]*@/, '//');
    $('#wzNoVideoText').textContent = title;
  }
  $('#wzVideoIcon').innerHTML = { ok: ICONS.check, bad: ICONS.fail, busy: ICONS.spinner, warn: ICONS.warnDot }[kind] || '';
  $('#wzVideoTitle').textContent = title;
  $('#wzVideoUrl').textContent = sub;
  $('#wzVideoUrl').title = sub;
}

$('#wzSources').addEventListener('change', (e) => {
  if (e.target.name === 'wzSrc') wz.sourcePicked = true; // scelta dell'utente: non va più cambiata da sola
  if (e.target.name !== 'wzSrc') return;
  wzSavePreview(e.target.value);
});
$('#wzChangeUrl').addEventListener('click', () => {
  $('#wzUrlBox').hidden = !$('#wzUrlBox').hidden;
  $('#wzRtsp').value = settings.preview.rtspUrl || '';
  if (!$('#wzUrlBox').hidden) $('#wzRtsp').focus();
});
$('#wzTest').addEventListener('click', async () => {
  const url = $('#wzRtsp').value.trim();
  if (!url) return;
  const btn = $('#wzTest');
  btn.disabled = true;
  $('#wzVideoIcon').innerHTML = ICONS.spinner;
  $('#wzVideoTitle').textContent = t('r.testing');
  const r = await ptz.testUrl(url);
  btn.disabled = false;
  if (r.ok) {
    $('#wzUrlBox').hidden = true;
    await wzSavePreview('rtsp', url);
  } else {
    renderWzVideo();
    toast(t('r.fails', { error: r.error || t('cam.error') }), 'err', 6000);
  }
});
$('#wzRtsp').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#wzTest').click(); } });
$('#wzBack').addEventListener('click', () => wzGo(1));
$('#wzContinue').addEventListener('click', () => wzGo(3));

function renderWzReady() {
  const c = settings.camera;
  const src = settings.preview.source;
  const name = c.name ? `<b>${esc(c.name)}</b> · ` : '';
  const lines = [
    `${t('w.sumCamera')} ${name}${esc(c.host)} · ${esc(PROTOCOL_DESC[c.protocol] || c.protocol)}`,
    esc(src === 'rtsp' ? t('w.sumRtsp') : src === 'usb' ? t('w.sumUsb') : t('w.sumNone')),
    settings.presetMode === 'slot' ? esc(t('w.sumSlot')) : t('w.sumApp', { user: `<b>${esc(info.user)}</b>` }),
  ];
  $('#wzSummary').innerHTML = lines.map((l) => `<div class="line">${ICONS.check}<span>${l}</span></div>`).join('');
  $('#wzReadyLead').textContent = src === 'none' ? t('w.readyLeadNoVideo') : t('w.readyLead');
}

$('#wzFirstPreset').addEventListener('click', () => { closeWizard(); openEditor(); });
$('#wzObs').addEventListener('click', () => { closeWizard(); openSettings('external'); });
$('#wzReduced').addEventListener('click', () => { closeWizard(); openSettings('general'); });
$('#wzOpen').addEventListener('click', () => closeWizard());

// ---------------------------------------------------------------------------
// Avvio

function renderAll() {
  renderCamStatus();
  renderPresets();
  renderPreviewState();
}

(async () => {
  const s = await ptz.init();
  settings = s.settings;
  presets = s.presets || [];
  activeId = s.activeId || null;
  info = s.info;
  window.I18N.setLang(info.lang);
  document.documentElement.lang = info.lang;
  if (info.platform === 'darwin') {
    document.body.classList.add('mac');
    const acc = document.querySelector('[data-i18n="g.winAccount"]');
    if (acc) acc.dataset.i18n = 'g.macAccount';
  }
  window.UI.applyI18n(t);
  setWindowTitle(t('app.name'));
  renderMaximized(!!info.maximized);
  camState = s.camStatus;
  previewState = s.previewStatus;
  $('#account').textContent = info.user;
  bindSlider('moveSpeed', 'moveSpeed');
  bindSlider('recallSpeed', 'recallSpeed');
  setAfUi(true);
  applyView(s.view);
  applyPreviewSource();
  renderAll();

  ptz.onCamStatus((st) => {
    const was = camState.state;
    camState = st;
    renderCamStatus();
    renderPreviewState();
    if (was === 'connected' && st.state !== 'connected') toast(t('cam.toast', { detail: st.detail || t('cam.lost') }), 'warn');
  });
  ptz.onCamLog((m) => toast(m, 'warn'));
  ptz.onHotkey((h) => {
    if (h.type === 'stop') resetManualUi(); // lo stop è già partito: si sistema solo l'interfaccia
  });
  // inquadratura richiamata da OBS, Stream Deck, tasti globali, vista laterale o da questa finestra
  ptz.onActive((id) => {
    activeId = id;
    const p = presets.find((x) => x.id === id);
    if (p && p.pos && p.pos.focusAuto !== undefined) setAfUi(p.pos.focusAuto !== false);
    if (!editor) renderPresets(); else renderCompactList();
  });
  ptz.onApiStatus((st) => renderApiStatus(st));
  renderUpdate(s.update || null);
  ptz.onUpdateStatus((st) => renderUpdate(st));
  ptz.onSettingsChanged((s2) => { settings = s2; });
  ptz.onViewChanged((v) => applyView(v));
  ptz.onMaximized((on) => renderMaximized(on));

  // primo avvio di questo account: la procedura guidata trova la telecamera
  if (!settings.camera.host) {
    if (view.mode !== 'full') applyView(await ptz.setView('full'));
    openWizard();
  }
})();
