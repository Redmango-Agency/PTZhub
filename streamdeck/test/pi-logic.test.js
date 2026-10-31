import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describe as describeStatus, presetOptions } from '../src/pi/logic.js';
import { resolveLang, translate } from '../src/shared/strings.js';

const it = (k, v) => translate('it', k, v);
const en = (k, v) => translate('en', k, v);

test('lingua: segue PTZ Hub, poi Stream Deck o il sistema; predefinito inglese', () => {
  assert.equal(resolveLang({ ptzLang: 'it', sdLang: 'en' }), 'it');
  assert.equal(resolveLang({ ptzLang: 'en', systemLocale: 'it-IT' }), 'en');
  assert.equal(resolveLang({ sdLang: 'en', systemLocale: 'it-IT' }), 'it');
  assert.equal(resolveLang({ sdLang: 'de' }), 'en');
  assert.equal(resolveLang({}), 'en');
});

test('testi del Property Inspector con "PTZ Hub" e il campo dell\'indirizzo OBS', () => {
  assert.ok(it('pi.pasteHint').startsWith('Indirizzo del pannello OBS (incollalo da PTZ Hub)'));
  assert.equal(it('pi.test'), 'Prova collegamento');
  assert.equal(it('pi.connection'), 'Collegamento');
  assert.equal(en('pi.test'), 'Test connection');
  assert.ok(!JSON.stringify([it('pi.footer'), en('pi.footer')]).includes('PTZ Panel'));
});

test('riga di stato', () => {
  const ok = describeStatus({ event: 'status', status: { state: 'online' }, address: '127.0.0.1:8765', presetCount: 5, camera: 'connected' }, it);
  assert.deepEqual(ok, { cls: 'ok', text: 'Collegato a PTZ Hub (127.0.0.1:8765) · 5 inquadrature · camera collegata' });
  const bad = describeStatus({ test: true, ok: false, reason: 'badKey', address: 'x', port: 1 }, it);
  assert.equal(bad.cls, 'err');
  assert.ok(bad.text.startsWith('Chiave errata'));
  const off = describeStatus({ status: { state: 'offline', reason: 'unreachable' }, address: '127.0.0.1:8765' }, en);
  assert.ok(off.text.includes('127.0.0.1:8765'));
  const editing = describeStatus({ status: { state: 'online' }, address: 'a', presetCount: 1, camera: 'error', editing: true }, it);
  assert.ok(editing.text.includes('1 inquadratura') && editing.text.includes('sospesi'));
});

test('elenco inquadrature: "N · Nome", eliminata, PTZ Hub chiuso', () => {
  const msg = { online: true, presets: [{ id: 'a', index: 1, name: 'Palco' }, { id: 'b', index: 2, name: 'Relatore' }] };
  assert.deepEqual(presetOptions(msg, {}, it).map((o) => o.label), ['1 · Palco', '2 · Relatore']);
  const del = presetOptions(msg, { presetId: 'zzz', presetName: 'Vecchia' }, it);
  assert.deepEqual(del.at(-1), { value: 'zzz', label: 'Vecchia (eliminata)' });
  const off = presetOptions({ online: false, presets: [] }, { presetId: 'a', presetName: 'Palco' }, it);
  assert.deepEqual(off.map((o) => [o.value, !!o.disabled]), [['a', false], ['__offline', true]]);
  assert.equal(presetOptions({ online: true, presets: [] }, {}, it)[0].value, '__none');
});
