'use strict';
// Prova completa dell'app (Electron) con camera simulata: avvia, salva e richiama
// le inquadrature, apre tutte le schermate e cattura le schermate.
// Uso: xvfb-run electron test/smoke-main.js <cartellaOutput>
//  - PTZ_SMOKE=wizard (con XDG_CONFIG_HOME vuota): primo avvio guidato e Regia senza inquadrature
//  - PTZ_UPDATE_REPO / PTZ_UPDATE_API / PTZ_UPDATE_DELAY_MS: avviso di nuova versione
//  - PTZ_SMOKE=usb (con XDG_CONFIG_HOME vuota e la camera finta di Chromium:
//    --use-fake-device-for-media-stream --use-fake-ui-for-media-stream): camera comandata via USB
//  - PTZ_SMOKE=usb-noptz: come sopra, ma senza il permesso pan/tilt/zoom (camera che non li accetta)
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, session } = require('electron');

const outDir = process.argv[process.argv.length - 1];
const MODE = process.env.PTZ_SMOKE || 'main';
fs.mkdirSync(outDir, { recursive: true });

// file da importare (solo per la conferma «Importare N inquadrature?»: si annulla)
const importFile = path.join(outDir, 'import-prova.json');
fs.writeFileSync(importFile, JSON.stringify({
  version: 1,
  presets: [
    { id: 'a', name: 'Importata 1', pos: { kind: 'visca', pan: { raw: 10, digits: 4 }, tilt: { raw: 0, digits: 4 }, zoom: 0 } },
    { id: 'b', name: 'Importata 2', pos: { kind: 'visca', pan: { raw: 20, digits: 4 }, tilt: { raw: 0, digits: 4 }, zoom: 0 } },
  ],
}));
process.env.PTZ_TEST_IMPORT_FILE = importFile;

const logs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (w, name) => {
  const img = await w.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
};

// registro della console di tutte le finestre (principale, laterale, pannello OBS)
let mainWin = null;
app.on('browser-window-created', (_e, w) => {
  const tag = mainWin ? 'w' : 'main';
  if (!mainWin) mainWin = w;
  w.webContents.on('console-message', (...a) => {
    const ev = a[0];
    const msg = ev && ev.message !== undefined ? `${ev.level}: ${ev.message}` : a.slice(1).join(' ');
    logs.push(`[${tag}] ${msg}`);
  });
  w.webContents.on('preload-error', (_ev, p, err) => logs.push(`PRELOAD ERROR ${p}: ${err}`));
  w.webContents.on('render-process-gone', (_ev, d) => logs.push(`RENDERER GONE ${JSON.stringify(d)}`));
  if (tag === 'main') w.webContents.once('did-finish-load', () => run(w));
});

const UNTRANSLATED = `(() => {
  const keys = new Set(Object.keys(window.I18N.dictionaries.it));
  const out = [];
  const walk = (n) => { if (n.nodeType === 3) { const v = n.textContent.trim(); if (keys.has(v)) out.push(v); } n.childNodes.forEach(walk); };
  walk(document.body);
  document.querySelectorAll('[title],[placeholder],[aria-label]').forEach((el) => {
    [el.title, el.placeholder, el.getAttribute('aria-label')].forEach((v) => { if (v && keys.has(v)) out.push(v); });
  });
  return out;
})()`;

// testi tagliati o che escono dal loro contenitore (elementi visibili con testo)
const OVERFLOW = `(() => {
  const out = [];
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  document.querySelectorAll('button, .row-label, h1, h2, .cam-name, .badge, .chips li, .tag, .seg > button, .s-link, label, .wz-tile b').forEach((el) => {
    if (!vis(el)) return;
    const cs = getComputedStyle(el);
    if (cs.textOverflow === 'ellipsis') return; // taglio voluto, con i puntini
    if (el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== 'visible') out.push((el.id || el.className || el.tagName) + ': ' + el.textContent.trim().slice(0, 40));
  });
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth + 1) out.push('pagina più larga della finestra: ' + doc.scrollWidth);
  return out;
})()`;

// la colonna dei comandi deve stare intera (0 = nessuno scorrimento) e le schede delle inquadrature intere
const CONTROLS_FIT = `(() => {
  const c = document.querySelector('.controls');
  const g = document.querySelector('#presetGrid');
  const card = g.querySelector('.preset');
  return { controlsHidden: c.scrollHeight - c.clientHeight, gridVisible: g.clientHeight, cardHeight: card ? card.offsetHeight : 0 };
})()`;

async function run(win) {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const waitFor = async (code, ms = 10000, step = 200) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // eslint-disable-next-line no-await-in-loop
      if (await js(code)) return true;
      // eslint-disable-next-line no-await-in-loop
      await sleep(step);
    }
    return false;
  };
  const result = { mode: MODE };
  try {
    if (MODE === 'wizard') await runWizard(win, js, waitFor, result);
    else if (MODE === 'startup') await runStartup(win, js, waitFor, result);
    else if (MODE === 'usb') await runUsb(win, js, waitFor, result);
    else if (MODE === 'usb-noptz') await runUsbNoPtz(win, js, waitFor, result);
    else await runMain(win, js, waitFor, result);
    result.untranslated = await js(UNTRANSLATED);
    result.lang = await js('document.documentElement.lang');
  } catch (e) {
    result.error = String(e && e.stack ? e.stack : e);
  }
  result.consoleErrors = logs.filter((l) => /error|uncaught|failed/i.test(l));
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ result, logs }, null, 2));
  if (MODE === 'usb') {
    // chiusura dalla finestra principale: il programma esce anche con la finestra nascosta USB aperta
    win.close();
    setTimeout(() => app.exit(3), 8000);
  } else {
    app.quit();
  }
}

// ---------------------------------------------------------------------------
// Configurazione normale: Regia, editor, impostazioni, viste ridotte, OBS

async function runMain(win, js, waitFor, result) {
  await sleep(4500);
  win.setBounds({ x: 40, y: 30, width: 1280, height: 820 });
  await sleep(600);
  result.camLabel = await js("document.querySelector('#camLabel').textContent + ' | ' + document.querySelector('#camDetail').textContent");
  result.previewLive = await js("document.querySelector('#liveBadge').classList.contains('on')");
  result.presetsAtStart = await js("document.querySelectorAll('.preset').length");
  await shot(win, '01-regia');
  result.overflowRegia = await js(OVERFLOW);
  result.controlsFit = await js(CONTROLS_FIT);

  // cerchio: tenendo premuto un tasto resta acceso, al rilascio si spegne; Lento / Veloce si salvano
  const wr = await js("(() => { const r = document.querySelector('.wedge.right').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()");
  win.webContents.sendInputEvent({ type: 'mouseDown', x: wr.x, y: wr.y, button: 'left', clickCount: 1 });
  await sleep(600);
  result.wedgeHeld = await js("document.querySelector('.wedge.right').classList.contains('pressed')");
  win.webContents.sendInputEvent({ type: 'mouseUp', x: wr.x, y: wr.y, button: 'left', clickCount: 1 });
  await sleep(200);
  result.wedgeReleased = !(await js("document.querySelector('.wedge.right').classList.contains('pressed')"));
  await js("document.querySelector('#moveSpeedSeg [data-v=fast]').click(); document.querySelector('#zoomSpeedSeg [data-v=fast]').click()");
  await sleep(300);
  result.speedsSaved = await js("window.ptz.init().then((s) => `${s.settings.moveFast}/${s.settings.zoomFast}`)");
  await js("document.querySelector('#moveSpeedSeg [data-v=slow]').click(); document.querySelector('#zoomSpeedSeg [data-v=slow]').click()");
  await sleep(300);

  // tasti rapidi
  await js("document.querySelector('#btnKeys').click()");
  await sleep(300);
  result.keysSheet = await js("document.querySelector('#dlgKeys').open");
  await shot(win, '02-tasti-rapidi');
  await js("document.querySelector('#keysDone').click()");
  await sleep(200);

  // nuova inquadratura: si apre l'editor, si posiziona, si salva
  await js("document.querySelector('#btnSavePreset').click()");
  await sleep(600);
  result.editorOpen = await js("document.body.classList.contains('editing')");
  await js("document.querySelector('#edName').value='Palco largo'");
  await shot(win, '03-editor-nuova');
  result.overflowEditor = await js(OVERFLOW);
  await js("document.querySelector('#edSave').click()");
  await sleep(1200);
  result.presetCount = await js("document.querySelectorAll('.preset').length");
  result.editorClosed = await js("!document.body.classList.contains('editing')");

  // seconda: nell'editor si muove la camera e si salva
  await js("document.querySelector('#btnSavePreset').click()");
  await sleep(500);
  await js("window.ptz.cmd('move', 0.8, 0.2)");
  await sleep(300);
  await js("window.ptz.cmd('move', 0, 0)");
  await js("window.ptz.cmd('zoom', 1)");
  await sleep(200);
  await js("window.ptz.cmd('zoom', 0)");
  await sleep(300);
  await js("document.querySelector('#edName').value='Relatore'; document.querySelector('#edSave').click()");
  await sleep(1200);

  // modifica della prima: l'editor porta la camera lì; conferma di eliminazione (annullata)
  await js("document.querySelectorAll('.preset .edit')[0].click()");
  await sleep(900);
  result.editTitle = await js("document.querySelector('#edTitle').textContent");
  await shot(win, '04-editor-modifica');
  await js("document.querySelector('#edDelete').click()");
  await sleep(400);
  result.deleteConfirm = await js("document.querySelector('#dlgConfirm').open ? document.querySelector('#cfTitle').textContent : ''");
  await shot(win, '05-conferma-elimina');
  await js("document.querySelector('#cfCancel').click()");
  await sleep(300);
  result.stillEditingAfterCancel = await js("document.body.classList.contains('editing')");
  await js("window.ptz.cmd('move', -0.5, 0)");
  await sleep(200);
  await js("window.ptz.cmd('move', 0, 0)");
  await sleep(300);
  await js("document.querySelector('#edName').value='Palco largo (ritoccata)'; document.querySelector('#edSave').click()");
  await sleep(1200);

  // richiamo con il tasto 1
  await js("window.dispatchEvent(new KeyboardEvent('keydown', {key:'1', code:'Digit1'}))");
  await sleep(700);
  result.activeAfterKey1 = await js("document.querySelector('.preset.active .name')?.textContent");
  result.activeBadge = await js("document.querySelector('#activeBadge').textContent");
  await js("document.querySelector('#presetGrid').scrollTop = 0");
  await shot(win, '06-inquadrature');

  // con uno slider selezionato i tasti funzionano ancora
  await js("document.querySelectorAll('.preset')[1].click()");
  await sleep(500);
  await js("document.querySelector('#recallSpeed').focus()");
  await js("window.dispatchEvent(new KeyboardEvent('keydown', {key:'1', code:'Digit1'}))");
  await sleep(600);
  result.activeAfterSliderFocus = await js("document.querySelector('.preset.active .name')?.textContent");

  // zoom con '+': il rilascio con Maiusc (tasto '=') deve fermarlo
  await js("window.dispatchEvent(new KeyboardEvent('keydown', {key:'+', code:'Equal'}))");
  await sleep(250);
  await js("window.dispatchEvent(new KeyboardEvent('keyup', {key:'=', code:'Equal', shiftKey:true}))");
  await sleep(400);

  // impostazioni: le cinque sezioni
  await js("document.querySelector('#btnSettings').click()");
  await sleep(600);
  result.settingsOpen = await js("document.body.classList.contains('settings-open')");
  await shot(win, '07-impostazioni-telecamera');
  result.overflowSettings = {};
  result.overflowSettings.camera = await js(OVERFLOW);
  await js("document.querySelector('#btnDetect').click()");
  await waitFor("!document.querySelector('#detectIcon .spinner')", 15000);
  result.detectSummary = await js("document.querySelector('#detectText').textContent");
  result.detectDetected = await js("!document.querySelector('#sDetected').hidden");
  await js("document.querySelector('#detectDetails').open = true");
  result.detectOut = await js("document.querySelector('#discoverOut').innerText");
  await sleep(300);
  await shot(win, '08-rilevamento');
  for (const [sec, name] of [['video', '09-impostazioni-video'], ['presets', '10-impostazioni-inquadrature'], ['external', '11-impostazioni-comandi'], ['general', '12-impostazioni-generale']]) {
    // eslint-disable-next-line no-await-in-loop
    await js(`document.querySelector('.s-link[data-sec="${sec}"]').click()`);
    // eslint-disable-next-line no-await-in-loop
    await sleep(500);
    // eslint-disable-next-line no-await-in-loop
    await shot(win, name);
    // eslint-disable-next-line no-await-in-loop
    result.overflowSettings[sec] = await js(OVERFLOW);
  }
  // anche la parte bassa della sezione Generale
  await js("document.querySelector('#sScroll').scrollTop = 10000");
  await sleep(200);
  await shot(win, '12b-impostazioni-generale-fondo');

  // importa: conferma «Importare N inquadrature?» (annullata)
  await js(`document.querySelector('.s-link[data-sec="presets"]').click()`);
  await js("document.querySelector('#btnImport').click()");
  await waitFor("document.querySelector('#dlgConfirm').open", 4000);
  result.importConfirm = await js("document.querySelector('#cfTitle').textContent + ' | ' + document.querySelector('#cfText').textContent");
  await shot(win, '13-conferma-importa');
  await js("document.querySelector('#cfCancel').click()");
  await sleep(300);
  result.presetsAfterImportCancel = await js("document.querySelectorAll('.preset').length");

  // comandi esterni: nuova chiave (annullata), funzioni e tasti
  await js(`document.querySelector('.s-link[data-sec="external"]').click()`);
  await sleep(300);
  result.apiStatus = await js("document.querySelector('#xStatusTitle').textContent + ' | ' + document.querySelector('#xStatus').textContent");
  await js("document.querySelector('#xNewKey').click()");
  await sleep(400);
  result.newKeyConfirm = await js("document.querySelector('#dlgConfirm').open ? document.querySelector('#cfTitle').textContent : ''");
  await shot(win, '14-conferma-chiave');
  await js("document.querySelector('#cfCancel').click()");
  await sleep(300);
  await js("document.querySelector('#xCommands').click()");
  await sleep(700);
  await shot(win, '15-funzioni-e-tasti');
  await js("document.querySelector('.cmd-row .b-assign').click()");
  await sleep(250);
  result.captureChip = await js("document.querySelector('.cmd-row .key-chip').textContent");
  await shot(win, '15b-funzioni-cattura');
  await js("window.dispatchEvent(new KeyboardEvent('keydown', {key:'q', code:'KeyQ', ctrlKey:true, altKey:true, bubbles:true}))");
  await sleep(900);
  result.assignedKey = await js("document.querySelector('.cmd-row .key-chip').textContent");
  await js("document.querySelector('#cmdFilter button[data-v=\"keyed\"]').click()");
  await sleep(200);
  result.keyedRows = await js("document.querySelectorAll('#cmdTable .cmd-row').length");
  await shot(win, '15c-funzioni-con-tasto');
  await js("document.querySelector('#cmdDone').click()");
  await sleep(200);
  await js("document.querySelector('#btnCancelSettings').click()");
  await sleep(400);
  if (await js("document.querySelector('#dlgConfirm').open")) {
    result.discardAsked = true;
    await js("document.querySelector('#cfOk').click()");
    await sleep(300);
  }
  result.settingsClosed = await js("!document.body.classList.contains('settings-open')");

  // pannello OBS: pagina servita dal programma, aperta come farebbe OBS
  const info = await js('window.ptz.apiInfo()');
  result.obsUrl = info.obsUrl.replace(/k=.*/, 'k=…');
  const dock = new BrowserWindow({ width: 380, height: 800, show: true, webPreferences: { sandbox: true } });
  await dock.loadURL(info.obsUrl);
  await sleep(1500);
  result.dockCards = await dock.webContents.executeJavaScript("document.querySelectorAll('.card').length");
  await dock.webContents.executeJavaScript("document.querySelectorAll('.card')[1].click()");
  await sleep(1000);
  result.activeAfterDock = await js("document.querySelector('.preset.active .name')?.textContent");
  result.dockActive = await dock.webContents.executeJavaScript("document.querySelector('.card.active .name')?.textContent");
  await shot(dock, '16-pannello-obs');

  // "Stream Deck": semplice richiesta all'indirizzo della prima inquadratura
  await new Promise((resolve) => {
    require('http').get(`${info.base}/api/recall/1?k=${info.token}`, (res) => { res.resume(); res.on('end', resolve); });
  });
  await sleep(800);
  result.activeAfterUrl = await js("document.querySelector('.preset.active .name')?.textContent");
  result.dockActiveAfterUrl = await dock.webContents.executeJavaScript("document.querySelector('.card.active .name')?.textContent");
  dock.destroy();

  // aggiornamenti: il finto GitHub (PTZ_UPDATE_API) pubblica una versione più recente
  if (process.env.PTZ_UPDATE_API) {
    result.updatePill = await js("document.querySelector('#updatePill').hidden ? '' : document.querySelector('#btnUpdateText').textContent");
    await shot(win, '17-aggiornamento');
    await js("document.querySelector('#btnUpdateLater').click()");
    result.updatePillAfterLater = await js("document.querySelector('#updatePill').hidden");
    await js("document.querySelector('#btnSettings').click()");
    await sleep(300);
    await js(`document.querySelector('.s-link[data-sec="general"]').click()`);
    await js("document.querySelector('#btnCheckUpdate').click()");
    await sleep(1200);
    result.updateStatusText = await js("document.querySelector('#updStatus').textContent");
    result.updatePillAgain = await js("!document.querySelector('#updatePill').hidden");
    await shot(win, '17b-aggiornamento-impostazioni');
    await js("document.querySelector('#btnCancelSettings').click()");
    await sleep(300);
  }

  // finestra più piccola: niente testi che escono dai bordi
  win.setBounds({ x: 40, y: 30, width: 960, height: 640 });
  await sleep(700);
  await shot(win, '18-regia-960x640');
  result.overflowSmall = await js(OVERFLOW);
  result.controlsFitSmall = await js(CONTROLS_FIT);
  win.setBounds({ x: 40, y: 30, width: 1280, height: 820 });
  await sleep(500);

  // camera che non risponde: porta sbagliata, poi si torna a quella giusta
  await js("window.ptz.saveSettings({ camera: { port: 1299 } })");
  await waitFor("!document.querySelector('#offlineBanner').hidden", 9000);
  result.offlineBanner = await js("!document.querySelector('#offlineBanner').hidden");
  result.offlinePill = await js("document.querySelector('#camStatus').className + ' | ' + document.querySelector('#camDetail').textContent");
  await shot(win, '19-camera-non-risponde');
  await js("document.querySelector('#btnRetry').click()");
  await sleep(500);
  result.retryState = await js("document.querySelector('#btnRetry').textContent");
  await js("window.ptz.saveSettings({ camera: { port: 1259 } })");
  await waitFor("document.querySelector('#offlineBanner').hidden", 8000);
  result.offlineBannerAfterFix = await js("!document.querySelector('#offlineBanner').hidden");

  // vista compatta: colonna stretta sul bordo destro
  await js("document.querySelector('#viewSeg button[data-view=\"compact\"]').click()");
  await sleep(1200);
  result.compactBody = await js("document.body.classList.contains('compact')");
  result.compactBounds = win.getBounds();
  result.compactOnTop = win.isAlwaysOnTop();
  result.compactRows = await js("document.querySelectorAll('#compactList .p-row').length");
  await shot(win, '20-compatta');
  result.overflowCompact = await js(OVERFLOW);
  await js("document.querySelectorAll('#compactList .p-row')[1].click()");
  await sleep(900);
  result.compactActive = await js("document.querySelector('#compactList .p-row.active .p-name')?.textContent");
  await js("window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', code:'Escape'}))");
  await js("document.querySelector('#cSwap').click()");
  await sleep(600);
  result.compactBoundsLeft = win.getBounds();
  await shot(win, '20b-compatta-sinistra');
  await js("document.querySelector('#cSwap').click()");
  await sleep(400);
  await js("document.querySelector('#cOpen').click()");
  await sleep(1000);
  result.fullBoundsBack = win.getBounds();
  result.fullBodyBack = await js("!document.body.classList.contains('compact')");

  // vista laterale: finestra a parte sul bordo, la principale si nasconde
  await js("document.querySelector('#viewSeg button[data-view=\"side\"]').click()");
  await sleep(1800);
  const side = BrowserWindow.getAllWindows().find((w) => w !== win && /side\.html/.test(w.webContents.getURL()));
  result.sideWindow = !!side;
  result.mainVisibleInSide = win.isVisible();
  if (side) {
    const sjs = (code) => side.webContents.executeJavaScript(code, true);
    result.sideClosedBounds = side.getBounds();
    result.sideTab = await sjs("document.querySelector('#tabNum').textContent + ' | ' + document.querySelector('#tabName').textContent");
    await shot(side, '21-laterale-chiusa');
    await sjs("document.querySelector('#tab').dispatchEvent(new MouseEvent('mouseenter'))");
    await sleep(700);
    result.sideOpenBounds = side.getBounds();
    result.sideRows = await sjs("document.querySelectorAll('#pList .p-row').length");
    await shot(side, '22-laterale-aperta');
    result.overflowSide = await sjs(OVERFLOW);
    // richiamo dalla laterale: lo vedono anche la Regia e il centro operativo
    await sjs("document.querySelectorAll('#pList .p-row')[1].click()");
    await sleep(1000);
    result.sideActive = await sjs("document.querySelector('#pList .p-row.active .p-name')?.textContent");
    result.mainActiveFromSide = await js("document.querySelector('.preset.active .name')?.textContent");
    // richiamo da Stream Deck: la laterale si aggiorna
    await new Promise((resolve) => {
      require('http').get(`${info.base}/api/recall/1?k=${info.token}`, (res) => { res.resume(); res.on('end', resolve); });
    });
    await sleep(900);
    result.sideActiveAfterUrl = await sjs("document.querySelector('#pList .p-row.active .p-name')?.textContent");
    await sjs("window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', code:'Escape'}))");
    // tieni aperta e cambia lato
    await sjs("document.querySelector('#sPin').click()");
    await sjs("document.querySelector('#panel').dispatchEvent(new MouseEvent('mouseleave'))");
    await sleep(900);
    result.sideStaysOpenPinned = await sjs("document.body.classList.contains('open')");
    await sjs("document.querySelector('#sSwap').click()");
    await sleep(800);
    result.sideLeftBounds = side.getBounds();
    result.sideLeftClass = await sjs("document.body.className");
    await shot(side, '23-laterale-sinistra');
    await sjs("document.querySelector('#sPin').click()");
    await sjs("document.querySelector('#panel').dispatchEvent(new MouseEvent('mouseleave'))");
    await sleep(1000);
    result.sideCollapsed = await sjs("!document.body.classList.contains('open')");
    result.sideCollapsedBounds = side.getBounds();
    await sjs("document.querySelector('#sSwap').click()");
    await sleep(300);
    result.untranslatedSide = await sjs(UNTRANSLATED);
    await sjs("document.querySelector('#sFull').click()");
    await sleep(1500);
  }
  result.sideGone = !BrowserWindow.getAllWindows().some((w) => w !== win && /side\.html/.test(w.webContents.getURL()));
  result.mainVisibleAfterSide = win.isVisible();
  result.viewAfterSide = await js("document.body.classList.contains('compact') ? 'compact' : 'full'");
  await shot(win, '24-regia-finale');
  result.presetFile = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'preset.json'), 'utf8')).presets.map((p) => ({ name: p.name, thumb: !!p.thumb }));
  result.savedView = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'impostazioni.json'), 'utf8')).view;
}

// ---------------------------------------------------------------------------
// Account nuovo: primo avvio guidato, poi la Regia vuota

async function runWizard(win, js, waitFor, result) {
  const video = process.env.PTZ_SMOKE_VIDEO || '';
  win.setBounds({ x: 40, y: 30, width: 1280, height: 820 });
  await sleep(1500);
  result.wizardOpen = await js("document.body.classList.contains('wizard-open')");
  await shot(win, 'w1-benvenuto-ricerca');
  await waitFor("!document.querySelector('#wzSearchIcon .spinner')", 30000);
  result.searchTitle = await js("document.querySelector('#wzSearchTitle').textContent + ' | ' + document.querySelector('#wzSearchSub').textContent");
  await shot(win, 'w1b-benvenuto-esito');
  // indirizzo scritto a mano
  if (await js("document.querySelector('#wzManual').hidden")) await js("document.querySelector('#wzManualBtn').click()");
  await js("document.querySelector('#wzHost').value = '127.0.0.1'; document.querySelector('#wzCheck').click()");
  await waitFor("!document.querySelector('#wzUse').disabled", 20000);
  await waitFor("!document.querySelector('#wzCheckVideo .spinner')", 60000);
  result.checks = await js("[...document.querySelectorAll('.wz-check')].map((e) => e.innerText.replace(/\\s+/g, ' ').trim())");
  await shot(win, 'w2-verifica');
  result.overflowStep1 = await js(OVERFLOW);
  await js("document.querySelector('#wzUse').click()");
  await waitFor("document.querySelector('.wz-step[data-step=\"2\"]').classList.contains('on')", 5000);
  await sleep(800);
  result.step2Title = await js("document.querySelector('#wzVideoTitle').textContent");
  await shot(win, 'w3-video');
  if (video) {
    await js("document.querySelector('#wzUrlBox').hidden && document.querySelector('#wzChangeUrl').click()");
    await js(`document.querySelector('#wzRtsp').value = ${JSON.stringify(video)}; document.querySelector('#wzTest').click()`);
    await waitFor("!document.querySelector('#wzLive').hidden", 20000);
    await sleep(800);
    result.step2Live = await js("!document.querySelector('#wzLive').hidden");
    result.step2TitleAfter = await js("document.querySelector('#wzVideoTitle').textContent");
    await shot(win, 'w4-video-trovato');
  }
  await js("document.querySelector('#wzContinue').click()");
  await sleep(500);
  result.summary = await js("document.querySelector('#wzSummary').innerText");
  await shot(win, 'w5-pronto');
  result.overflowStep3 = await js(OVERFLOW);
  await js("document.querySelector('#wzOpen').click()");
  await sleep(2500);
  result.wizardClosed = await js("!document.body.classList.contains('wizard-open')");
  result.emptyState = await js("document.querySelector('.empty-state')?.innerText");
  result.camLabel = await js("document.querySelector('#camLabel').textContent + ' | ' + document.querySelector('#camDetail').textContent");
  await shot(win, 'w6-regia-vuota');
  result.overflowEmpty = await js(OVERFLOW);
  // la vista compatta senza inquadrature
  await js("document.querySelector('#viewSeg button[data-view=\"compact\"]').click()");
  await sleep(1000);
  await shot(win, 'w7-compatta-vuota');
  await js("document.querySelector('#cOpen').click()");
  await sleep(800);
  // «Crea la prima inquadratura» apre l'editor
  await js("document.querySelector('#btnFirstPreset').click()");
  await sleep(600);
  result.editorFromEmpty = await js("document.body.classList.contains('editing')");
  await js("document.querySelector('#edCancel').click()");
  await sleep(300);
  const s = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'impostazioni.json'), 'utf8'));
  result.savedCamera = s.camera;
  result.savedPreview = { source: s.preview.source, rtspUrl: s.preview.rtspUrl };
}

// ---------------------------------------------------------------------------
// Avvio nella vista ridotta usata l'ultima volta (impostazioni con view.mode già salvato)

async function runStartup(win, js, waitFor, result) {
  await sleep(3500);
  const others = () => BrowserWindow.getAllWindows().filter((w) => w !== win && /side\.html/.test(w.webContents.getURL()));
  result.startView = await js("document.body.classList.contains('compact') ? 'compact' : 'full'");
  result.mainVisible = win.isVisible();
  result.mainBounds = win.getBounds();
  result.sideAtStart = others().length;
  if (others().length) await shot(others()[0], 's1-avvio-laterale');
  else await shot(win, 's1-avvio');
  // si torna sempre alla vista completa (così la configurazione resta come prima)
  await js("window.ptz.setView('full')");
  await sleep(1200);
  result.afterFull = { visible: win.isVisible(), bounds: win.getBounds(), side: others().length };
}

// ---------------------------------------------------------------------------
// Camera comandata via USB (camera finta di Chromium, che espone pan/tilt/zoom 100–400)

const uvcWindow = () => BrowserWindow.getAllWindows().find((w) => /uvc\.html/.test(w.webContents.getURL()));

// apre l'elenco USB del primo avvio e prova la prima videocamera
async function wizardPickUsb(win, js, waitFor, result) {
  win.setBounds({ x: 40, y: 30, width: 1280, height: 820 });
  await sleep(1200);
  result.wizardOpen = await js("document.body.classList.contains('wizard-open')");
  await waitFor("!document.querySelector('#wzSearchIcon .spinner')", 40000);
  result.searchTitle = await js("document.querySelector('#wzSearchTitle').textContent");
  if (await js("document.querySelector('#wzUsb').hidden")) await js("document.querySelector('#wzUsbBtn').click()");
  await waitFor("document.querySelectorAll('#wzUsbDevices .device').length > 0", 8000);
  result.usbDevices = await js("[...document.querySelectorAll('#wzUsbDevices .device')].map((d) => d.innerText.replace(/\\s+/g, ' ').trim())");
  await js("document.querySelector('#wzUsbDevices .device').click()");
  await waitFor("!!document.querySelector('#wzCheckCmd .r') && !document.querySelector('#wzCheckCmd .spinner')", 10000);
  result.usbChecks = await js("[...document.querySelectorAll('.wz-check')].map((e) => e.innerText.replace(/\\s+/g, ' ').trim())");
  result.usbCheckNote = await js("document.querySelector('#wzCheckNote').hidden ? '' : document.querySelector('#wzCheckNote').textContent");
  result.usbUseEnabled = await js("!document.querySelector('#wzUse').disabled");
}

async function runUsb(win, js, waitFor, result) {
  await wizardPickUsb(win, js, waitFor, result);
  await shot(win, 'u1-primo-avvio-usb');
  result.overflowWizardUsb = await js(OVERFLOW);
  await js("document.querySelector('.wz-scroll').scrollTop = 10000");
  await sleep(200);
  await shot(win, 'u1b-primo-avvio-usb-esito');
  await js("document.querySelector('#wzUse').click()");
  await waitFor("document.querySelector('.wz-step[data-step=\"2\"]').classList.contains('on')", 5000);
  await waitFor("!document.querySelector('#wzLive').hidden", 10000);
  await sleep(700);
  result.step2 = await js("document.querySelector('#wzVideoTitle').textContent + ' | live=' + !document.querySelector('#wzLive').hidden");
  await shot(win, 'u2-video-usb');
  await js("document.querySelector('#wzContinue').click()");
  await sleep(400);
  result.summary = await js("document.querySelector('#wzSummary').innerText");
  await shot(win, 'u3-pronto');
  await js("document.querySelector('#wzOpen').click()");
  await waitFor("document.querySelector('#camStatus').classList.contains('ok')", 10000);
  await sleep(1200);
  result.camLabel = await js("document.querySelector('#camLabel').textContent + ' | ' + document.querySelector('#camDetail').textContent");
  result.previewLive = await js("document.querySelector('#liveBadge').classList.contains('on')");
  const uw = uvcWindow();
  result.hiddenWindow = uw ? { visible: uw.isVisible(), url: path.basename(uw.webContents.getURL()) } : null;
  if (!uw) throw new Error('finestra nascosta USB assente');
  // valori letti direttamente dal track della finestra nascosta (quello che la camera ha ricevuto)
  const trk = () => uw.webContents.executeJavaScript('(() => { const s = track.getSettings(); return { pan: s.pan, tilt: s.tilt, zoom: s.zoom }; })()', true);
  result.trackCaps = await uw.webContents.executeJavaScript('(() => { const c = track.getCapabilities(); return { pan: c.pan, tilt: c.tilt, zoom: c.zoom }; })()', true);
  await shot(win, 'u4-regia-usb');
  result.overflowRegia = await js(OVERFLOW);

  // movimento continuo: destra e su, poi zoom stretto
  const t0 = await trk();
  await js("window.ptz.cmd('move', 1, 0.5)");
  await sleep(600);
  await js("window.ptz.cmd('move', 0, 0)");
  await js("window.ptz.cmd('zoom', 1)");
  await sleep(500);
  await js("window.ptz.cmd('zoom', 0)");
  await sleep(150);
  const t1 = await trk();
  result.move = { before: t0, after: t1, ok: t1.pan > t0.pan && t1.tilt > t0.tilt && t1.zoom > t0.zoom };
  // STOP: dopo il clic la camera non riceve più incrementi
  await js("window.ptz.cmd('move', 1, 0)");
  await sleep(250);
  await js("document.querySelector('#btnStop').click()");
  await sleep(100);
  const s1 = await trk();
  await sleep(600);
  const s2 = await trk();
  result.stop = { atStop: s1.pan, later: s2.pan, ok: s1.pan === s2.pan && s1.pan > t1.pan };

  // due inquadrature dall'editor
  await js("document.querySelector('#btnSavePreset').click()");
  await sleep(600);
  await js("document.querySelector('#edName').value='USB largo'; document.querySelector('#edSave').click()");
  await sleep(1500);
  await js("document.querySelector('#btnSavePreset').click()");
  await sleep(500);
  await js("window.ptz.cmd('move', -1, -0.6)");
  await sleep(500);
  await js("window.ptz.cmd('move', 0, 0)");
  await js("window.ptz.cmd('zoom', -1)");
  await sleep(300);
  await js("window.ptz.cmd('zoom', 0)");
  await sleep(200);
  await js("document.querySelector('#edName').value='USB stretto'; document.querySelector('#edSave').click()");
  await sleep(1500);
  const saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'preset.json'), 'utf8')).presets;
  result.presets = saved.map((p) => ({ name: p.name, protocol: p.protocol, pos: p.pos, thumb: !!p.thumb }));
  const [A, B] = saved;
  const at = (p, v) => v.pan === p.pos.pan && v.tilt === p.pos.tilt && v.zoom === p.pos.zoom;
  await shot(win, 'u5-inquadrature-usb');

  // richiamo con il tasto 1: la camera torna esattamente su A
  await js("window.dispatchEvent(new KeyboardEvent('keydown', {key:'1', code:'Digit1'}))");
  await waitFor("document.querySelector('.preset.active .name')?.textContent === 'USB largo'", 8000);
  const rA = await trk();
  result.recallA = { expected: A.pos, got: rA, ok: at(A, rA) };
  // richiamo dal pannello Inquadrature (clic) su B
  await js("document.querySelectorAll('.preset')[1].click()");
  await waitFor("document.querySelector('.preset.active .name')?.textContent === 'USB stretto'", 8000);
  const rB = await trk();
  result.recallB = { expected: B.pos, got: rB, ok: at(B, rB) };

  // Home: pan e tilt al centro della corsa (la camera finta non ha lo 0), zoom al minimo
  await js("document.querySelector('#btnHome').click()");
  await sleep(2500);
  result.home = await trk();

  // STOP (Esc) durante un richiamo lento: si ferma a metà e «USB largo» non diventa attiva
  const setRecallSpeed = (v) => js(`(() => { const r = document.querySelector('#recallSpeed'); r.value = '${v}'; r.dispatchEvent(new Event('input')); })()`);
  await setRecallSpeed(0.1);
  await js("window.dispatchEvent(new KeyboardEvent('keydown', {key:'1', code:'Digit1'}))");
  await sleep(1200);
  result.arrivingDuringRecall = await js("document.querySelector('.preset.busy .name')?.textContent || ''");
  await js("window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', code:'Escape'}))");
  await sleep(150);
  const m1 = await trk();
  await sleep(800);
  const m2 = await trk();
  result.stopDuringRecall = {
    from: result.home,
    stoppedAt: m1,
    still: m1.pan === m2.pan && m1.tilt === m2.tilt && m1.zoom === m2.zoom,
    moved: m1.pan !== result.home.pan || m1.tilt !== result.home.tilt,
    notAtA: !at(A, m2),
    active: await js("document.querySelector('.preset.active .name')?.textContent || ''"),
    arriving: await js("document.querySelectorAll('.preset.busy').length"),
  };
  await setRecallSpeed(0.7);
  await sleep(600);

  // impostazioni › telecamera: USB scelta, esito della verifica
  await js("document.querySelector('#btnSettings').click()");
  await waitFor("!document.querySelector('#uvcIcon .spinner') && document.querySelector('#uvcOut').children.length > 0", 10000);
  await sleep(300);
  result.settingsUsb = {
    protocol: await js("document.querySelector('#sProtocol').value"),
    device: await js("document.querySelector('#sUvcDevice').selectedOptions[0]?.textContent"),
    verdict: await js("document.querySelector('#uvcText').textContent"),
    lines: await js("[...document.querySelectorAll('#uvcOut .line')].map((l) => l.textContent)"),
    netRowsHidden: await js("getComputedStyle(document.querySelector('#sHost').closest('.row')).display === 'none'"),
    slotDisabled: await js("document.querySelector('#sModeSlot').disabled"),
  };
  await shot(win, 'u6-impostazioni-usb');
  result.overflowSettingsUsb = await js(OVERFLOW);
  await js("document.querySelector('#btnCancelSettings').click()");
  await sleep(400);
  result.discardAsked = await js("document.querySelector('#dlgConfirm').open");
  if (result.discardAsked) { await js("document.querySelector('#cfOk').click()"); await sleep(300); }

  // vista compatta: richiamo dalla colonna
  await js("document.querySelector('#viewSeg button[data-view=\"compact\"]').click()");
  await sleep(1200);
  await js("document.querySelectorAll('#compactList .p-row')[0].click()");
  await waitFor("document.querySelector('#compactList .p-row.active .p-name')?.textContent === 'USB largo'", 8000);
  result.compactRecall = at(A, await trk());
  result.compactName = await js("document.querySelector('#cName').textContent");
  await shot(win, 'u7-compatta-usb');
  await js("document.querySelector('#cOpen').click()");
  await sleep(1000);

  // pannello OBS e indirizzi web (Stream Deck): stesso centro operativo
  const info = await js('window.ptz.apiInfo()');
  const dock = new BrowserWindow({ width: 380, height: 800, show: true, webPreferences: { sandbox: true } });
  await dock.loadURL(info.obsUrl);
  await sleep(1500);
  result.dockCam = await dock.webContents.executeJavaScript("document.querySelector('#cam').textContent + ' | ' + document.querySelector('#camState').textContent");
  await dock.webContents.executeJavaScript("document.querySelectorAll('.card')[1].click()");
  await sleep(1800);
  result.dockRecall = at(B, await trk());
  await shot(dock, 'u8-pannello-obs-usb');
  dock.destroy();
  const get = (p) => new Promise((resolve) => {
    require('http').get(`${info.base}/api/${p}?k=${info.token}`, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(d)); });
  });
  await get('recall/1');
  await sleep(1800);
  result.urlRecall = at(A, await trk());
  const n0 = await trk();
  await get('nudge/right');
  await sleep(600);
  await get('zoom/in');
  await sleep(600);
  const n1 = await trk();
  result.urlNudge = { before: n0, after: n1, ok: n1.pan > n0.pan && n1.zoom > n0.zoom };

  // vista Laterale: la Regia si nasconde e ferma l'anteprima USB, i comandi passano dalla finestra nascosta
  await js("document.querySelector('#viewSeg button[data-view=\"side\"]').click()");
  await sleep(1800);
  const side = BrowserWindow.getAllWindows().find((w) => /side\.html/.test(w.webContents.getURL()));
  result.sideWindow = !!side;
  result.previewStoppedInSide = await js("!document.querySelector('#usbVideo').srcObject");
  if (side) {
    const sjs = (code) => side.webContents.executeJavaScript(code, true);
    await sjs("document.querySelector('#tab').dispatchEvent(new MouseEvent('mouseenter'))");
    await sleep(700);
    result.sideCam = await sjs("document.querySelector('#pCam').textContent");
    await sjs("document.querySelectorAll('#pList .p-row')[1].click()");
    await sleep(2200);
    result.sideRecall = at(B, await trk());
    await shot(side, 'u11-laterale-usb');
    await sjs("document.querySelector('#sFull').click()");
    await sleep(1500);
  }

  // camera «scollegata»: il track finisce e getUserMedia non la trova più
  const uwjs = (code) => uw.webContents.executeJavaScript(code, true);
  const bannerNow = () => js("document.querySelector('#offTitle').textContent + ' | ' + document.querySelector('#offText').textContent + ' | pill: ' + document.querySelector('#camDetail').textContent + ' | ' + document.querySelector('#camStatus').className");
  await uwjs("window.realGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Requested device not found', 'NotFoundError')); track.dispatchEvent(new Event('ended')); true");
  await waitFor("!document.querySelector('#offlineBanner').hidden", 8000);
  await sleep(300);
  result.unplug = await bannerNow();
  await shot(win, 'u9-usb-scollegata');
  // occupata da un altro programma (su Windows di solito OBS): NotReadableError
  await uwjs("navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Could not start video source', 'NotReadableError')); true");
  await waitFor("document.querySelector('#offTitle').textContent.includes('occupata')", 9000);
  await sleep(300);
  result.busy = await bannerNow();
  await shot(win, 'u10-usb-occupata');
  // torna disponibile: con «dispositivi cambiati» si ricollega subito, senza aspettare il tentativo
  await uwjs("navigator.mediaDevices.getUserMedia = window.realGum; navigator.mediaDevices.dispatchEvent(new Event('devicechange')); true");
  const tRe = Date.now();
  await waitFor("document.querySelector('#offlineBanner').hidden && document.querySelector('#camStatus').classList.contains('ok')", 12000, 100);
  result.reconnectMs = Date.now() - tRe;
  result.reconnected = await js("document.querySelector('#camStatus').classList.contains('ok')");
  await js("document.querySelectorAll('.preset')[1].click()");
  await sleep(2200);
  result.recallAfterReconnect = at(B, await trk());
}

async function runUsbNoPtz(win, js, waitFor, result) {
  await wizardPickUsb(win, js, waitFor, result);
  await shot(win, 'n1-primo-avvio-senza-ptz');
  result.overflowWizard = await js(OVERFLOW);
  // si sceglie lo stesso «USB» dalle Impostazioni: l'esito e l'avviso spiegano cosa fare
  await js("document.querySelector('#wzSkip').click()");
  await sleep(600);
  await js("const s = document.querySelector('#sProtocol'); s.value = 'usb'; s.dispatchEvent(new Event('change'))");
  await waitFor("!document.querySelector('#uvcIcon .spinner') && document.querySelector('#uvcText').textContent.length > 0 && !!document.querySelector('#uvcIcon svg')", 10000);
  await sleep(300);
  result.settingsVerdict = await js("document.querySelector('#uvcText').textContent");
  await shot(win, 'n2-impostazioni-senza-ptz');
  result.overflowSettings = await js(OVERFLOW);
  await js("document.querySelector('#btnSaveSettings').click()");
  await sleep(800);
  await waitFor("!document.querySelector('#offlineBanner').hidden", 9000);
  result.banner = await js("document.querySelector('#offTitle').textContent + ' | ' + document.querySelector('#offText').textContent");
  result.pill = await js("document.querySelector('#camLabel').textContent + ' | ' + document.querySelector('#camDetail').textContent");
  result.hiddenWindowClosedTrack = await (async () => {
    const uw = uvcWindow();
    return uw ? uw.webContents.executeJavaScript('track === null', true) : 'nessuna finestra';
  })();
  // i comandi non fanno nulla e non danno errori; salvare un'inquadratura lo spiega
  await js("window.ptz.cmd('move', 1, 1); window.ptz.cmd('zoom', 1); window.ptz.cmd('focus', 1); window.ptz.cmd('focusAuto', false); window.ptz.cmd('onePush'); window.ptz.cmd('home'); window.ptz.cmd('stop')");
  await sleep(300);
  await js("document.querySelector('#btnSavePreset').click()");
  await sleep(700);
  await js("document.querySelector('#edSave').click()");
  await sleep(1200);
  result.saveToast = await js("[...document.querySelectorAll('.toast .tt')].map((x) => x.textContent)");
  await shot(win, 'n3-regia-senza-ptz');
  await js("document.querySelector('#edCancel').click()");
  await sleep(300);
}

// camera che non accetta pan/tilt/zoom: il permesso per il controllo PTZ viene negato
if (MODE === 'usb-noptz') {
  app.whenReady().then(() => {
    session.defaultSession.setPermissionCheckHandler((_wc, perm, _origin, details) => !(perm === 'media' && !(details && details.mediaType)));
  });
}

require('../src/main/main.js');
