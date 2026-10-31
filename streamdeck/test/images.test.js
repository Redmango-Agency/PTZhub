import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import {
  commandSvg, escapeXml, fitText, loadingSvg, missingPresetSvg, offlineSvg, presetSvg, textWidth, toDataUri, unassignedPresetSvg,
} from '../src/plugin/images.js';
import { COMMANDS } from '../src/shared/commands.js';
import { imageSize } from '../src/plugin/image-size.js';
import { fakeJpeg } from './helpers/fake-ptz.js';

const require = createRequire(import.meta.url);
await initWasm(fs.readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));

/** L'SVG deve essere valido: resvg lo rifiuta se l'XML è rotto. */
function assertRenders(svg) {
  const png = new Resvg(svg, { font: { loadSystemFonts: false } }).render();
  assert.equal(png.width, 144);
  assert.equal(png.height, 144);
}

const jpeg = fakeJpeg('x');
const thumb = { mime: 'image/jpeg', data: jpeg.toString('base64'), ...imageSize(jpeg) };
const RING = 'stroke="#FF3B30" stroke-width="6"';

test('dimensioni della miniatura lette dall\'intestazione JPEG', () => {
  assert.deepEqual(imageSize(jpeg), { width: 320, height: 180 });
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000400000002008060000', 'hex');
  assert.deepEqual(imageSize(png), { width: 64, height: 32 });
  assert.equal(imageSize(Buffer.from('nope nope nope')), null);
});

test('inquadratura: miniatura a tutto tasto, nome con escape, numero, sfumatura', () => {
  const svg = presetSvg({ number: 3, name: 'Palco & "Coro" <1>', thumb, active: false });
  assert.ok(svg.includes(`xlink:href="data:image/jpeg;base64,${thumb.data}"`), 'miniatura incorporata');
  // 320×180 ritagliata al centro: alta 144, larga 256, spostata di -56
  assert.ok(svg.includes('x="-56" y="0" width="256" height="144"'), 'ritaglio al centro');
  const lines = [...svg.matchAll(/<text[^>]*fill="#FFFFFF"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).filter((s) => s !== '3');
  assert.equal(lines.join(' '), 'Palco &amp; &quot;Coro&quot; &lt;1&gt;', 'nome con escape');
  assert.ok(!svg.includes('<1>'), 'nessun tag non voluto');
  assert.ok(svg.includes('url(#shade)'), 'sfumatura scura in basso');
  assert.ok(/<text[^>]*>3<\/text>/.test(svg), 'numero');
  assert.ok(!svg.includes(RING), 'senza anello se non attiva');
  assertRenders(svg);
});

test('inquadratura attiva: anello rosso e numero su rosso', () => {
  const svg = presetSvg({ number: 1, name: 'Palco', thumb, active: true });
  assert.ok(svg.includes(RING));
  assert.ok(svg.includes('fill="#FF3B30" fill-opacity="1"'), 'distintivo rosso');
  assertRenders(svg);
});

test('senza miniatura: grigio scuro con il numero grande', () => {
  const svg = presetSvg({ number: 12, name: 'Relatore', thumb: null });
  assert.ok(!svg.includes('<image'));
  assert.ok(/font-size="58"[^>]*>12<\/text>/.test(svg));
  assertRenders(svg);
});

test('in modifica: segno con la matita', () => {
  const svg = presetSvg({ number: 1, name: 'Palco', thumb, editing: true });
  assert.ok(svg.includes('#FF9F0A'));
  assertRenders(svg);
});

test('eliminata, da scegliere, in attesa e offline', () => {
  const missing = missingPresetSvg({ lang: 'it' });
  assert.ok(missing.includes('>?</text>') && missing.includes('Eliminata'));
  const off = offlineSvg({ reason: 'badKey', lang: 'it' });
  assert.ok(off.includes('PTZ Hub') && off.includes('chiave errata') && off.includes('#FFD60A'));
  assert.ok(offlineSvg({ reason: 'unreachable', lang: 'en' }).includes('offline'));
  for (const s of [missing, off, unassignedPresetSvg({ lang: 'it' }), loadingSvg()]) assertRenders(s);
});

test('comandi: un\'icona per ognuno, STOP rosso con la scritta bianca', () => {
  const stop = commandSvg({ command: 'stop' });
  assert.ok(stop.includes('#D70015') && stop.includes('>STOP</text>') && stop.includes('fill="#FFFFFF"'));
  const seen = new Set();
  for (const c of COMMANDS) {
    for (const opts of [{}, { offline: true }, { editing: true }]) {
      const svg = commandSvg({ command: c, lang: 'it', ...opts });
      assertRenders(svg);
      if (!opts.offline && !opts.editing) seen.add(svg);
    }
  }
  assert.equal(seen.size, COMMANDS.length, 'immagini diverse per ogni comando');
  assert.ok(commandSvg({ command: 'nudge:left', lang: 'it' }).includes('Sinistra'));
  assert.ok(commandSvg({ command: 'boh' }).includes('STOP'), 'comando sconosciuto = STOP');
});

test('testo: una riga se ci sta, poi due, poi puntini', () => {
  assert.deepEqual(fitText('Palco').lines, ['Palco']);
  const two = fitText('Primo piano del relatore');
  assert.equal(two.lines.length, 2);
  for (const l of two.lines) assert.ok(textWidth(l, two.size) <= 126);
  const long = fitText('Supercalifragilistichespiralidoso-ancora-più-lungo-di-così-davvero');
  assert.equal(long.lines.length, 2);
  assert.ok(long.lines[1].endsWith('…'));
});

test('escape XML e data URI', () => {
  assert.equal(escapeXml(`a&b<c>"d"'e'\u0001`), 'a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;');
  const uri = toDataUri('<svg/>');
  assert.equal(uri, `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`);
});
