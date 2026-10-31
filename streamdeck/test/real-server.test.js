// Compatibilità con il collegamento esterno VERO di PTZ Hub (../src/main/control.js e hub.js),
// con una telecamera finta. Si salta se il plugin è usato fuori dal repository dell'app.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PtzConnection } from '../src/plugin/connection.js';
import { KeyController } from '../src/plugin/keys.js';
import { freePort, mockAction, waitFor } from './helpers/fake-ptz.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/main');
const available = fs.existsSync(path.join(APP, 'control.js')) && fs.existsSync(path.join(APP, 'hub.js'));
const RING = 'stroke="#FF3B30" stroke-width="6"';

test('plugin contro il ControlServer di PTZ Hub', { skip: !available && 'sorgenti dell\'app non trovati' }, async () => {
  const require = createRequire(import.meta.url);
  const { Hub } = require(path.join(APP, 'hub.js'));
  const { ControlServer } = require(path.join(APP, 'control.js'));

  const moves = [];
  const camera = {
    gotoPosition: async (pos) => { moves.push(pos); },
    recallSlot: async () => {},
    stopAll: () => { moves.push('stop'); },
    home: () => Promise.resolve(),
    move: () => {},
    zoom: () => {},
    focusOnePush: () => {},
  };
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0xb4, 0x01, 0x40, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
  const store = {
    settings: { camera: { host: '10.0.0.9', protocol: 'visca-udp' }, recallSpeed: 0.7, moveSpeed: 0.6 },
    presets: [
      { id: 'p1', name: 'Palco', pos: { kind: 'visca', n: 1 }, thumb: `data:image/jpeg;base64,${jpeg.toString('base64')}`, updatedAt: '11' },
      { id: 'p2', name: 'Relatore', pos: { kind: 'visca', n: 2 } },
    ],
  };
  const hub = new Hub({ store, getCamera: () => camera, getCamStatus: () => ({ state: 'connected', detail: '' }) });
  const server = new ControlServer(hub);
  const port = await freePort();
  const token = 'Tok_en-12345';
  await server.start({ port, lan: false, token });
  const conn = new PtzConnection({ minDelay: 30, maxDelay: 200 });
  const keys = new KeyController({ conn, getLang: () => 'en' });
  try {
    assert.equal(server.status.state, 'on');
    conn.configure({ host: '127.0.0.1', port, key: token });
    const a = mockAction('a');
    const b = mockAction('b');
    keys.add('preset', a, { presetId: 'p1' });
    keys.add('preset', b, { presetId: 'p2' });
    await waitFor(() => a.lastSvg().includes(jpeg.toString('base64')), { what: 'miniatura dal server vero' });
    assert.ok(b.lastSvg().includes('Relatore') && !b.lastSvg().includes('<image'));

    await keys.press('preset', b, { presetId: 'p2' });
    assert.equal(b.calls.ok, 1);
    assert.deepEqual(moves, [{ kind: 'visca', n: 2 }]);
    await waitFor(() => b.lastSvg().includes(RING), { what: 'attiva dopo il richiamo' });

    // modifica in corso nel programma: segno sul tasto, richiamo rifiutato
    hub.setEditing(true);
    await waitFor(() => a.lastSvg().includes('#FF9F0A'), { what: 'segno modifica' });
    await keys.press('preset', a, { presetId: 'p1' });
    assert.equal(a.calls.alert, 1);
    hub.setEditing(false);

    // comandi
    const s = mockAction('s');
    keys.add('command', s, { command: 'stop' });
    await keys.press('command', s, { command: 'stop' });
    assert.equal(s.calls.ok, 1);
    assert.ok(moves.includes('stop'));
    const z = mockAction('z');
    keys.add('command', z, { command: 'zoom:in' });
    await keys.press('command', z, { command: 'zoom:in' });
    assert.equal(z.calls.ok, 1);

    // nuova chiave in PTZ Hub: la vecchia smette di funzionare
    await server.start({ port, lan: false, token: 'nuova-chiave' });
    await waitFor(() => a.lastSvg().includes('wrong key'), { timeout: 4000, what: 'chiave vecchia rifiutata' });
  } finally {
    conn.dispose();
    await server.stop();
  }
});
