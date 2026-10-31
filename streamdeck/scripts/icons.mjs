// Icone richieste dal manifest, tutte dal marchio di PTZ Hub ("C · Inquadratura", Blu regia:
// angoli del mirino bianchi attorno a un obiettivo, puntino rosso del tally) in assets/brand/.
// Nessuna immagine scaricata. L'icona del plugin deve essere PNG: la si rasterizza con resvg
// (WebAssembly, nessuna dipendenza nativa); le altre restano SVG, come permette il manifest.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { commandSvg, unassignedPresetSvg } from '../src/plugin/images.js';

const require = createRequire(import.meta.url);
const BRAND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/brand');

const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 1024 1024">${body}</svg>`;

/** Icona del plugin: il marchio completo (tassello blu), alla dimensione richiesta. */
export function pluginIconSvg(size) {
  const src = fs.readFileSync(path.join(BRAND, 'icon-full.svg'), 'utf8');
  return src.replace('width="1024" height="1024"', `width="${size}" height="${size}"`);
}

// Angoli del mirino, con i tratti spessi della versione piccola (leggibili a 20–28 px)
const CORNERS = [
  'M170 360 V210 Q170 170 210 170 H360',
  'M664 170 H814 Q854 170 854 210 V360',
  'M854 664 V814 Q854 854 814 854 H664',
  'M360 854 H210 Q170 854 170 814 V664',
];
const corners = (w) => `<g fill="none" stroke="#FFFFFF" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${CORNERS.map((d) => `<path d="${d}"/>`).join('')}</g>`;
// Obiettivo in una sola tinta: anello bianco e pupilla piena
const lens = (ring) => `<circle cx="512" cy="512" r="198" fill="none" stroke="#FFFFFF" stroke-width="${ring}"/><circle cx="512" cy="512" r="78" fill="#FFFFFF"/>`;
const tally = '<circle cx="300" cy="300" r="52" fill="#FFFFFF"/>';

/** Icona della categoria: il marchio in bianco su trasparente (28×28), come chiede Stream Deck. */
export function categoryIconSvg() {
  return svg(28, 28, corners(80) + lens(66) + tally);
}

/** Azione Inquadratura nell'elenco: mirino e obiettivo (20×20, bianco). */
export function presetActionIconSvg() {
  return svg(20, 20, corners(92) + lens(76));
}

/** Azione Comando nell'elenco: mirino con le frecce nelle quattro direzioni (20×20, bianco). */
export function commandActionIconSvg() {
  const s = 'fill="none" stroke="#FFFFFF" stroke-width="72" stroke-linecap="round" stroke-linejoin="round"';
  return svg(20, 20, corners(92)
    + `<path d="M512 292 V732 M292 512 H732" ${s}/>`
    + `<path d="M446 358 L512 292 L578 358 M446 666 L512 732 L578 666 M358 446 L292 512 L358 578 M666 446 L732 512 L666 578" ${s}/>`);
}

/** Immagini predefinite dei tasti (prima che il plugin disegni la sua): 72×72 con dettaglio 144. */
const at72 = (s) => s.replace('width="144" height="144"', 'width="72" height="72"');
export const presetKeySvg = () => at72(unassignedPresetSvg({ lang: 'en' }));
export const commandKeySvg = () => at72(commandSvg({ command: 'stop', lang: 'en' }));

let wasmReady = null;
async function resvg() {
  const mod = await import('@resvg/resvg-wasm');
  if (!wasmReady) wasmReady = mod.initWasm(fs.readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
  await wasmReady;
  return mod;
}

/** SVG -> PNG (larghezza in pixel). fonts: buffer di caratteri, solo se l'SVG contiene testo. */
export async function svgToPng(svgText, width, fonts = []) {
  const { Resvg } = await resvg();
  const r = new Resvg(svgText, {
    fitTo: { mode: 'width', value: width },
    font: { fontBuffers: fonts, loadSystemFonts: false, defaultFontFamily: fonts.length ? undefined : 'sans-serif' },
  });
  return Buffer.from(r.render().asPng());
}
