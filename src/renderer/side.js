'use strict';
/* global ptz */
/* Vista laterale: linguetta sul bordo dello schermo che si apre passandoci sopra.
 * Richiami, Home e STOP passano dal centro operativo come quelli della finestra principale. */

const { t } = window.I18N;
const {
  esc, HOTKEYS, presetNum, thumbHtml, cameraName, camLevel, camConfigured, camAddress,
} = window.UI;
const $ = (s) => document.querySelector(s);

let settings = null;
let presets = [];
let activeId = null;
let recallingId = null;
let camState = { state: 'disconnected', detail: '' };
let view = { mode: 'side', side: 'right' };
let open = false;
let pinned = false; // «Tieni aperta»
let collapseTimer = null;

function render() {
  if (!settings) return;
  document.body.classList.toggle('side-left', view.side === 'left');
  document.body.classList.toggle('side-right', view.side !== 'left');
  const c = settings.camera;
  const on = camConfigured(c);
  const lvl = camLevel(camState, on);
  const name = on ? (c.name || camAddress(c)) : t('top.notConfigured');
  $('#tabDot').className = `dot ${lvl}`;
  $('#pDot').className = `dot ${lvl}`;
  $('#pCam').textContent = name;
  $('#pCam').title = on ? `${cameraName(c)} · ${camAddress(c)}` : '';
  const i = presets.findIndex((p) => p.id === activeId);
  $('#tabNum').textContent = i >= 0 ? presetNum(i) : '–';
  $('#tabNum').classList.toggle('on', i >= 0);
  $('#tabName').textContent = i >= 0 ? presets[i].name : t('app.name');
  $('#tab').setAttribute('aria-label', i >= 0 ? t('side.tabActive', { n: presetNum(i), name: presets[i].name }) : t('side.tab'));
  const other = view.side === 'left' ? 'right' : 'left';
  $('#sSwap').title = t(other === 'left' ? 'v.toLeft' : 'v.toRight');
  $('#sSwap').setAttribute('aria-label', $('#sSwap').title);
  $('#sPin').setAttribute('aria-pressed', pinned ? 'true' : 'false');
  renderList();
}

function renderList() {
  const box = $('#pList');
  if (!presets.length) {
    box.innerHTML = `<div class="p-empty">${esc(t('presets.emptyShort'))}</div>`;
    return;
  }
  box.innerHTML = presets.map((p, i) => `<button class="p-row${p.id === activeId ? ' active' : ''}${p.id === recallingId ? ' busy' : ''}" data-id="${esc(p.id)}" title="${esc(p.name)}">`
    + `${thumbHtml(p, i, { big: false })}<span class="p-name">${esc(p.name)}</span></button>`).join('');
}

// ---- apertura e chiusura

function expand() {
  clearTimeout(collapseTimer);
  if (open) return;
  open = true;
  ptz.expandSide(true);
  document.body.classList.add('open');
}

function collapse() {
  clearTimeout(collapseTimer);
  if (!open || pinned) return;
  open = false;
  document.body.classList.remove('open');
  ptz.expandSide(false);
}

function scheduleCollapse() {
  clearTimeout(collapseTimer);
  if (pinned) return;
  collapseTimer = setTimeout(collapse, 700);
}

$('#tab').addEventListener('mouseenter', expand);
$('#tab').addEventListener('click', expand);
$('#tab').addEventListener('keydown', (e) => { if (e.key === 'Enter') expand(); });
$('#panel').addEventListener('mouseenter', () => clearTimeout(collapseTimer));
$('#panel').addEventListener('mouseleave', scheduleCollapse);
document.documentElement.addEventListener('mouseleave', () => { if (open) scheduleCollapse(); });

// ---- comandi

async function recall(p) {
  if (!p) return;
  recallingId = p.id;
  renderList();
  try {
    const r = await ptz.recallPreset(p.id, settings.recallSpeed);
    if (r && r.id) activeId = p.id;
  } catch (e) {
    $('#pCam').title = String(e && e.message ? e.message : e);
  } finally {
    if (recallingId === p.id) recallingId = null;
    render();
  }
}

$('#pList').addEventListener('click', (e) => {
  const row = e.target.closest('.p-row');
  if (row) recall(presets.find((x) => x.id === row.dataset.id));
});
$('#sSwap').addEventListener('click', async () => {
  view = await ptz.setSide(view.side === 'left' ? 'right' : 'left');
  render();
});
$('#sPin').addEventListener('click', () => {
  pinned = !pinned;
  render();
  if (!pinned && !$('#panel').matches(':hover')) scheduleCollapse();
});
$('#sFull').addEventListener('click', () => { pinned = false; ptz.setView('full'); });

// con la finestra in primo piano: Esc o Spazio = STOP, 1–9 e 0 = richiamo
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || e.code === 'Space') {
    e.preventDefault();
    ptz.cmd('stop');
    return;
  }
  if (e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
  const digit = /^Digit(\d)$/.exec(e.code) || /^Numpad(\d)$/.exec(e.code);
  if (digit) {
    e.preventDefault();
    recall(presets[HOTKEYS.indexOf(digit[1])]);
  }
});

// ---- avvio

(async () => {
  const s = await ptz.init();
  settings = s.settings;
  presets = s.presets || [];
  activeId = s.activeId || null;
  camState = s.camStatus;
  view = s.view || view;
  window.I18N.setLang(s.info.lang);
  document.documentElement.lang = s.info.lang;
  window.UI.applyI18n(t);
  render();

  ptz.onCamStatus((st) => { camState = st; render(); });
  ptz.onActive((id) => { activeId = id; render(); });
  ptz.onPresetsChanged((list) => { presets = list || []; render(); });
  ptz.onSettingsChanged((s2) => { settings = s2; render(); });
  ptz.onViewChanged((v) => { view = v; render(); });
})();
