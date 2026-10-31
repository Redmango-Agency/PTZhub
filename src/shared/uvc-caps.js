/* Camere USB (UVC): lettura delle capacità e degli errori di Chromium.
 * Usato sia dal processo principale (driver USB) sia dall'interfaccia (verifica nelle
 * Impostazioni e nel primo avvio), così le due parti danno sempre lo stesso esito. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UVC = api;
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  // intervallo { min, max, step } valido, oppure null (asse assente o non comandabile)
  function range(c) {
    if (!c || typeof c !== 'object') return null;
    const min = Number(c.min);
    const max = Number(c.max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
    const step = Number(c.step);
    return { min, max, step: Number.isFinite(step) && step > 0 ? step : 0 };
  }

  // Capacità di un MediaStreamTrack (getCapabilities) -> assi comandabili.
  // Chromium mostra pan/tilt/zoom solo se la camera li accetta via USB e il permesso è concesso.
  function analyzeCaps(caps) {
    const c = caps && typeof caps === 'object' ? caps : {};
    const focusModes = Array.isArray(c.focusMode) ? c.focusMode.filter((m) => typeof m === 'string') : [];
    const pan = range(c.pan);
    const tilt = range(c.tilt);
    const zoom = range(c.zoom);
    // la distanza di fuoco serve solo se la camera ha anche il fuoco manuale
    const focusDistance = focusModes.includes('manual') ? range(c.focusDistance) : null;
    return {
      pan, tilt, zoom, focusDistance, focusModes,
      move: !!(pan || tilt), // pan o tilt: la testa si muove
      any: !!(pan || tilt || zoom), // almeno un comando utile
    };
  }

  // Valore riportato sulla griglia della camera (min + n·step) e dentro i limiti
  function quantize(r, v) {
    let x = Math.min(r.max, Math.max(r.min, Number(v)));
    if (!Number.isFinite(x)) x = r.min;
    if (r.step > 0) {
      x = r.min + Math.round((x - r.min) / r.step) * r.step;
      if (x > r.max) x -= r.step;
      if (x < r.min) x = r.min;
    }
    return Number(x.toFixed(6));
  }

  // Errore di getUserMedia/applyConstraints -> causa:
  //  busy     = dispositivo occupato (su Windows di solito un altro programma, per esempio OBS)
  //  notfound = camera scollegata o non trovata
  //  denied   = accesso alla camera negato dal sistema
  //  error    = altro
  function classifyError(e) {
    const name = (e && e.name) || '';
    if (['NotReadableError', 'TrackStartError', 'AbortError'].includes(name)) return 'busy';
    if (['NotFoundError', 'DevicesNotFoundError', 'OverconstrainedError', 'ConstraintNotSatisfiedError', 'InvalidStateError'].includes(name)) return 'notfound';
    if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(name)) return 'denied';
    return 'error';
  }

  return { analyzeCaps, quantize, classifyError, range };
}));
