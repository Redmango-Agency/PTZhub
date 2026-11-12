/* «Centra qui»: un clic su un punto dell'anteprima porta quel punto al centro dell'immagine.
 * Usato dal processo principale (calcolo dello spostamento) e dall'interfaccia (clic → punto del
 * video vero, inseguimento del punto tra un fotogramma e l'altro), così le due parti fanno gli
 * stessi conti. Tutto qui è puro (niente camera, niente finestre): si prova con test/center.test.js.
 *
 * Come funziona:
 * 1. Il clic si converte nelle coordinate del video vero (u, v da 0 a 1), togliendo le bande nere
 *    dell'anteprima e la rotazione di 180°. Lo scarto dal centro è ox = u − 0,5, oy = v − 0,5.
 * 2. Lo scarto diventa gradi con il campo visivo stimato: orizzontale 60° a zoom minimo, diviso per
 *    il fattore di zoom (stima: fino a 10×, lineare sul valore di zoom della camera); verticale =
 *    orizzontale / rapporto del video. I gradi diventano unità della camera (USB: gradi o secondi
 *    d'arco; VISCA ~14,4 unità per grado; ONVIF: −1…1 = ±180° pan, ±90° tilt).
 * 3. La stima si corregge da sola: dopo lo spostamento l'interfaccia ritrova nel nuovo fotogramma il
 *    pezzetto d'immagine cliccato e misura di quanto si è spostato davvero. Il rapporto tra lo
 *    spostamento voluto e quello ottenuto (con il segno: camera capovolta o specchiata = negativo)
 *    si ricorda per camera e per fascia di zoom (8 fasce), e si fa un altro passo per il resto
 *    (al massimo 3).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CENTER = api;
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const WIDE_FOV = 60; // gradi orizzontali a zoom minimo (tipico delle PTZ da sala)
  const ZOOM_RATIO = 10; // zoom ottico stimato tra minimo e massimo
  const BUCKETS = 8; // fasce di zoom per la taratura
  const VISCA_PER_DEG = 14.4; // unità VISCA per grado (Sony e compatibili, ±170° ≈ ±0x990)
  const VISCA_ZOOM_MAX = 0x4000;

  // VISCA: valori a 4 o 5 cifre esadecimali in complemento a due
  function viscaSigned(raw, digits) {
    const full = 16 ** digits;
    return raw >= full / 2 ? raw - full : raw;
  }
  function viscaRaw(v, digits) {
    const full = 16 ** digits;
    return ((Math.round(v) % full) + full) % full;
  }

  // unità della camera per grado e zoom da 0 (largo) a 1 (stretto)
  // ctx.axes: assi della camera USB ({ pan: {min,max,step}, tilt, zoom })
  function model(pos, ctx = {}) {
    if (!pos) return null;
    if (pos.kind === 'usb') {
      const ax = ctx.axes || {};
      // UVC chiede secondi d'arco, molte camere economiche danno gradi: si capisce dalla corsa
      const per = (a) => (a && a.max - a.min > 7200 ? 3600 : 1);
      const z = ax.zoom;
      const zoomT = z && num(pos.zoom) && z.max > z.min ? clamp((pos.zoom - z.min) / (z.max - z.min), 0, 1) : 0;
      return { panPerDeg: per(ax.pan), tiltPerDeg: per(ax.tilt || ax.pan), zoomT };
    }
    if (pos.kind === 'visca') {
      return { panPerDeg: VISCA_PER_DEG, tiltPerDeg: VISCA_PER_DEG, zoomT: num(pos.zoom) ? clamp(pos.zoom / VISCA_ZOOM_MAX, 0, 1) : 0 };
    }
    if (pos.kind === 'onvif') {
      return { panPerDeg: 1 / 180, tiltPerDeg: 1 / 90, zoomT: num(pos.zoom) ? clamp(pos.zoom, 0, 1) : 0 };
    }
    return null;
  }

  function fovDeg(zoomT) {
    return WIDE_FOV / (1 + (ZOOM_RATIO - 1) * clamp(zoomT || 0, 0, 1));
  }

  function bucketOf(zoomT) {
    return Math.min(BUCKETS - 1, Math.max(0, Math.floor((zoomT || 0) * BUCKETS)));
  }

  // fattore di taratura ricordato (1 = stima pura); cal = { pan: {fascia: f}, tilt: {...} }
  function factor(cal, axis, b) {
    const f = cal && cal[axis] && cal[axis][b];
    return num(f) && f !== 0 ? f : 1;
  }

  // Spostamento in unità della camera per portare al centro il punto a scarto ox, oy (frazioni
  // della larghezza e dell'altezza del video, positivi = a destra / in basso)
  function planStep({ ox, oy, pos, ctx, cal, aspect = 16 / 9, invertPan = false, invertTilt = false }) {
    const m = model(pos, ctx);
    if (!m) return null;
    const b = bucketOf(m.zoomT);
    const fPan = factor(cal, 'pan', b);
    const fTilt = factor(cal, 'tilt', b);
    const fh = fovDeg(m.zoomT);
    const fv = fh / (aspect > 0 ? aspect : 16 / 9);
    const dPanDeg = ox * fh * fPan * (invertPan ? -1 : 1);
    const dTiltDeg = -oy * fv * fTilt * (invertTilt ? -1 : 1); // punto in basso = tilt giù
    return { dPan: dPanDeg * m.panPerDeg, dTilt: dTiltDeg * m.tiltPerDeg, bucket: b, fPan, fTilt, zoomT: m.zoomT };
  }

  const quant = (a, v) => {
    let x = clamp(v, a.min, a.max);
    if (a.step > 0) x = clamp(a.min + Math.round((x - a.min) / a.step) * a.step, a.min, a.max);
    return Number(x.toFixed(6));
  };

  // Nuova posizione assoluta = posizione attuale + spostamento. USB: solo gli assi che cambiano
  // davvero (un asse uguale non si rimanda) e niente fuoco/zoom; null se non cambia niente.
  function applyOffset(pos, dPan, dTilt, ctx = {}) {
    if (!pos) return null;
    if (pos.kind === 'usb') {
      const ax = ctx.axes || {};
      const out = { kind: 'usb' };
      for (const [k, d] of [['pan', dPan], ['tilt', dTilt]]) {
        const a = ax[k];
        if (!a || !num(pos[k]) || !num(d)) continue;
        const q = quant(a, pos[k] + d);
        if (q !== pos[k]) out[k] = q;
      }
      return Object.keys(out).length > 1 ? out : null;
    }
    if (pos.kind === 'visca') {
      const p = Math.round(dPan);
      const t = Math.round(dTilt);
      if (!p && !t) return null;
      const pan = viscaSigned(pos.pan.raw, pos.pan.digits) + p;
      const tilt = viscaSigned(pos.tilt.raw, pos.tilt.digits) + t;
      return {
        ...pos,
        pan: { raw: viscaRaw(pan, pos.pan.digits), digits: pos.pan.digits },
        tilt: { raw: viscaRaw(tilt, pos.tilt.digits), digits: pos.tilt.digits },
      };
    }
    if (pos.kind === 'onvif') {
      if (Math.abs(dPan) < 1e-4 && Math.abs(dTilt) < 1e-4) return null;
      // pan: oltre ±1 si fa il giro (spazio generico ONVIF); tilt fermo ai limiti
      let x = pos.x + dPan;
      if (x > 1) x -= 2;
      if (x < -1) x += 2;
      return { ...pos, x: Number(x.toFixed(5)), y: Number(clamp(pos.y + dTilt, -1, 1).toFixed(5)) };
    }
    return null;
  }

  // Nuovo fattore dalla misura: voluto = −o (il punto doveva arrivare al centro), ottenuto = s.
  // null se la misura non è affidabile (scarto o spostamento troppo piccoli).
  function learnFactor(fUsed, o, s) {
    if (!num(fUsed) || !num(o) || !num(s) || Math.abs(o) < 0.03 || Math.abs(s) < 0.01) return null;
    const f = fUsed * (-o / s);
    const mag = clamp(Math.abs(f), 0.1, 10);
    return Number((Math.sign(f) * mag).toFixed(4));
  }

  // Clic (x, y in pixel dentro l'anteprima larga W×H) → punto del video vero (u, v da 0 a 1),
  // tenendo conto delle bande nere (video adattato senza tagli) e della rotazione di 180°.
  // null se il clic cade sulle bande.
  function toSource(x, y, W, H, sw, sh, rotate180 = false) {
    if (!(W > 0 && H > 0 && sw > 0 && sh > 0)) return null;
    const s = Math.min(W / sw, H / sh);
    const dw = sw * s;
    const dh = sh * s;
    const dx = (W - dw) / 2;
    const dy = (H - dh) / 2;
    let u = (x - dx) / dw;
    let v = (y - dy) / dh;
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    if (rotate180) { u = 1 - u; v = 1 - v; }
    return { u, v };
  }

  // ---- inseguimento del punto cliccato (immagini in grigio { w, h, data }) ----

  // pezzetto quadrato attorno a (u, v); null se troppo uniforme per essere ritrovato
  function patchAt(img, u, v, half) {
    const cx = Math.round(u * (img.w - 1));
    const cy = Math.round(v * (img.h - 1));
    const x0 = clamp(cx - half, 0, img.w - 2 * half - 1);
    const y0 = clamp(cy - half, 0, img.h - 2 * half - 1);
    const n = 2 * half + 1;
    const data = new Float32Array(n * n);
    let sum = 0;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const p = img.data[(y0 + y) * img.w + x0 + x];
      data[y * n + x] = p;
      sum += p;
    }
    const mean = sum / (n * n);
    let sq = 0;
    for (let i = 0; i < data.length; i++) { data[i] -= mean; sq += data[i] * data[i]; }
    const std = Math.sqrt(sq / data.length);
    if (std < 4) return null; // muro bianco, cielo…: niente da inseguire
    // posizione del punto dentro il pezzetto (vicino ai bordi il pezzetto non è centrato)
    return { n, data, norm: Math.sqrt(sq), offX: cx - x0, offY: cy - y0, w: img.w, h: img.h };
  }

  // cerca il pezzetto in tutta l'immagine (correlazione normalizzata); { u, v, score }
  function findPatch(img, pt) {
    if (!pt || img.w !== pt.w || img.h !== pt.h) return null;
    const { n } = pt;
    let best = -2;
    let bx = 0;
    let by = 0;
    for (let y0 = 0; y0 + n <= img.h; y0++) {
      for (let x0 = 0; x0 + n <= img.w; x0++) {
        let s = 0;
        let sum = 0;
        let sq = 0;
        for (let y = 0; y < n; y++) {
          const row = (y0 + y) * img.w + x0;
          for (let x = 0; x < n; x++) {
            const p = img.data[row + x];
            s += p * pt.data[y * n + x];
            sum += p;
            sq += p * p;
          }
        }
        const cnt = n * n;
        const varI = sq - (sum * sum) / cnt;
        if (varI <= 1e-6) continue;
        const score = s / (Math.sqrt(varI) * pt.norm);
        if (score > best) { best = score; bx = x0; by = y0; }
      }
    }
    if (best < -1) return null;
    return { u: (bx + pt.offX) / (img.w - 1), v: (by + pt.offY) / (img.h - 1), score: best };
  }

  // differenza media tra due immagini in grigio (per capire quando la camera si è fermata)
  function meanDiff(a, b) {
    if (!a || !b || a.data.length !== b.data.length) return Infinity;
    let d = 0;
    for (let i = 0; i < a.data.length; i++) d += Math.abs(a.data[i] - b.data[i]);
    return d / a.data.length;
  }

  // chiave della taratura: la stessa camera (protocollo + indirizzo o nome USB)
  function camKey(cam) {
    const c = cam || {};
    if (c.protocol === 'usb') return `usb|${c.usbLabel || c.usbDeviceId || ''}`.slice(0, 160);
    return `${c.protocol || ''}|${c.host || ''}:${c.port || ''}`.slice(0, 160);
  }

  return {
    model, fovDeg, bucketOf, planStep, applyOffset, learnFactor, toSource,
    patchAt, findPatch, meanDiff, camKey, viscaSigned, viscaRaw, BUCKETS,
  };
}));
