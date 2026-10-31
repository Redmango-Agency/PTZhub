// Tasti visibili sullo Stream Deck: disegno a ogni cambio di stato e pressione.
// Non dipende dall'SDK: riceve oggetti "azione" con setImage/showOk/showAlert (quelli dell'SDK
// o, nei test, finti).

import { blockedWhileEditing, commandPath, normalizeCommand } from '../shared/commands.js';
import {
  commandSvg, loadingSvg, missingPresetSvg, offlineSvg, presetSvg, toDataUri, unassignedPresetSvg,
} from './images.js';

const noopLog = { debug() {}, info() {}, warn() {}, error() {} };

export const KIND_PRESET = 'preset';
export const KIND_COMMAND = 'command';

export class KeyController {
  /**
   * @param {{ conn: import('./connection.js').PtzConnection, getLang?: () => string, log?: object }} opts
   */
  constructor({ conn, getLang = () => 'en', log = noopLog }) {
    this.conn = conn;
    this.getLang = getLang;
    this.log = log;
    this.keys = new Map(); // id del tasto -> { kind, action, settings, last, pending }
    this.piOpen = new Set();
    conn.on('change', () => this.renderAll());
    conn.on('thumb', (id) => this.renderAll((k) => k.kind === KIND_PRESET && k.settings.presetId === id));
  }

  // ---- tasti visibili -------------------------------------------------------------

  add(kind, action, settings) {
    this.keys.set(action.id, { kind, action, settings: settings || {}, last: null, pending: 0 });
    this._updateWanted();
    this.render(action.id);
  }

  remove(id) {
    this.keys.delete(id);
    this._updateWanted();
  }

  update(action, settings) {
    const k = this.keys.get(action.id);
    if (!k) return;
    k.action = action;
    k.settings = settings || {};
    this.render(action.id);
  }

  /** Property Inspector aperto/chiuso: anche senza tasti visibili serve lo stato (elenco inquadrature). */
  piOpened(id) {
    this.piOpen.add(id);
    this._updateWanted();
  }

  piClosed(id) {
    this.piOpen.delete(id);
    this._updateWanted();
  }

  _updateWanted() {
    this.conn.setWanted(this.keys.size > 0 || this.piOpen.size > 0);
  }

  // ---- disegno -------------------------------------------------------------------

  /** SVG del tasto nello stato attuale. */
  view(k) {
    const lang = this.getLang();
    const { status, state } = this.conn;
    const offline = status.state === 'offline';
    if (k.kind === KIND_COMMAND) {
      return commandSvg({
        command: normalizeCommand(k.settings.command),
        lang,
        offline,
        editing: !offline && !!state?.editing && blockedWhileEditing(k.settings.command),
      });
    }
    if (offline) return offlineSvg({ reason: status.reason, lang });
    if (!state) return loadingSvg({ lang });
    const id = k.settings.presetId;
    if (!id) return unassignedPresetSvg({ lang });
    const p = state.presets.find((x) => x.id === id);
    if (!p) return missingPresetSvg({ lang });
    const thumb = p.hasThumb ? this.conn.thumb(p.id, p.v) : null;
    return presetSvg({
      number: p.index,
      name: p.name,
      thumb,
      active: state.activeId === p.id,
      editing: state.editing,
      pending: k.pending > 0,
      lang,
    });
  }

  render(id) {
    const k = this.keys.get(id);
    if (!k) return;
    if (typeof k.action.isInMultiAction === 'function' && k.action.isInMultiAction()) return;
    let svg;
    try {
      svg = this.view(k);
    } catch (e) {
      this.log.error(`render: ${e.stack || e}`);
      return;
    }
    if (svg === k.last) return; // stessa immagine: non si rimanda
    k.last = svg;
    Promise.resolve(k.action.setImage(toDataUri(svg))).catch((e) => this.log.warn(`setImage: ${e.message || e}`));
  }

  renderAll(filter) {
    for (const [id, k] of this.keys) if (!filter || filter(k)) this.render(id);
  }

  // ---- pressioni --------------------------------------------------------------------

  async press(kind, action, settings) {
    const s = settings || this.keys.get(action.id)?.settings || {};
    return kind === KIND_PRESET ? this._pressPreset(action, s) : this._pressCommand(action, s);
  }

  async _pressPreset(action, s) {
    const id = s.presetId;
    const st = this.conn.state;
    const alert = () => safe(action.showAlert?.());
    if (!id) return alert();
    if (st && st.editing) return alert(); // PTZ Hub rifiuterebbe: si sta modificando un'inquadratura
    if (st && !st.presets.some((p) => p.id === id)) return alert();
    const k = this.keys.get(action.id);
    if (k) { k.pending += 1; this.render(action.id); }
    let r;
    try {
      r = await this.conn.recallId(id);
    } finally {
      if (k) { k.pending = Math.max(0, k.pending - 1); this.render(action.id); }
    }
    if (r.ok) {
      // superato da STOP o da un altro tasto: non è un errore, ma nemmeno un successo da segnalare
      if (!r.superseded) safe(action.showOk?.());
    } else {
      this.log.info(`recall ${id}: ${r.reason} ${r.error || ''}`);
      alert();
      if (r.reason === 'unreachable') this.conn.kick();
    }
    return r;
  }

  async _pressCommand(action, s) {
    const cmd = normalizeCommand(s.command);
    const r = await this.conn.command(commandPath(cmd));
    if (r.ok) safe(action.showOk?.());
    else {
      this.log.info(`${cmd}: ${r.reason} ${r.error || ''}`);
      safe(action.showAlert?.());
      if (r.reason === 'unreachable') this.conn.kick();
    }
    return r;
  }
}

function safe(p) {
  if (p && typeof p.catch === 'function') p.catch(() => {});
}
