// Immagini dei tasti, disegnate come SVG 144×144 e mandate a Stream Deck con setImage
// (data:image/svg+xml;base64,…). Solo elementi SVG semplici (rect, path, text, image,
// linearGradient): niente filtri o maschere, che il renderer di Stream Deck può ignorare.
// L'ombra del testo sulle foto è fatta con una copia scura sfalsata.

import { translate } from '../shared/strings.js';
import { normalizeCommand } from '../shared/commands.js';

export const SIZE = 144;
export const FONT = 'Segoe UI, -apple-system, Helvetica, Arial, sans-serif';
export const RED = '#FF3B30';
export const STOP_RED = '#D70015';

// ---- utilità -------------------------------------------------------------------

export function escapeXml(s) {
  return String(s ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

export function toDataUri(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

/** Larghezza stimata del testo (font semibold di sistema): basta per decidere dimensione e a capo. */
export function textWidth(str, size) {
  let em = 0;
  for (const ch of String(str)) {
    if (/[ilI.,:;|!'’`]/.test(ch)) em += 0.27;
    else if (ch === ' ') em += 0.28;
    else if (/[fjtr()[\]{}\-]/.test(ch)) em += 0.37;
    else if (/[mwMW@]/.test(ch)) em += 0.88;
    else if (/[0-9]/.test(ch)) em += 0.57;
    else if (/[A-Z]/.test(ch)) em += 0.66;
    else if (/[a-z]/.test(ch)) em += 0.55;
    else if (/[　-鿿가-힯＀-￯]/.test(ch)) em += 1.0; // CJK
    else em += 0.6;
  }
  return em * size * 1.04;
}

function ellipsize(str, size, max) {
  let s = String(str);
  if (textWidth(s, size) <= max) return s;
  const chars = [...s];
  while (chars.length && textWidth(`${chars.join('').trimEnd()}…`, size) > max) chars.pop();
  return `${chars.join('').trimEnd()}…`;
}

function splitToFit(str, size, max) {
  // il pezzo più lungo che sta in una riga (per parole lunghe senza spazi)
  const chars = [...str];
  let n = chars.length;
  while (n > 1 && textWidth(chars.slice(0, n).join(''), size) > max) n--;
  return [chars.slice(0, n).join(''), chars.slice(n).join('')];
}

/**
 * Dispone un testo in una o due righe: { lines: string[], size }.
 * Prima prova una riga con il carattere più grande possibile, poi due righe bilanciate,
 * infine tronca con "…".
 */
export function fitText(text, { max = 126, one = [20, 19, 18, 17, 16], two = [17, 16, 15, 14] } = {}) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return { lines: [], size: one[0] };
  for (const size of one) if (textWidth(t, size) <= max) return { lines: [t], size };
  const words = t.split(' ');
  for (const size of two) {
    let best = null;
    for (let k = 1; k < words.length; k++) {
      const a = words.slice(0, k).join(' ');
      const b = words.slice(k).join(' ');
      const wa = textWidth(a, size);
      const wb = textWidth(b, size);
      if (wa <= max && wb <= max && (!best || Math.max(wa, wb) < best.w)) best = { lines: [a, b], w: Math.max(wa, wb) };
    }
    if (best) return { lines: best.lines, size };
  }
  // non c'è un a capo che vada bene: prima riga piena, seconda troncata
  const size = two[two.length - 1];
  let first;
  let rest;
  if (words.length > 1 && textWidth(words[0], size) <= max) {
    let k = 1;
    while (k < words.length && textWidth(words.slice(0, k + 1).join(' '), size) <= max) k++;
    first = words.slice(0, k).join(' ');
    rest = words.slice(k).join(' ');
  } else {
    [first, rest] = splitToFit(t, size, max);
  }
  return { lines: [first, ellipsize(rest.trim(), size, max)], size };
}

const attrs = (o) => Object.entries(o)
  .filter(([, v]) => v !== undefined && v !== null && v !== false)
  .map(([k, v]) => `${k}="${v}"`).join(' ');

function text(x, y, str, { size, weight = 600, fill = '#FFFFFF', anchor = 'middle', opacity } = {}) {
  return `<text ${attrs({ x, y, 'text-anchor': anchor, 'font-family': FONT, 'font-size': size, 'font-weight': weight, fill, 'fill-opacity': opacity })}>${escapeXml(str)}</text>`;
}

/** Testo bianco con ombra morbida, leggibile sopra una foto. */
function shadowText(x, y, str, { size, weight = 600, anchor = 'middle' } = {}) {
  const base = { x, 'text-anchor': anchor, 'font-family': FONT, 'font-size': size, 'font-weight': weight };
  return `<text ${attrs({ ...base, y: +(y + 1.5).toFixed(1), fill: '#000000', 'fill-opacity': 0.5, stroke: '#000000', 'stroke-opacity': 0.22, 'stroke-width': 3, 'stroke-linejoin': 'round' })}>${escapeXml(str)}</text>`
    + `<text ${attrs({ ...base, y, fill: '#FFFFFF' })}>${escapeXml(str)}</text>`;
}

function doc(body, defs = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`
    + (defs ? `<defs>${defs}</defs>` : '')
    + body
    + '</svg>';
}

function vGradient(id, stops) {
  return `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">${stops
    .map(([o, c, a = 1]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${a}"/>`).join('')}</linearGradient>`;
}

function background(id, top, bottom) {
  return {
    defs: vGradient(id, [[0, top], [1, bottom]]),
    body: `<rect width="${SIZE}" height="${SIZE}" fill="url(#${id})"/>`,
  };
}

const DARK_BG = ['#48484A', '#2C2C2E'];
const OFF_BG = ['#3A3A3C', '#242426'];
const LIGHT_BG = ['#FFFFFF', '#E5E5EA'];

// ---- elementi comuni ---------------------------------------------------------------

function badge(n, active) {
  const label = String(n);
  const w = 16 + Math.max(1, label.length) * 10;
  return `<rect x="8" y="8" width="${w}" height="28" rx="10" fill="${active ? RED : '#FFFFFF'}" fill-opacity="${active ? 1 : 0.92}"/>`
    + text(8 + w / 2, 28, label, { size: 17, weight: 700, fill: active ? '#FFFFFF' : '#1D1D1F' });
}

function ring(color = RED) {
  return `<rect x="3" y="3" width="138" height="138" rx="17" fill="none" stroke="${color}" stroke-width="6"/>`;
}

function pendingRing() {
  return '<rect x="3" y="3" width="138" height="138" rx="17" fill="none" stroke="#FFFFFF" stroke-opacity="0.85" stroke-width="4" stroke-dasharray="12 8"/>';
}

/** Segno "in modifica": pillola scura con matita arancione, in alto a destra. */
function editingMark(onLight = false) {
  return `<rect x="106" y="8" width="30" height="28" rx="14" fill="${onLight ? '#1D1D1F' : '#000000'}" fill-opacity="${onLight ? 0.78 : 0.55}"/>`
    + '<g transform="translate(114 14)">'
    + '<path d="M1.5 14.5 L2.4 10.6 L10.6 2.4 L13.6 5.4 L5.4 13.6 Z" fill="#FF9F0A"/>'
    + '<path d="M9.1 3.9 L12.1 6.9" stroke="#1D1D1F" stroke-width="1.2"/>'
    + '</g>';
}

/** Piccolo triangolo di avviso; (cx, top) = punta in alto. */
function warning(cx, top, size) {
  const h = size * 0.88;
  const half = size / 2;
  const sw = Math.max(2, size / 9);
  return `<path d="M${cx} ${top} L${cx + half} ${top + h} L${cx - half} ${top + h} Z" fill="#FFD60A" stroke="#FFD60A" stroke-width="${sw}" stroke-linejoin="round"/>`
    + `<rect x="${cx - sw / 2}" y="${top + h * 0.33}" width="${sw}" height="${h * 0.36}" rx="${sw / 2}" fill="#1D1D1F"/>`
    + `<rect x="${cx - sw / 2}" y="${top + h * 0.77}" width="${sw}" height="${sw}" rx="${sw / 2}" fill="#1D1D1F"/>`;
}

/** Nome in basso: una o due righe, ombra se sopra una foto. */
function bottomName(name, onPhoto) {
  const { lines, size } = fitText(name);
  if (!lines.length) return { svg: '', top: SIZE };
  const lh = Math.round(size * 1.12);
  const last = 131;
  const ys = lines.length === 2 ? [last - lh, last] : [last];
  const svg = lines.map((l, i) => (onPhoto ? shadowText(72, ys[i], l, { size }) : text(72, ys[i], l, { size, fill: '#F2F2F7' }))).join('');
  return { svg, top: ys[0] - size };
}

function thumbLayer(thumb) {
  const w = thumb.width || 16;
  const h = thumb.height || 9;
  const s = Math.max(SIZE / w, SIZE / h);
  const dw = +(w * s).toFixed(2);
  const dh = +(h * s).toFixed(2);
  const x = +((SIZE - dw) / 2).toFixed(2);
  const y = +((SIZE - dh) / 2).toFixed(2);
  const mime = /^image\/[a-z0-9.+-]+$/i.test(thumb.mime || '') ? thumb.mime : 'image/jpeg';
  return `<rect width="${SIZE}" height="${SIZE}" fill="#1C1C1E"/>`
    + `<image x="${x}" y="${y}" width="${dw}" height="${dh}" preserveAspectRatio="xMidYMid slice" xlink:href="data:${mime};base64,${thumb.data}"/>`;
}

// ---- tasti "Inquadratura" ------------------------------------------------------------

/**
 * Inquadratura: miniatura a tutto tasto, nome in basso, numero in alto a sinistra,
 * anello rosso se è quella attiva. Senza miniatura: grigio scuro con il numero grande.
 */
export function presetSvg({ number, name, thumb, active = false, editing = false, pending = false }) {
  const parts = [];
  let defs = '';
  if (thumb && thumb.data) {
    parts.push(thumbLayer(thumb));
    const nm = bottomName(name, true);
    if (nm.svg) {
      const start = Math.max(40, nm.top - 26);
      defs += `<linearGradient id="shade" x1="0" y1="${start}" x2="0" y2="${SIZE}" gradientUnits="userSpaceOnUse">`
        + '<stop offset="0" stop-color="#000000" stop-opacity="0"/>'
        + '<stop offset="0.45" stop-color="#000000" stop-opacity="0.38"/>'
        + '<stop offset="1" stop-color="#000000" stop-opacity="0.78"/></linearGradient>';
      parts.push(`<rect x="0" y="${start}" width="${SIZE}" height="${SIZE - start}" fill="url(#shade)"/>`);
    }
    if (editing) parts.push(`<rect width="${SIZE}" height="${SIZE}" fill="#000000" fill-opacity="0.3"/>`);
    parts.push(nm.svg);
    parts.push(badge(number, active));
  } else {
    const bg = background('bg', ...DARK_BG);
    defs += bg.defs;
    parts.push(bg.body);
    const nm = bottomName(name, false);
    const digits = String(number).length;
    const size = digits <= 1 ? 66 : digits === 2 ? 58 : 46;
    const center = nm.svg ? (nm.top < 100 ? 50 : 58) : 72;
    parts.push(text(72, Math.round(center + size * 0.36), String(number), { size, weight: 600, fill: active ? RED : '#FFFFFF' }));
    if (editing) parts.push(`<rect width="${SIZE}" height="${SIZE}" fill="#000000" fill-opacity="0.25"/>`);
    parts.push(nm.svg);
  }
  if (pending && !active) parts.push(pendingRing());
  if (active) parts.push(ring());
  if (editing) parts.push(editingMark());
  return doc(parts.join(''), defs);
}

/** Inquadratura eliminata in PTZ Hub: tasto grigio con "?". */
export function missingPresetSvg({ lang = 'en' } = {}) {
  const bg = background('bg', '#636366', '#48484A');
  return doc(bg.body
    + text(72, 92, '?', { size: 76, weight: 600, fill: '#FFFFFF', opacity: 0.92 })
    + text(72, 128, translate(lang, 'key.deleted'), { size: 15, weight: 600, fill: '#E5E5EA' }), bg.defs);
}

/** Tasto appena messo, senza inquadratura scelta: blu di PTZ Hub con il mirino del marchio e un "+". */
export function unassignedPresetSvg({ lang = 'en' } = {}) {
  const bg = background('bg', '#3D8BFF', '#0047C2');
  const c = 'fill="none" stroke="#FFFFFF" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"';
  return doc(bg.body
    + `<path d="M46 34 V26 Q46 22 50 22 H58 M86 22 H94 Q98 22 98 26 V34 M98 62 V70 Q98 74 94 74 H86 M58 74 H50 Q46 74 46 70 V62" ${c}/>`
    + `<path d="M72 37 V59 M61 48 H83" ${c}/>`
    + text(72, 104, translate(lang, 'key.choose'), { size: 17, fill: '#FFFFFF' })
    + text(72, 125, translate(lang, 'key.choose2'), { size: 17, fill: '#FFFFFF' }), bg.defs);
}

/** In attesa del primo stato da PTZ Hub (dura un attimo). */
export function loadingSvg() {
  const bg = background('bg', ...OFF_BG);
  return doc(bg.body
    + text(72, 78, 'PTZ Hub', { size: 20, fill: '#8E8E93' })
    + '<circle cx="60" cy="96" r="3" fill="#8E8E93"/><circle cx="72" cy="96" r="3" fill="#8E8E93"/><circle cx="84" cy="96" r="3" fill="#8E8E93"/>', bg.defs);
}

/** PTZ Hub non raggiungibile, chiave errata o mancante. */
export function offlineSvg({ reason = 'unreachable', lang = 'en' } = {}) {
  const bg = background('bg', ...OFF_BG);
  const key = {
    badKey: 'key.badKey', noKey: 'key.noKey', forbidden: 'key.forbidden', notPtz: 'key.notPtz', error: 'key.error',
  }[reason] || 'key.offline';
  const sub = fitText(translate(lang, key), { max: 124, one: [14, 13], two: [13, 12] });
  const subSvg = sub.lines.map((l, i) => text(72, 112 + i * 16, l, { size: sub.size, weight: 400, fill: '#AEAEB2' })).join('');
  return doc(bg.body
    + warning(72, 28, 30)
    + text(72, 88, 'PTZ Hub', { size: 22, fill: '#F2F2F7', opacity: 0.92 })
    + subSvg, bg.defs);
}

// ---- tasti "Comando" -------------------------------------------------------------------

const STROKE = 'stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none"';

function rotatePoints(points, deg, cx = 72, cy = 57) {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return points.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    return [+(cx + dx * cos - dy * sin).toFixed(2), +(cy + dx * sin + dy * cos).toFixed(2)];
  });
}

function arrow(deg, color) {
  const stem = rotatePoints([[72, 34], [72, 82]], deg);
  const head = rotatePoints([[50, 56], [72, 34], [94, 56]], deg);
  const d = (pts) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ');
  return `<path d="${d(stem)}" stroke="${color}" ${STROKE}/><path d="${d(head)}" stroke="${color}" ${STROKE}/>`;
}

function glyph(cmd, color) {
  switch (cmd) {
    case 'home':
      return `<path d="M42 58 L72 33 L102 58" stroke="${color}" ${STROKE}/>`
        + `<path d="M51 51 V83 H93 V51" stroke="${color}" ${STROKE}/>`
        + `<path d="M66 83 V68 H78 V83" stroke="${color}" stroke-width="6" stroke-linejoin="round" fill="none"/>`;
    case 'next':
      return `<path d="M50 36 L84 57 L50 78 Z" fill="${color}" stroke="${color}" stroke-width="5" stroke-linejoin="round"/>`
        + `<rect x="88" y="35" width="8" height="44" rx="3" fill="${color}"/>`;
    case 'prev':
      return `<path d="M94 36 L60 57 L94 78 Z" fill="${color}" stroke="${color}" stroke-width="5" stroke-linejoin="round"/>`
        + `<rect x="48" y="35" width="8" height="44" rx="3" fill="${color}"/>`;
    case 'onepush':
      return [
        'M44 44 V34 H56', 'M88 34 H100 V44', 'M100 70 V80 H88', 'M56 80 H44 V70',
      ].map((d) => `<path d="${d}" stroke="${color}" ${STROKE}/>`).join('')
        + `<circle cx="72" cy="57" r="9" fill="${color}"/>`;
    case 'zoom:in':
    case 'zoom:out':
      return `<circle cx="65" cy="52" r="20" stroke="${color}" ${STROKE}/>`
        + `<path d="M80 67 L97 84" stroke="${color}" stroke-width="9" stroke-linecap="round"/>`
        + `<path d="M55 52 H75${cmd === 'zoom:in' ? ' M65 42 V62' : ''}" stroke="${color}" stroke-width="6" stroke-linecap="round"/>`;
    case 'nudge:up': return arrow(0, color);
    case 'nudge:right': return arrow(90, color);
    case 'nudge:down': return arrow(180, color);
    case 'nudge:left': return arrow(270, color);
    default: return '';
  }
}

/**
 * Comando: icona e nome su fondo chiaro; STOP è rosso con la scritta bianca.
 * offline: PTZ Hub non raggiungibile (tasto spento con avviso); editing: il comando
 * è sospeso finché in PTZ Hub si modifica un'inquadratura.
 */
export function commandSvg({ command, lang = 'en', offline = false, editing = false } = {}) {
  const cmd = normalizeCommand(command);
  if (cmd === 'stop') {
    const bg = offline ? background('bg', '#6E1C24', '#4A1218') : background('bg', '#E3172C', STOP_RED);
    const oct = rotatePoints([0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
      const a = ((i * 45 + 22.5) * Math.PI) / 180;
      return [72 + 60 * Math.cos(a), 72 + 60 * Math.sin(a)];
    }), 0, 72, 72).map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
    return doc(bg.body
      + `<path d="${oct} Z" fill="none" stroke="#FFFFFF" stroke-opacity="${offline ? 0.2 : 0.35}" stroke-width="3" stroke-linejoin="round"/>`
      + text(72, 84, 'STOP', { size: 34, weight: 800, fill: '#FFFFFF', opacity: offline ? 0.55 : 1 })
      + (offline ? warning(122, 10, 20) : ''), bg.defs);
  }
  const label = translate(lang, `key.cmd.${cmd}`);
  const fit = fitText(label, { max: 128, one: [19, 18, 17, 16], two: [15] });
  if (offline) {
    const bg = background('bg', ...OFF_BG);
    return doc(bg.body
      + glyph(cmd, '#8E8E93')
      + fit.lines.map((l, i) => text(72, 122 - (fit.lines.length - 1 - i) * 17, l, { size: fit.size, fill: '#8E8E93' })).join('')
      + warning(122, 10, 20), bg.defs);
  }
  const bg = background('bg', ...LIGHT_BG);
  const color = '#1D1D1F';
  return doc(bg.body
    + glyph(cmd, editing ? '#AEAEB2' : color)
    + fit.lines.map((l, i) => text(72, 122 - (fit.lines.length - 1 - i) * 17, l, { size: fit.size, fill: '#3A3A3C' })).join('')
    + (editing ? editingMark(true) : ''), bg.defs);
}
