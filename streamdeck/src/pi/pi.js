// Property Inspector delle azioni "Inquadratura" e "Comando".
// Usa i componenti sdpi per l'aspetto, ma valori e impostazioni sono gestiti qui:
// così le impostazioni globali (host, porta, chiave) si possono riempire in un colpo
// dall'indirizzo del pannello OBS e i testi seguono la lingua di PTZ Hub.

import { displayAddress, normalizeConfig, parsePanelAddress } from '../shared/address.js';
import { COMMANDS, normalizeCommand } from '../shared/commands.js';
import { resolveLang, translate } from '../shared/strings.js';
import { describe, presetOptions } from './logic.js';

const PRESET_UUID = 'agency.redmango.ptzhub.preset';

const S = {
  client: null,
  kind: 'preset',
  lang: 'en',
  settings: {},
  global: {},
  presets: null, // ultimo messaggio "presets" del plugin
  result: null, // { cls, text } della riga di stato
  lastMsg: null, // ultimo stato o esito della prova, per ritradurlo se cambia la lingua
  els: {},
  applying: false,
  optSig: '',
  saveTimer: null,
  pasteTimer: null,
  testTimer: null,
  testId: 0,
  gotStatus: false,
};

const t = (key, vars) => translate(S.lang, key, vars);

// ---- avvio -------------------------------------------------------------------------

const sdpiConnect = window.connectElgatoStreamDeckSocket;
window.connectElgatoStreamDeckSocket = (port, uuid, registerEvent, info, actionInfo) => {
  if (typeof sdpiConnect === 'function') sdpiConnect(port, uuid, registerEvent, info, actionInfo);
  start(parseJson(info), parseJson(actionInfo));
};

function parseJson(s) {
  if (s && typeof s === 'object') return s;
  try { return JSON.parse(s); } catch (_) { return {}; }
}

function start(info, actionInfo) {
  const client = window.SDPIComponents && window.SDPIComponents.streamDeckClient;
  if (!client) return;
  S.client = client;
  S.kind = actionInfo.action === PRESET_UUID ? 'preset' : 'command';
  S.settings = (actionInfo.payload && actionInfo.payload.settings) || {};
  S.lang = resolveLang({ sdLang: info && info.application && info.application.language, systemLocale: navigator.language });

  client.didReceiveSettings.subscribe((ev) => {
    if (ev && ev.payload && ev.payload.settings && ev.action === actionInfo.action && ev.context === actionInfo.context) {
      S.settings = ev.payload.settings;
      applySettings();
    }
  });
  client.didReceiveGlobalSettings.subscribe((ev) => {
    S.global = (ev && ev.payload && ev.payload.settings) || {};
    applyGlobal();
  });
  client.sendToPropertyInspector.subscribe((ev) => onMessage(ev && ev.payload));

  render();
  client.getGlobalSettings().catch(() => {});
  hello();
}

function send(payload) {
  if (S.client) S.client.send('sendToPlugin', payload).catch(() => {});
}

// il plugin potrebbe non essere ancora pronto: si saluta finché non risponde
function hello(attempt = 0) {
  if (S.gotStatus || attempt > 5) return;
  send({ event: 'hello' });
  setTimeout(() => hello(attempt + 1), 1500);
}

// ---- messaggi dal plugin ---------------------------------------------------------

function onMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.event) {
    case 'status':
      S.gotStatus = true;
      if (msg.lang && msg.lang !== S.lang) {
        S.lang = msg.lang;
        render();
      }
      if (!S.testTimer) showMessage(msg);
      break;
    case 'presets':
      S.presets = msg;
      buildPresetOptions();
      break;
    case 'testResult':
      clearTimeout(S.testTimer);
      S.testTimer = null;
      showMessage({ ...msg, test: true });
      break;
    default:
  }
}

function showMessage(msg) {
  S.lastMsg = msg;
  setResult(describe(msg, t));
}

function setResult(r) {
  S.result = r;
  const box = S.els.result;
  if (!box) return;
  box.className = `ptz-result ${r ? r.cls : ''}`;
  box.querySelector('.txt').textContent = r ? r.text : '';
}

// ---- interfaccia ---------------------------------------------------------------------

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) if (c) e.append(c);
  return e;
}

const item = (label, children) => el('sdpi-item', label ? { label } : {}, children);
const heading = (text) => el('div', { class: 'ptz-head' }, el('span', { text }));

function render() {
  const app = document.getElementById('app');
  if (!app) return;
  document.documentElement.lang = S.lang;
  const els = {};

  // tasto
  const top = [heading(t('pi.button'))];
  if (S.kind === 'preset') {
    els.preset = el('sdpi-select', { placeholder: t('pi.presetChoose') });
    top.push(item(t('pi.preset'), els.preset));
  } else {
    els.command = el('sdpi-select', {}, COMMANDS.map((c) => el('option', { value: c, text: t(`pi.cmd.${c}`) })));
    top.push(item(t('pi.command'), els.command));
  }

  // collegamento
  els.paste = el('sdpi-textfield', { placeholder: t('pi.pastePlaceholder') });
  els.host = el('sdpi-textfield', { placeholder: '127.0.0.1' });
  els.port = el('sdpi-textfield', { placeholder: '8765', pattern: '\\d{1,5}', maxlength: 5 });
  els.key = el('sdpi-password', {});
  els.test = el('sdpi-button', {}, el('span', { text: t('pi.test') }));
  els.result = el('div', { class: 'ptz-result' }, [el('span', { class: 'dot' }), el('span', { class: 'txt' })]);

  const conn = [
    el('div', { class: 'ptz-sep' }),
    heading(t('pi.connection')),
    item(t('pi.paste'), [els.paste, el('div', { class: 'ptz-hint', text: t('pi.pasteHint') })]),
    item(t('pi.host'), els.host),
    item(t('pi.port'), els.port),
    item(t('pi.key'), els.key),
    item('', [els.test, els.result]),
    el('div', { class: 'ptz-foot', text: t('pi.footer') }),
  ];

  app.replaceChildren(...top, ...conn);
  S.els = els;
  S.optSig = '';

  // valori
  applySettings();
  applyGlobal(true);
  buildPresetOptions();
  setResult(S.lastMsg ? describe(S.lastMsg, t) : S.result);

  // eventi
  els.paste.addEventListener('valuechange', onPasteChange);
  for (const k of ['host', 'port', 'key']) els[k].addEventListener('valuechange', onFieldChange);
  els.test.addEventListener('click', runTest);
  if (els.preset) els.preset.addEventListener('valuechange', onPresetChange);
  if (els.command) els.command.addEventListener('valuechange', onCommandChange);
}

function applying(fn) {
  S.applying = true;
  try { fn(); } finally { S.applying = false; }
}

function applySettings() {
  const { els } = S;
  if (els.command) applying(() => { els.command.value = normalizeCommand(S.settings.command); });
  if (els.preset) buildPresetOptions(true);
}

function applyGlobal(force = false) {
  const { els } = S;
  if (!els.host) return;
  const g = S.global || {};
  applying(() => {
    // un campo che si sta scrivendo non si tocca
    if (force || document.activeElement !== els.host) els.host.value = g.host ? String(g.host) : '';
    if (force || document.activeElement !== els.port) els.port.value = g.port ? String(g.port) : '';
    if (force || document.activeElement !== els.key) els.key.value = g.key ? String(g.key) : '';
  });
}

function currentFields() {
  const { els } = S;
  return {
    host: String(els.host.value || '').trim(),
    port: String(els.port.value || '').trim(),
    key: String(els.key.value || '').trim(),
  };
}

function saveGlobal() {
  clearTimeout(S.saveTimer);
  S.saveTimer = null;
  const f = currentFields();
  const port = /^\d{1,5}$/.test(f.port) ? Number(f.port) : f.port;
  S.global = { ...S.global, host: f.host, port, key: f.key };
  S.client.setGlobalSettings(S.global).catch(() => {});
}

function onFieldChange() {
  if (S.applying) return;
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(saveGlobal, 500);
}

function onPasteChange() {
  if (S.applying) return;
  clearTimeout(S.pasteTimer);
  const text = String(S.els.paste.value || '');
  if (!text.trim()) return;
  const r = parsePanelAddress(text);
  if (!r) {
    // si avvisa solo quando si smette di scrivere
    S.pasteTimer = setTimeout(() => setResult({ cls: 'err', text: t('pi.parseError') }), 900);
    return;
  }
  applying(() => {
    S.els.host.value = r.host;
    S.els.port.value = String(r.port);
    S.els.key.value = r.key;
  });
  // il campo si svuota dopo che il componente ha mostrato il testo incollato: svuotandolo subito
  // (dentro lo stesso aggiornamento) il campo visibile resterebbe pieno
  const pasteEl = S.els.paste;
  Promise.resolve(pasteEl.updateComplete).then(() => applying(() => { pasteEl.value = ''; }));
  saveGlobal();
  setResult({ cls: 'wait', text: t('pi.parsed', { addr: displayAddress(normalizeConfig(r)) }) });
  runTest();
}

function runTest() {
  if (S.saveTimer) saveGlobal();
  const f = currentFields();
  clearTimeout(S.testTimer);
  const id = ++S.testId;
  setResult({ cls: 'wait', text: t('pi.testing') });
  S.testTimer = setTimeout(() => {
    if (id !== S.testId) return;
    S.testTimer = null;
    const cfg = normalizeConfig(f);
    showMessage({ test: true, ok: false, reason: 'unreachable', address: displayAddress(cfg), port: cfg.port });
  }, 9000);
  send({ event: 'testConnection', ...f });
}

function onPresetChange() {
  if (S.applying) return;
  const v = S.els.preset.value;
  if (!v || String(v).startsWith('__') || v === S.settings.presetId) return;
  const p = S.presets && S.presets.presets.find((x) => x.id === v);
  S.settings = { ...S.settings, presetId: v, presetName: p ? p.name : '' };
  S.client.setSettings(S.settings).catch(() => {});
}

function onCommandChange() {
  if (S.applying) return;
  const v = normalizeCommand(S.els.command.value);
  if (v === S.settings.command) return;
  S.settings = { ...S.settings, command: v };
  S.client.setSettings(S.settings).catch(() => {});
}

function buildPresetOptions(forceValue = false) {
  const sel = S.els.preset;
  if (!sel) return;
  const opts = presetOptions(S.presets, S.settings, t);
  const sig = JSON.stringify(opts);
  if (sig !== S.optSig) {
    S.optSig = sig;
    sel.replaceChildren(...opts.map((o) => {
      const e = el('option', { value: o.value, text: o.label });
      if (o.disabled) e.disabled = true;
      return e;
    }));
    forceValue = true;
  }
  if (forceValue) applying(() => { sel.value = S.settings.presetId || undefined; });

  // nome rinominato in PTZ Hub: si aggiorna quello salvato (serve per mostrarlo quando PTZ Hub è chiuso)
  const p = S.presets && S.presets.online && S.presets.presets.find((x) => x.id === S.settings.presetId);
  if (p && p.name !== S.settings.presetName && S.client) {
    S.settings = { ...S.settings, presetName: p.name };
    S.client.setSettings(S.settings).catch(() => {});
  }
}
