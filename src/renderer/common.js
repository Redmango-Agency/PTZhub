'use strict';
/* Funzioni e icone in comune tra la finestra principale e la vista laterale. */
(function (root) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[c]));

  const HOTKEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
  // numero mostrato sull'inquadratura: tasti 1–9 e 0 per le prime dieci, poi la posizione
  const presetNum = (i) => (i < 10 ? HOTKEYS[i] : String(i + 1));

  const PROTOCOL_LABEL = {
    'visca-udp': 'VISCA UDP', 'visca-tcp': 'VISCA TCP', 'visca-sony': 'Sony VISCA', onvif: 'ONVIF', usb: 'USB (UVC)',
  };

  // camera configurata: indirizzo IP per la rete, dispositivo scelto per la USB
  const camConfigured = (cam) => !!cam && (cam.protocol === 'usb' ? !!(cam.usbDeviceId || cam.usbLabel) : !!cam.host);
  // dove si trova la camera, da mostrare accanto al nome: l'IP oppure «USB»
  const camAddress = (cam) => (cam && cam.protocol === 'usb' ? 'USB' : (cam && cam.host) || '');

  // Icone (SVG in linea, colore dal testo: currentColor)
  const S = (w, vb, body, extra = '') => `<svg width="${w}" height="${w}" viewBox="${vb}" aria-hidden="true" focusable="false"${extra}>${body}</svg>`;
  const st = 'fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"';
  const ICONS = {
    // icona dell'app (blu regia: mirino, obiettivo e luce rossa di registrazione)
    app: '<svg width="18" height="18" aria-hidden="true" focusable="false" viewBox="0 0 1024 1024"><defs><linearGradient id="ia-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3D8BFF"/><stop offset="1" stop-color="#0047C2"/></linearGradient><linearGradient id="ia-gs" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity=".22"/><stop offset=".5" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient></defs><rect width="1024" height="1024" rx="232" fill="url(#ia-g)"/><rect width="1024" height="1024" rx="232" fill="url(#ia-gs)"/><g fill="none" stroke="#FFFFFF" stroke-width="78" stroke-linecap="round" stroke-linejoin="round"><path d="M170 360 V210 Q170 170 210 170 H360"/><path d="M664 170 H814 Q854 170 854 210 V360"/><path d="M854 664 V814 Q854 854 814 854 H664"/><path d="M360 854 H210 Q170 854 170 814 V664"/></g><circle cx="512" cy="512" r="230" fill="#FFFFFF"/><circle cx="512" cy="512" r="166" fill="#0047C2"/><circle cx="512" cy="512" r="92" fill="#0B0B0F" opacity=".55"/><circle cx="452" cy="452" r="32" fill="#FFFFFF" opacity=".85"/><circle cx="300" cy="300" r="52" fill="#FF3B30"/></svg>',
    appBig: '<svg width="64" height="64" aria-hidden="true" focusable="false" viewBox="0 0 1024 1024"><defs><linearGradient id="ib-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3D8BFF"/><stop offset="1" stop-color="#0047C2"/></linearGradient><linearGradient id="ib-gs" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity=".22"/><stop offset=".5" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient></defs><rect width="1024" height="1024" rx="232" fill="url(#ib-g)"/><rect width="1024" height="1024" rx="232" fill="url(#ib-gs)"/><g fill="none" stroke="#FFFFFF" stroke-width="56" stroke-linecap="round" stroke-linejoin="round"><path d="M196 366 V236 Q196 196 236 196 H366"/><path d="M658 196 H788 Q828 196 828 236 V366"/><path d="M828 658 V788 Q828 828 788 828 H658"/><path d="M366 828 H236 Q196 828 196 788 V658"/></g><circle cx="512" cy="512" r="196" fill="#FFFFFF"/><circle cx="512" cy="512" r="141" fill="#0047C2"/><circle cx="512" cy="512" r="78" fill="#0B0B0F" opacity=".55"/><circle cx="461" cy="461" r="27" fill="#FFFFFF" opacity=".85"/><circle cx="300" cy="300" r="34" fill="#FF3B30"/></svg>',
    appMid: '<svg width="40" height="40" aria-hidden="true" focusable="false" viewBox="0 0 1024 1024"><defs><linearGradient id="ic-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3D8BFF"/><stop offset="1" stop-color="#0047C2"/></linearGradient><linearGradient id="ic-gs" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity=".22"/><stop offset=".5" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient></defs><rect width="1024" height="1024" rx="232" fill="url(#ic-g)"/><rect width="1024" height="1024" rx="232" fill="url(#ic-gs)"/><g fill="none" stroke="#FFFFFF" stroke-width="56" stroke-linecap="round" stroke-linejoin="round"><path d="M196 366 V236 Q196 196 236 196 H366"/><path d="M658 196 H788 Q828 196 828 236 V366"/><path d="M828 658 V788 Q828 828 788 828 H658"/><path d="M366 828 H236 Q196 828 196 788 V658"/></g><circle cx="512" cy="512" r="196" fill="#FFFFFF"/><circle cx="512" cy="512" r="141" fill="#0047C2"/><circle cx="512" cy="512" r="78" fill="#0B0B0F" opacity=".55"/><circle cx="461" cy="461" r="27" fill="#FFFFFF" opacity=".85"/><circle cx="300" cy="300" r="34" fill="#FF3B30"/></svg>',
    minimize: S(10, '0 0 10 10', '<path d="M0 5h10" stroke="currentColor" stroke-width="1"/>'),
    maximize: S(10, '0 0 10 10', '<rect x=".5" y=".5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor"/>'),
    restore: S(10, '0 0 10 10', '<rect x=".5" y="2.5" width="7" height="7" rx="1.3" fill="none" stroke="currentColor"/><path d="M2.5 2.5V1.8c0-.7.6-1.3 1.3-1.3h4.4c.7 0 1.3.6 1.3 1.3v4.4c0 .7-.6 1.3-1.3 1.3H7.5" fill="none" stroke="currentColor"/>'),
    close: S(10, '0 0 10 10', '<path d="M0 0l10 10M10 0L0 10" stroke="currentColor" stroke-width="1"/>'),
    x: S(9, '0 0 10 10', '<path d="M1 1l8 8M9 1L1 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'),
    user: S(16, '0 0 16 16', `<circle cx="8" cy="5.5" r="3" ${st} stroke-width="1.4"/><path d="M2.5 14c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5" ${st} stroke-width="1.4"/>`),
    download: S(14, '0 0 16 16', `<circle cx="8" cy="8" r="6.5" ${st} stroke-width="1.4"/><path d="M8 4.6v6M5.4 8.2L8 10.8l2.6-2.6" ${st} stroke-width="1.4"/>`),
    sideLeft: S(16, '0 0 16 16', '<rect x="1.5" y="2.5" width="13" height="11" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="3" y="4" width="3.6" height="8" rx="1.2" fill="currentColor"/>'),
    sideRight: S(16, '0 0 16 16', '<rect x="1.5" y="2.5" width="13" height="11" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="9.4" y="4" width="3.6" height="8" rx="1.2" fill="currentColor"/>'),
    pin: S(15, '0 0 16 16', `<path d="M6 2h4l-.6 4 2.6 2.5H4L6.6 6zM8 8.5V14" ${st} stroke-width="1.5"/>`),
    gear: S(16, '0 0 24 24', `<circle cx="12" cy="12" r="3.2" ${st} stroke-width="1.7"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" ${st} stroke-width="1.7"/>`),
    swap: S(14, '0 0 16 16', `<path d="M2.5 5.5h10M10 3l2.5 2.5L10 8M13.5 10.5h-10M6 8l-2.5 2.5L6 13" ${st} stroke-width="1.5"/>`),
    expand: S(13, '0 0 16 16', `<path d="M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9" ${st} stroke-width="1.5"/>`),
    grip: S(10, '0 0 10 14', '<g fill="currentColor"><circle cx="2.5" cy="2.5" r="1.3"/><circle cx="7.5" cy="2.5" r="1.3"/><circle cx="2.5" cy="7" r="1.3"/><circle cx="7.5" cy="7" r="1.3"/><circle cx="2.5" cy="11.5" r="1.3"/><circle cx="7.5" cy="11.5" r="1.3"/></g>'),
    pencil: S(15, '0 0 16 16', `<path d="M11.2 2.3l2.5 2.5-8 8-3.2.7.7-3.2z" ${st} stroke-width="1.3"/>`),
    camera: S(22, '0 0 24 24', `<rect x="3" y="6" width="14" height="12" rx="3" ${st} stroke-width="1.5"/><path d="M17 10l4-2v8l-4-2" ${st} stroke-width="1.5"/>`),
    videoOff: S(44, '0 0 24 24', `<rect x="3" y="6" width="14" height="12" rx="3" ${st} stroke-width="1.5"/><path d="M17 10l4-2v8l-4-2" ${st} stroke-width="1.5"/><path d="M3 4l18 17" ${st} stroke-width="1.5"/>`),
    check: '<svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="8" fill="#34C759"/><path d="M5.2 9.2l2.4 2.4 5-5" fill="none" stroke="#FFFFFF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    fail: '<svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="8" fill="#FF3B30"/><path d="M6.2 6.2l5.6 5.6M11.8 6.2l-5.6 5.6" stroke="#FFFFFF" stroke-width="1.8" stroke-linecap="round"/></svg>',
    warnDot: '<svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="8" fill="#FF9F0A"/><path d="M9 4.8v5" stroke="#FFFFFF" stroke-width="1.9" stroke-linecap="round"/><circle cx="9" cy="12.9" r="1.1" fill="#FFFFFF"/></svg>',
    alert: '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="#FF3B30"/><path d="M10 5.5v5.5" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round"/><circle cx="10" cy="14.2" r="1.2" fill="#FFFFFF"/></svg>',
    spinner: '<span class="spinner" aria-hidden="true"></span>',
    keyboard: S(15, '0 0 24 24', `<rect x="3" y="7" width="18" height="11" rx="3" ${st} stroke-width="1.8"/><path d="M7 11h.01M11 11h.01M15 11h.01M8 15h8" ${st} stroke-width="1.8"/>`),
    link: S(16, '0 0 16 16', `<path d="M6.5 9.5l3-3M7.3 4.6l1-1a2.5 2.5 0 013.6 3.6l-1 1M8.7 11.4l-1 1a2.5 2.5 0 01-3.6-3.6l1-1" ${st} stroke-width="1.5"/>`),
    chevron: '<svg width="8" height="14" viewBox="0 0 8 14" aria-hidden="true"><path d="M1 1l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    trash: S(20, '0 0 24 24', `<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3" ${st} stroke-width="1.8"/>`),
    key: S(20, '0 0 24 24', `<circle cx="8" cy="15" r="4" ${st} stroke-width="1.8"/><path d="M11 12l8-8M16 7l2 2M14 9l2 2" ${st} stroke-width="1.8"/>`),
    importIcon: S(20, '0 0 24 24', `<path d="M12 4v11M7 10l5 5 5-5M5 19h14" ${st} stroke-width="1.8"/>`),
    question: S(20, '0 0 24 24', `<circle cx="12" cy="12" r="9" ${st} stroke-width="1.8"/><path d="M9.5 9.3a2.6 2.6 0 015 .9c0 1.7-2.5 2.1-2.5 3.8M12 17h.01" ${st} stroke-width="1.8"/>`),
    secCamera: S(15, '0 0 24 24', '<rect x="3" y="6" width="14" height="12" rx="3" fill="none" stroke="#FFFFFF" stroke-width="2"/><path d="M17 10l4-2v8l-4-2" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linejoin="round"/>'),
    secVideo: S(15, '0 0 24 24', '<rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="#FFFFFF" stroke-width="2"/><path d="M10 9.5v5l4-2.5z" fill="#FFFFFF"/>'),
    secPresets: S(15, '0 0 24 24', '<rect x="3" y="4" width="8" height="7" rx="2" fill="#FFFFFF"/><rect x="13" y="4" width="8" height="7" rx="2" fill="#FFFFFF"/><rect x="3" y="13" width="8" height="7" rx="2" fill="#FFFFFF"/><rect x="13" y="13" width="8" height="7" rx="2" fill="#FFFFFF"/>'),
    secExternal: S(15, '0 0 24 24', '<rect x="3" y="7" width="18" height="11" rx="3" fill="none" stroke="#FFFFFF" stroke-width="2"/><path d="M7 11h2M11 11h2M15 11h2M8 15h8" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round"/>'),
    secGeneral: S(15, '0 0 24 24', '<circle cx="12" cy="12" r="3" fill="none" stroke="#FFFFFF" stroke-width="2"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round"/>'),
    cross: S(28, '0 0 28 28', '<path d="M14 4v8M14 16v8M4 14h8M16 14h8" stroke="#FFFFFF" stroke-width="1.6" stroke-linecap="round"/>'),
  };

  // Miniatura di un'inquadratura. Senza immagine salvata: segnaposto neutro con il numero
  // grande; con l'immagine: il numero resta come piccolo distintivo (big = false nelle righe).
  function thumbHtml(p, i, { big = true } = {}) {
    const num = esc(presetNum(i));
    // solo immagini incorporate valide: niente testo arbitrario dentro l'attributo style
    if (p && typeof p.thumb === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p.thumb)) {
      return `<span class="thumb has-img" style="background-image:url('${p.thumb}')">`
        + `${big ? `<span class="num-badge">${num}</span>` : `<span class="num-over">${num}</span>`}</span>`;
    }
    return `<span class="thumb placeholder"><span class="ph-glyph">${ICONS.camera}</span><span class="num-big">${num}</span></span>`;
  }

  // Applica le traduzioni agli elementi con data-i18n*
  function applyI18n(t, rootEl = document) {
    rootEl.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    rootEl.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
    rootEl.querySelectorAll('[data-i18n-label]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nLabel)); });
    rootEl.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    rootEl.querySelectorAll('[data-icon]').forEach((el) => {
      if (!el.dataset.iconDone) {
        el.insertAdjacentHTML('afterbegin', ICONS[el.dataset.icon] || '');
        el.dataset.iconDone = '1';
      }
    });
  }

  // Nome della camera da mostrare: quello letto dalla rete oppure il protocollo
  function cameraName(cam) {
    if (!cam) return '';
    return (cam.name && String(cam.name).trim()) || PROTOCOL_LABEL[cam.protocol] || cam.protocol || '';
  }

  // Stato della camera in breve, per la pillola e i puntini colorati
  function camLevel(st, host) {
    if (!host) return 'off';
    if (!st) return 'off';
    if (st.state === 'connected') return 'ok';
    if (st.state === 'connecting') return 'wait';
    return 'bad';
  }

  root.UI = {
    esc, HOTKEYS, presetNum, PROTOCOL_LABEL, ICONS, thumbHtml, applyI18n, cameraName, camLevel, camConfigured, camAddress,
  };
}(typeof self !== 'undefined' ? self : this));
