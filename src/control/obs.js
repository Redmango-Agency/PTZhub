'use strict';
/* Pannello di PTZ Hub per OBS (Pannelli browser personalizzati).
 * Legge inquadrature e stato dal programma in tempo reale e gli manda i comandi:
 * la telecamera la comanda sempre e solo il programma. */
(() => {
  const K = new URLSearchParams(window.location.search).get('k') || '';
  const { t, setLang } = window.I18N;
  const $ = (s) => document.querySelector(s);
  const q = (path, params = {}) => {
    const u = new URLSearchParams({ ...params, k: K });
    return `/api/${path}?${u}`;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let state = null;
  let gridSig = '';
  let lang = null;
  let bannerTimer = null;

  function banner(text, err = false, ms = 0) {
    const el = $('#banner');
    clearTimeout(bannerTimer);
    if (!text) { el.hidden = true; return; }
    el.textContent = text;
    el.className = `banner${err ? ' err' : ''}`;
    el.hidden = false;
    if (ms) bannerTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  async function call(path, params) {
    try {
      const r = await fetch(q(path, params), { method: 'POST', cache: 'no-store' });
      const j = await r.json().catch(() => ({ ok: r.ok }));
      if (!j.ok && j.error) banner(j.error, true, 4000);
      return j;
    } catch (_) {
      banner(t('dock.unreachable'), true);
      return { ok: false };
    }
  }

  function applyLang(code) {
    if (code === lang) return;
    lang = setLang(code || 'it');
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    gridSig = ''; // ridisegna con le nuove etichette
  }

  const CAM_STATE = {
    connected: 'cam.connected', connecting: 'cam.connecting', error: 'cam.noReply', disconnected: 'cam.noReply',
  };

  // miniatura: senza immagine salvata un segnaposto neutro con il numero grande
  function thumb(p) {
    const num = p.index <= 10 ? p.index % 10 : p.index;
    if (!p.hasThumb) return `<div class="thumb placeholder"><span class="big">${num}</span></div>`;
    return `<div class="thumb" style="background-image:url('${q(`presets/${encodeURIComponent(p.id)}/thumb`, { v: p.v })}')">`
      + `<span class="badge">${num}</span></div>`;
  }

  function render() {
    if (!state) return;
    applyLang(state.lang);
    const cam = state.camera || {};
    $('#dot').className = `dot ${cam.host ? (cam.state || '') : ''}`;
    $('#cam').textContent = cam.host ? (cam.name || cam.host) : t('top.notConfigured');
    $('#cam').title = cam.host ? `${cam.host}${cam.detail ? ` — ${cam.detail}` : ''}` : '';
    const st = $('#camState');
    st.textContent = cam.host && CAM_STATE[cam.state] ? t(CAM_STATE[cam.state]) : '';
    st.className = `state${cam.state === 'error' || cam.state === 'disconnected' ? ' bad' : ''}`;
    if (state.editing) banner(t('dock.editing'));
    else if ($('#banner').textContent === t('dock.editing')) banner('');

    const sig = state.presets.map((p) => `${p.id}|${p.name}|${p.v}|${p.hasThumb}`).join(';');
    const grid = $('#grid');
    if (sig !== gridSig) {
      gridSig = sig;
      if (!state.presets.length) {
        grid.innerHTML = `<div class="empty">${esc(t('dock.empty'))}</div>`;
      } else {
        grid.innerHTML = state.presets.map((p) => `<button class="card" data-id="${esc(p.id)}" title="${esc(p.name)}">${thumb(p)}`
          + `<div class="meta"><span class="name">${esc(p.name)}</span></div></button>`).join('');
      }
    }
    grid.querySelectorAll('.card').forEach((el) => el.classList.toggle('active', el.dataset.id === state.activeId));
  }

  $('#grid').addEventListener('click', async (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    card.classList.add('busy');
    await call(`recall/id/${encodeURIComponent(card.dataset.id)}`);
    card.classList.remove('busy');
  });
  $('#stop').addEventListener('click', () => { stopHolds(); call('stop'); });
  $('#home').addEventListener('click', () => call('home'));
  $('#prev').addEventListener('click', () => call('prev'));
  $('#next').addEventListener('click', () => call('next'));

  // --- comandi manuali: il movimento va rinnovato ogni 150 ms, il programma
  // ferma la testa da solo se smette di riceverlo (finestra chiusa, OBS bloccato)
  const vel = { x: 0, y: 0, z: 0 };
  let ticker = null;
  // ogni pannello ha un suo codice e numera i movimenti: il programma scarta quelli arrivati fuori ordine
  const clientId = Math.random().toString(36).slice(2, 10);
  let seq = 0;
  const sendVel = () => call('move', {
    x: vel.x.toFixed(3), y: vel.y.toFixed(3), z: vel.z.toFixed(3), c: clientId, s: ++seq,
  });
  function updateVel() {
    const moving = vel.x || vel.y || vel.z;
    sendVel();
    clearInterval(ticker);
    if (moving) ticker = setInterval(sendVel, 150);
  }
  function stopHolds() {
    vel.x = 0; vel.y = 0; vel.z = 0;
    clearInterval(ticker);
    resetKnob();
    document.querySelectorAll('.hold.pressed').forEach((b) => b.classList.remove('pressed'));
  }
  const speed = () => (state && state.moveSpeed) || 0.6;

  const joy = $('#joy');
  const knob = joy.querySelector('.knob');
  let joyPointer = null;
  function resetKnob() {
    knob.style.transform = 'translate(-50%, -50%)';
    joy.classList.remove('active');
  }
  const shape = (v) => {
    const a = Math.abs(v);
    if (a < 0.1) return 0;
    return Math.sign(v) * ((a - 0.1) / 0.9) ** 1.6;
  };
  function joyUpdate(e) {
    const r = joy.getBoundingClientRect();
    const R = r.width / 2 - 20;
    let dx = (e.clientX - (r.left + r.width / 2)) / R;
    let dy = (e.clientY - (r.top + r.height / 2)) / R;
    const m = Math.hypot(dx, dy);
    if (m > 1) { dx /= m; dy /= m; }
    knob.style.transform = `translate(calc(-50% + ${dx * R}px), calc(-50% + ${dy * R}px))`;
    const nx = shape(dx) * speed();
    const ny = -shape(dy) * speed();
    if (Math.abs(nx - vel.x) > 0.02 || Math.abs(ny - vel.y) > 0.02 || (nx === 0) !== (vel.x === 0) || (ny === 0) !== (vel.y === 0)) {
      vel.x = nx;
      vel.y = ny;
      updateVel();
    }
  }
  joy.addEventListener('pointerdown', (e) => {
    joyPointer = e.pointerId;
    joy.setPointerCapture(e.pointerId);
    joy.classList.add('active');
    joyUpdate(e);
  });
  joy.addEventListener('pointermove', (e) => { if (e.pointerId === joyPointer) joyUpdate(e); });
  const joyEnd = (e) => {
    if (e.pointerId !== joyPointer) return;
    joyPointer = null;
    resetKnob();
    vel.x = 0; vel.y = 0;
    updateVel();
  };
  joy.addEventListener('pointerup', joyEnd);
  joy.addEventListener('pointercancel', joyEnd);
  joy.addEventListener('lostpointercapture', joyEnd);

  document.querySelectorAll('.hold').forEach((b) => {
    const start = (e) => {
      e.preventDefault();
      b.setPointerCapture(e.pointerId);
      b.classList.add('pressed');
      vel.z = Number(b.dataset.z) * speed();
      updateVel();
    };
    const end = () => {
      if (!b.classList.contains('pressed')) return;
      b.classList.remove('pressed');
      vel.z = 0;
      updateVel();
    };
    b.addEventListener('pointerdown', start);
    b.addEventListener('pointerup', end);
    b.addEventListener('pointercancel', end);
    b.addEventListener('lostpointercapture', end);
  });
  window.addEventListener('blur', () => { if (vel.x || vel.y || vel.z) { stopHolds(); sendVel(); } });

  // --- stato in tempo reale
  function connect() {
    const es = new EventSource(q('events'));
    es.addEventListener('state', (ev) => {
      state = JSON.parse(ev.data);
      if ($('#banner').textContent === t('dock.unreachable')) banner('');
      render();
    });
    es.onerror = () => {
      banner(t('dock.unreachable'), true);
      $('#dot').className = 'dot error';
    };
  }
  applyLang(document.documentElement.lang);
  connect();
})();
