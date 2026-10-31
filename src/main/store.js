'use strict';
// Impostazioni e preset salvati nella cartella dati dell'account Windows corrente
// (%APPDATA%\PTZ Hub): ogni account ha i suoi preset.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SETTINGS = {
  camera: {
    host: '',
    name: '', // nome letto dalla rete (ONVIF), solo per mostrarlo: vuoto = si usa il protocollo
    protocol: 'visca-udp', // visca-udp | visca-tcp | visca-sony | onvif
    port: 1259,
    address: 1,
    user: 'admin',
    pass: '',
    invertPan: false,
    invertTilt: false,
  },
  preview: {
    source: 'rtsp', // rtsp | usb | none
    rtspUrl: '',
    usbDeviceId: '',
    width: 960,
    rotate180: false,
    grid: false,
  },
  presetMode: 'app', // app = posizioni salvate nel programma; slot = memorie interne della camera
  slotBase: 10,
  moveSpeed: 0.6,
  recallSpeed: 0.7,
  language: 'auto', // auto = come Windows; oppure 'it' / 'en'
  // collegamento esterno: pannello OBS, Stream Deck, Companion, tastiere macro
  api: {
    enabled: true,
    port: 8765,
    lan: false,
    token: '',
  },
  updates: {
    check: true, // controlla su GitHub se è uscita una nuova versione (avvisa soltanto)
  },
  shortcuts: {}, // funzione -> combinazione globale, es. { "stop": "F13", "preset:<id>": "Control+Alt+Shift+A" }
  alwaysOnTop: false,
  globalHotkeys: false,
  // vista della finestra: completa, compatta (colonna sul bordo) o laterale (linguetta sul bordo)
  view: {
    mode: 'full', // full | compact | side
    side: 'right', // left | right: bordo dello schermo per le viste ridotte
  },
  bounds: null, // posizione e dimensioni della vista completa
};

const VIEW_MODES = ['full', 'compact', 'side'];

const DEFAULT_PORTS = { 'visca-udp': 1259, 'visca-tcp': 5678, 'visca-sony': 52381, onvif: 80 };

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) {
    out[k] = (base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k]))
      ? merge(base[k], over[k])
      : over[k];
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // su Windows antivirus/indicizzazione possono bloccare la rinomina: si copia direttamente
    fs.copyFileSync(tmp, file);
    try { fs.unlinkSync(tmp); } catch (_) { /* ignora */ }
  }
}

// Memoria di partenza diversa per ogni account (modalità "memorie della camera"),
// così due account non si sovrascrivono a vicenda
function slotBaseFor(username) {
  let h = 0;
  for (const ch of String(username || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return [10, 30, 50, 110, 130, 150, 170, 190][h % 8];
}

class Store {
  constructor(dir, sharedDefaultsFile, username) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.settingsFile = path.join(dir, 'impostazioni.json');
    this.presetsFile = path.join(dir, 'preset.json');
    let s = readJson(this.settingsFile);
    if (!s) {
      // primo avvio di questo account: si parte dalla configurazione condivisa, se presente,
      // ma senza ereditare finestra, preferenze personali e memorie di un altro account
      s = (sharedDefaultsFile && readJson(sharedDefaultsFile)) || {};
      delete s.bounds;
      delete s.compact;
      delete s.view;
      delete s.shortcuts; // i tasti fanno riferimento alle inquadrature di un altro account
      if (s.api) delete s.api.token;
      s.slotBase = slotBaseFor(username);
    }
    // versioni fino alla 1.3: "compact" (vista compatta orizzontale) diventa la nuova vista compatta
    const legacyCompact = s.compact === true && !(s.view && s.view.mode);
    delete s.compact;
    this.settings = merge(DEFAULT_SETTINGS, s);
    // oggetto nuovo: merge() può restituire lo stesso oggetto dei valori predefiniti
    const v = this.settings.view || {};
    const mode = legacyCompact ? 'compact' : v.mode;
    this.settings.view = {
      mode: VIEW_MODES.includes(mode) ? mode : 'full',
      side: v.side === 'left' ? 'left' : 'right',
    };
    if (!this.settings.api.token) {
      // chiave dell'account per gli indirizzi esterni: impedisce a pagine web estranee di comandare la camera
      this.settings.api.token = Store.newToken();
      try { writeJsonAtomic(this.settingsFile, this.settings); } catch (_) { /* si riprova al prossimo salvataggio */ }
    }
    const p = readJson(this.presetsFile) || readJson(`${this.presetsFile}.bak`);
    this.presets = Array.isArray(p?.presets) ? p.presets : [];
  }

  static newToken() {
    return crypto.randomBytes(9).toString('base64url');
  }

  saveSettings(partial) {
    this.settings = merge(this.settings, partial);
    // l'elenco dei tasti si sostituisce per intero (così un tasto rimosso sparisce davvero)
    if (partial && partial.shortcuts) this.settings.shortcuts = { ...partial.shortcuts };
    writeJsonAtomic(this.settingsFile, this.settings);
    return this.settings;
  }

  savePresets(list) {
    if (!Array.isArray(list)) throw new Error('elenco preset non valido');
    if (fs.existsSync(this.presetsFile)) {
      try { fs.copyFileSync(this.presetsFile, `${this.presetsFile}.bak`); } catch (_) { /* ignora */ }
    }
    this.presets = list;
    writeJsonAtomic(this.presetsFile, { version: 1, savedAt: new Date().toISOString(), presets: list });
    return list;
  }
}

module.exports = {
  Store, DEFAULT_SETTINGS, DEFAULT_PORTS, VIEW_MODES, merge, slotBaseFor,
};
