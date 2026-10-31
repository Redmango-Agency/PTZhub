// Prova completa del plugin compilato (bin/plugin.js con l'SDK dentro) con uno Stream Deck finto:
// un server WebSocket che parla il protocollo di Stream Deck e un PTZ Hub finto.
// Richiede "npm run build" (npm test lo fa da solo).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { FakePtzHub, KEY, fakeJpeg, waitFor } from './helpers/fake-ptz.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILT = path.join(ROOT, 'agency.redmango.ptzhub.sdPlugin');
const UUID = 'agency.redmango.ptzhub';
const RING = 'stroke="#FF3B30" stroke-width="6"';

const svgOf = (m) => Buffer.from(m.payload.image.replace(/^data:image\/svg\+xml;base64,/, ''), 'base64').toString('utf8');

test('plugin compilato: registrazione, tasti, pressione, Property Inspector, impostazioni globali', { skip: !fs.existsSync(path.join(BUILT, 'bin/plugin.js')) && 'esegui prima npm run build' }, async () => {
  // copia del plugin in una cartella temporanea (il plugin scrive i log in ./logs)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptzhub-sd-'));
  fs.cpSync(BUILT, dir, { recursive: true });

  const hub = await new FakePtzHub().start();
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const received = [];
  let sock = null;
  let globalSettings = { host: '127.0.0.1', port: hub.port, key: KEY };
  wss.on('connection', (ws) => {
    sock = ws;
    ws.on('message', (data) => {
      const m = JSON.parse(String(data));
      received.push(m);
      if (m.event === 'getGlobalSettings') {
        ws.send(JSON.stringify({ event: 'didReceiveGlobalSettings', payload: { settings: globalSettings } }));
      }
    });
  });
  const send = (m) => sock.send(JSON.stringify(m));
  const of = (event, context) => received.filter((m) => m.event === event && (!context || m.context === context));

  const info = {
    application: { font: 'Segoe UI', language: 'en', platform: 'windows', platformVersion: '10.0.19045', version: '6.5.0.19001' },
    plugin: { uuid: UUID, version: '1.0.0.0' },
    devicePixelRatio: 2,
    colors: {
      buttonPressedBackgroundColor: '#303030FF', buttonPressedBorderColor: '#646464FF', buttonPressedTextColor: '#969696FF',
      disabledColor: '#F7821B59', highlightColor: '#F7821BFF', mouseDownColor: '#CF6304FF',
    },
    devices: [{ id: 'dev1', name: 'Stream Deck', size: { columns: 5, rows: 3 }, type: 0 }],
  };
  const child = spawn(process.execPath, ['bin/plugin.js', '-port', String(wss.address().port), '-pluginUUID', UUID, '-registerEvent', 'registerPlugin', '-info', JSON.stringify(info)], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });

  try {
    await waitFor(() => received.some((m) => m.event === 'registerPlugin' && m.uuid === UUID), { timeout: 8000, what: `registrazione (${stderr})` });
    await waitFor(() => of('getGlobalSettings').length > 0, { what: 'richiesta impostazioni globali' });

    const appear = (action, context, settings, column) => send({
      action: `${UUID}.${action}`, context, device: 'dev1', event: 'willAppear',
      payload: { controller: 'Keypad', coordinates: { column, row: 0 }, isInMultiAction: false, settings },
    });
    appear('preset', 'ctxA', { presetId: 'aaa' }, 0);
    appear('command', 'ctxS', { command: 'stop' }, 1);

    // il tasto inquadratura riceve la miniatura e il nome
    await waitFor(() => of('setImage', 'ctxA').some((m) => svgOf(m).includes(fakeJpeg('aaa1').toString('base64'))), { what: 'miniatura via setImage' });
    const stopImg = svgOf(of('setImage', 'ctxS').at(-1));
    assert.ok(stopImg.includes('#D70015') && stopImg.includes('STOP'));
    assert.ok(of('setImage', 'ctxA').every((m) => m.payload.image.startsWith('data:image/svg+xml;base64,')));

    // pressione: richiamo con la chiave, showOk, anello rosso con l'evento successivo
    send({ action: `${UUID}.preset`, context: 'ctxA', device: 'dev1', event: 'keyDown', payload: { coordinates: { column: 0, row: 0 }, isInMultiAction: false, settings: { presetId: 'aaa' } } });
    await waitFor(() => of('showOk', 'ctxA').length === 1, { what: 'showOk' });
    assert.equal(hub.requests.find((q) => q.path === '/api/recall/id/aaa').key, KEY);
    await waitFor(() => svgOf(of('setImage', 'ctxA').at(-1)).includes(RING), { what: 'anello rosso' });

    // STOP
    send({ action: `${UUID}.command`, context: 'ctxS', device: 'dev1', event: 'keyDown', payload: { coordinates: { column: 1, row: 0 }, isInMultiAction: false, settings: { command: 'stop' } } });
    await waitFor(() => of('showOk', 'ctxS').length === 1, { what: 'showOk STOP' });
    assert.ok(hub.requests.some((q) => q.path === '/api/stop' && q.method === 'POST'));

    // Property Inspector: elenco inquadrature per la tendina
    send({ action: `${UUID}.preset`, context: 'ctxA', device: 'dev1', event: 'propertyInspectorDidAppear' });
    send({ action: `${UUID}.preset`, context: 'ctxA', event: 'sendToPlugin', payload: { event: 'getPresets' } });
    await waitFor(() => of('sendToPropertyInspector', 'ctxA').some((m) => m.payload.event === 'presets' && m.payload.online), { what: 'elenco al PI' });
    const list = of('sendToPropertyInspector', 'ctxA').filter((m) => m.payload.event === 'presets').at(-1).payload.presets;
    assert.deepEqual(list.map((p) => p.id), ['aaa', 'bbb', 'ccc']);
    const status = of('sendToPropertyInspector', 'ctxA').filter((m) => m.payload.event === 'status').at(-1).payload;
    assert.equal(status.lang, 'it', 'la lingua segue PTZ Hub');

    // impostazioni cambiate nel PI: nuova inquadratura per il tasto
    send({ action: `${UUID}.preset`, context: 'ctxA', device: 'dev1', event: 'didReceiveSettings', payload: { coordinates: { column: 0, row: 0 }, isInMultiAction: false, settings: { presetId: 'bbb' } } });
    await waitFor(() => svgOf(of('setImage', 'ctxA').at(-1)).includes('Relatore'), { what: 'tasto aggiornato' });

    // chiave cambiata nelle impostazioni globali: ci si ricollega e il tasto va offline
    globalSettings = { host: '127.0.0.1', port: hub.port, key: 'sbagliata' };
    send({ event: 'didReceiveGlobalSettings', payload: { settings: globalSettings } });
    // (prima compare per un attimo l'immagine "in collegamento", poi quella offline)
    await waitFor(() => svgOf(of('setImage', 'ctxA').at(-1)).includes('chiave errata'), { what: 'immagine offline' });
    assert.ok(svgOf(of('setImage', 'ctxA').at(-1)).includes('#FFD60A'));

    // tasto nascosto: il plugin non manda più immagini per quel contesto
    send({ action: `${UUID}.preset`, context: 'ctxA', device: 'dev1', event: 'willDisappear', payload: { controller: 'Keypad', coordinates: { column: 0, row: 0 }, isInMultiAction: false, settings: {} } });
    send({ action: `${UUID}.command`, context: 'ctxS', device: 'dev1', event: 'willDisappear', payload: { controller: 'Keypad', coordinates: { column: 1, row: 0 }, isInMultiAction: false, settings: {} } });
    send({ action: `${UUID}.preset`, context: 'ctxA', device: 'dev1', event: 'propertyInspectorDidDisappear' });
    await waitFor(() => hub.clients.size === 0, { what: 'flusso chiuso senza tasti' });
  } finally {
    child.kill();
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    await new Promise((r) => wss.close(r));
    await hub.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
