import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SseParser } from '../src/plugin/sse.js';

const STREAM = 'event: state\ndata: {"a":1}\n\n: ping\n\nevent: state\r\ndata: {"b":\r\ndata: 2}\r\n\r\ndata: x\rid: 7\r\r';

function collect(chunks) {
  const events = [];
  const comments = [];
  const p = new SseParser({ onEvent: (e) => events.push(e), onComment: (c) => comments.push(c) });
  for (const c of chunks) p.push(c);
  return { events, comments };
}

test('eventi, commenti, righe data multiple e tutti i tipi di a capo', () => {
  const { events, comments } = collect([STREAM]);
  assert.deepEqual(events.map((e) => [e.event, e.data]), [['state', '{"a":1}'], ['state', '{"b":\n2}'], ['message', 'x']]);
  assert.equal(events[2].id, '7');
  assert.deepEqual(comments, ['ping']);
});

test('lo stesso risultato spezzando il flusso in qualsiasi punto', () => {
  const whole = collect([STREAM]).events;
  for (let i = 1; i < STREAM.length; i++) {
    assert.deepEqual(collect([STREAM.slice(0, i), STREAM.slice(i)]).events, whole, `taglio a ${i}`);
  }
  assert.deepEqual(collect([...STREAM]).events, whole, 'un carattere alla volta');
});

test('un blocco senza data non genera eventi; spazio dopo i due punti opzionale', () => {
  const { events } = collect(['event: state\n\nevent:x\ndata:senza-spazio\n\n']);
  assert.deepEqual(events.map((e) => [e.event, e.data]), [['x', 'senza-spazio']]);
});
