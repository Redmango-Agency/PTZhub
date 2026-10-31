// Messaggi tra plugin e Property Inspector.
// PI -> plugin:  { event: 'hello' } | { event: 'getPresets' } | { event: 'testConnection', host, port, key }
// plugin -> PI:  { event: 'status', lang, status, address, camera, presetCount, editing }
//                { event: 'presets', online, presets: [{ id, index, name }] }
//                { event: 'testResult', ok, reason, address, presetCount, camera, error }

import { displayAddress } from '../shared/address.js';

export class PiBridge {
  /**
   * @param {{ conn: import('./connection.js').PtzConnection, send: (payload: object) => Promise<void>|void, getLang: () => string, log?: object }} opts
   */
  constructor({ conn, send, getLang, log }) {
    this.conn = conn;
    this.send = send;
    this.getLang = getLang;
    this.log = log;
    this.current = null; // tasto del Property Inspector aperto (uno alla volta in Stream Deck)
    this.lastStatus = '';
    this.lastPresets = '';
    conn.on('change', () => this.push());
  }

  get open() {
    return this.current !== null;
  }

  /** Il Property Inspector è comparso (o ha salutato): gli si manda tutto. */
  appeared(id = '') {
    this.current = id;
    this.push(true);
  }

  disappeared(id = '') {
    // se nel frattempo si è aperto quello di un altro tasto, resta aperto
    if (this.current === id) this.current = null;
  }

  statusMessage() {
    const { status, state, config } = this.conn;
    return {
      event: 'status',
      lang: this.getLang(),
      status: { state: status.state, reason: status.reason },
      address: displayAddress(config),
      port: config.port,
      camera: state?.camera?.state || '',
      presetCount: state ? state.presets.length : 0,
      editing: !!state?.editing,
    };
  }

  presetsMessage() {
    const { state, status } = this.conn;
    return {
      event: 'presets',
      online: status.state === 'online' && !!state,
      presets: state ? state.presets.map((p) => ({ id: p.id, index: p.index, name: p.name })) : [],
    };
  }

  /** Manda stato ed elenco solo se cambiati (lo stato di PTZ Hub cambia spesso, l'elenco di rado). */
  push(force = false) {
    if (!this.open) return;
    const st = this.statusMessage();
    const sk = JSON.stringify(st);
    if (force || sk !== this.lastStatus) {
      this.lastStatus = sk;
      this._send(st);
    }
    const pr = this.presetsMessage();
    const pk = JSON.stringify(pr);
    if (force || pk !== this.lastPresets) {
      this.lastPresets = pk;
      this._send(pr);
    }
  }

  async handle(payload, id = '') {
    const ev = payload && typeof payload === 'object' ? payload.event : '';
    switch (ev) {
      case 'hello':
        this.appeared(id);
        return;
      case 'getPresets':
        this._send(this.presetsMessage());
        return;
      case 'testConnection': {
        const r = await this.conn.probe(payload);
        this._send({
          event: 'testResult',
          ok: r.ok,
          reason: r.reason || '',
          error: r.error || '',
          address: displayAddress(r.config),
          port: r.config.port,
          presetCount: r.ok ? r.state.presets.length : 0,
          camera: r.ok ? (r.state.camera?.state || '') : '',
        });
        return;
      }
      default:
    }
  }

  _send(msg) {
    try {
      const p = this.send(msg);
      if (p && typeof p.catch === 'function') p.catch((e) => this.log?.warn?.(`sendToPropertyInspector: ${e.message || e}`));
    } catch (e) {
      this.log?.warn?.(`sendToPropertyInspector: ${e.message || e}`);
    }
  }
}
