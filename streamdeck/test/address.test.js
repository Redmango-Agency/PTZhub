import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  connectHost, displayAddress, hostHeader, normalizeConfig, parsePanelAddress,
} from '../src/shared/address.js';

test('legge host, porta e chiave dall\'indirizzo del pannello OBS', () => {
  assert.deepEqual(parsePanelAddress('http://127.0.0.1:8765/obs?k=Ab3_x-Yz9QwE'), { host: '127.0.0.1', port: 8765, key: 'Ab3_x-Yz9QwE' });
});

test('accetta spazi, virgolette, indirizzo senza http:// e altre porte', () => {
  assert.deepEqual(parsePanelAddress('  "127.0.0.1:9000/obs?k=KEY123"  '), { host: '127.0.0.1', port: 9000, key: 'KEY123' });
  assert.deepEqual(parsePanelAddress('<http://localhost:8765/obs?k=abc&x=1>'), { host: 'localhost', port: 8765, key: 'abc' });
});

test('accetta gli indirizzi dei comandi e la rete locale', () => {
  assert.deepEqual(parsePanelAddress('http://192.168.1.20:8765/api/recall/2?k=zzz'), { host: '192.168.1.20', port: 8765, key: 'zzz' });
  assert.deepEqual(parsePanelAddress('http://[::1]:8765/obs?k=v6'), { host: '::1', port: 8765, key: 'v6' });
});

test('senza chiave o con testo qualsiasi non riconosce nulla', () => {
  assert.equal(parsePanelAddress('http://127.0.0.1:8765/obs'), null);
  assert.equal(parsePanelAddress('ciao come va'), null);
  assert.equal(parsePanelAddress(''), null);
  assert.equal(parsePanelAddress(null), null);
  assert.equal(parsePanelAddress('ftp://127.0.0.1/obs?k=x'), null);
});

test('impostazioni globali: valori predefiniti e pulizia', () => {
  assert.deepEqual(normalizeConfig({}), { host: '127.0.0.1', port: 8765, key: '' });
  assert.deepEqual(normalizeConfig(undefined), { host: '127.0.0.1', port: 8765, key: '' });
  assert.deepEqual(normalizeConfig({ host: ' [::1] ', port: '9001', key: ' k ' }), { host: '::1', port: 9001, key: 'k' });
  assert.equal(normalizeConfig({ port: 'abc' }).port, 8765);
  assert.equal(normalizeConfig({ port: 70000 }).port, 8765);
});

test('Host accettato da PTZ Hub in modalità locale', () => {
  assert.equal(hostHeader('127.0.0.1', 8765), '127.0.0.1:8765');
  assert.equal(hostHeader('localhost', 8765), '127.0.0.1:8765');
  assert.equal(connectHost('LOCALHOST'), '127.0.0.1');
  assert.equal(hostHeader('::1', 80), '[::1]:80');
  assert.equal(displayAddress({ host: '::1', port: 8765 }), '[::1]:8765');
});
