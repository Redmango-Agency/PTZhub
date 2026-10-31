// Plugin Stream Deck per PTZ Hub: collega le azioni dell'SDK al collegamento condiviso.

import streamDeck, { SingletonAction } from '@elgato/streamdeck';
import { PtzConnection } from './connection.js';
import { KeyController, KIND_COMMAND, KIND_PRESET } from './keys.js';
import { PiBridge } from './pi-bridge.js';
import { resolveLang } from '../shared/strings.js';

export const PLUGIN_UUID = 'agency.redmango.ptzhub';
const PRESET_UUID = `${PLUGIN_UUID}.preset`;
const COMMAND_UUID = `${PLUGIN_UUID}.command`;

const log = streamDeck.logger.createScope('PTZ Hub');

let systemLocale = '';
try { systemLocale = Intl.DateTimeFormat().resolvedOptions().locale || ''; } catch (_) { /* nessuna */ }

const conn = new PtzConnection({ log });

function getLang() {
  let sdLang = '';
  try { sdLang = streamDeck.info?.application?.language || ''; } catch (_) { /* non ancora collegato */ }
  return resolveLang({ ptzLang: conn.state?.lang || conn.lastLang, sdLang, systemLocale });
}

const keys = new KeyController({ conn, getLang, log });
const pi = new PiBridge({
  conn,
  getLang,
  log,
  send: (payload) => streamDeck.ui.sendToPropertyInspector(payload),
});

/** Comportamento comune alle due azioni. */
class PtzAction extends SingletonAction {
  constructor(kind, manifestId) {
    super();
    this.kind = kind;
    this.manifestId = manifestId;
  }

  onWillAppear(ev) {
    keys.add(this.kind, ev.action, ev.payload.settings);
  }

  onWillDisappear(ev) {
    keys.remove(ev.action.id);
  }

  onDidReceiveSettings(ev) {
    keys.update(ev.action, ev.payload.settings);
  }

  onKeyDown(ev) {
    return keys.press(this.kind, ev.action, ev.payload.settings).then(() => {}, (e) => log.error(`press: ${e.stack || e}`));
  }

  onPropertyInspectorDidAppear(ev) {
    keys.piOpened(ev.action.id);
    pi.appeared(ev.action.id);
  }

  onPropertyInspectorDidDisappear(ev) {
    keys.piClosed(ev.action.id);
    pi.disappeared(ev.action.id);
  }

  onSendToPlugin(ev) {
    return pi.handle(ev.payload, ev.action.id).catch((e) => log.error(`sendToPlugin: ${e.stack || e}`));
  }
}

streamDeck.actions.registerAction(new PtzAction(KIND_PRESET, PRESET_UUID));
streamDeck.actions.registerAction(new PtzAction(KIND_COMMAND, COMMAND_UUID));

// impostazioni globali (host, porta, chiave), cambiate dal Property Inspector
streamDeck.settings.onDidReceiveGlobalSettings((ev) => {
  if (conn.configure(ev.settings)) log.info('settings changed, reconnecting');
});

await streamDeck.connect();
try {
  conn.configure(await streamDeck.settings.getGlobalSettings());
} catch (e) {
  log.error(`getGlobalSettings: ${e.stack || e}`);
  conn.configure({});
}
