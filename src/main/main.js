'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const {
  app, BrowserWindow, ipcMain, globalShortcut, dialog, shell, screen, clipboard, net, Menu,
} = require('electron');
const { Store, DEFAULT_PORTS, VIEW_MODES } = require('./store');
const { ViscaCamera } = require('./visca');
const { OnvifCamera, setAuthHints, onAuthHint } = require('./onvif');
const { UvcCamera } = require('./uvc');
const { UvcLink } = require('./uvc-link');
const { UvcNativeLink, helperPath: uvcHelperPath, probeNative: uvcProbeNative } = require('./uvc-native');
const { Preview, testUrl } = require('./preview');
const probe = require('./probe');
const { Hub } = require('./hub');
const { ControlServer } = require('./control');
const I18N = require('../shared/i18n');
const updates = require('./updates');
const { scanCameraApps } = require('./cam-apps');
const PKG = require('../../package.json');

const { t } = I18N;
const IS_MAC = process.platform === 'darwin';
const APP_TITLE = 'PTZ Hub'; // nome mostrato nelle finestre

app.setName(APP_TITLE);
const DATA_DIR = path.join(app.getPath('appData'), 'PTZ Hub');
// Fino alla 1.3 il programma si chiamava PTZ Panel: al primo avvio di PTZ Hub si copiano
// impostazioni e inquadrature dell'account (la vecchia cartella resta come copia di sicurezza).
try {
  const OLD_DATA_DIR = path.join(app.getPath('appData'), 'PTZ Panel');
  if (!fs.existsSync(path.join(DATA_DIR, 'impostazioni.json')) && fs.existsSync(path.join(OLD_DATA_DIR, 'impostazioni.json'))) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // prima le inquadrature, per ultime le impostazioni: sono loro il segnale "copia fatta",
    // così una copia interrotta (antivirus, OneDrive) viene ripetuta al prossimo avvio
    for (const f of ['preset.json.bak', 'preset.json', 'impostazioni.json']) {
      const src = path.join(OLD_DATA_DIR, f);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(DATA_DIR, f);
      fs.copyFileSync(src, `${dst}.tmp`);
      fs.renameSync(`${dst}.tmp`, dst);
    }
  }
} catch (e) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(path.join(DATA_DIR, 'errori.log'), `${new Date().toISOString()} copia da PTZ Panel non riuscita: ${e && e.message}\n`);
  } catch (_) { /* ignora */ }
}
app.setPath('userData', DATA_DIR);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // un'altra copia è già aperta: questa si chiude subito (l'altra viene portata davanti)
  app.exit(0);
}

let win = null;
let sideWin = null; // vista laterale: linguetta sul bordo dello schermo
let store = null;
let camera = null;
let camStatus = { state: 'disconnected', detail: '' };
const preview = new Preview();
let previewStatus = { state: 'off', detail: '' };
let frameInFlight = false;
let frameSentAt = 0;
let normalBounds = null;
let wasMaximized = false;
let currentMode = 'full'; // vista applicata alla finestra in questo momento
let hub = null;
let control = null;
let apiStatus = { state: 'off', detail: '' };
let quitting = false; // arresto in corso (stop alla camera già inviato)
let closingApp = false; // l'utente ha chiesto di uscire: le finestre si chiudono senza riaprirsi

// Aggiornamenti: repository GitHub da cui si scarica il programma (vuoto = controllo spento)
// PTZ_UPDATE_REPO / PTZ_UPDATE_API servono solo ai test automatici
const TEST_ENV = app.isPackaged ? {} : process.env;
const UPDATE_REPO = updates.repoFromPackage(TEST_ENV.PTZ_UPDATE_REPO
  ? { ptzPanel: { updateRepo: TEST_ENV.PTZ_UPDATE_REPO } } : PKG);
const UPDATE_API = TEST_ENV.PTZ_UPDATE_API || updates.API_BASE;
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000; // ogni 6 ore (l'app resta aperta per giorni)
const UPDATE_RETRY_MS = 15 * 60 * 1000; // controllo non riuscito: si riprova presto
const UPDATE_FOCUS_MS = 60 * 60 * 1000;
const APP_VERSION = PKG.version; // come app.getVersion() nel programma installato, anche nei test
let updateStatus = { state: UPDATE_REPO ? 'idle' : 'disabled' };
let updateTimer = null;
let updateRunning = null;
let updateGen = 0; // cambia quando si riprogramma: le catene di controlli vecchie si fermano

// messaggi a tutte le finestre dell'app (principale e laterale)
const send = (ch, data) => {
  for (const w of [win, sideWin]) {
    if (w && !w.isDestroyed()) w.webContents.send(ch, data);
  }
};
// fotogrammi dell'anteprima: solo alla finestra principale
const sendMain = (ch, data) => {
  if (win && !win.isDestroyed()) win.webContents.send(ch, data);
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------------------
// Camera

// aiuto per le camere USB su Windows (resources/uvc/ptzhub-uvc.exe); null altrove o se manca
let uvcExeCache;
function uvcExe() {
  if (uvcExeCache === undefined) uvcExeCache = uvcHelperPath({ packaged: app.isPackaged, resourcesPath: process.resourcesPath });
  return uvcExeCache;
}

function createCamera(cfg) {
  if (cfg.protocol === 'usb') {
    // camera collegata con il cavo USB (UVC, in prova): comandi da una finestra nascosta.
    // Il permesso per pan/tilt/zoom arriva da Electron senza bisogno di un gestore dei permessi
    // (nessuno è impostato: Electron concede la fotocamera e anche il suo controllo PTZ).
    if (!cfg.usbDeviceId && !cfg.usbLabel) return null;
    // Windows: comandi senza aprire il video (ptzhub-uvc.exe), così OBS o Zoom tengono la camera
    const exe = uvcExe();
    return new UvcCamera({
      deviceId: cfg.usbDeviceId || '',
      label: cfg.usbLabel || '',
      invertPan: !!cfg.invertPan,
      invertTilt: !!cfg.invertTilt,
      smooth: cfg.usbSmooth !== false, // movimento a velocità, se la camera lo accetta (Windows)
      link: exe ? new UvcNativeLink({ exe }) : new UvcLink(),
    });
  }
  if (!cfg.host) return null;
  const port = Number(cfg.port) || DEFAULT_PORTS[cfg.protocol] || 1259;
  const common = { host: cfg.host.trim(), port, invertPan: !!cfg.invertPan, invertTilt: !!cfg.invertTilt };
  switch (cfg.protocol) {
    case 'onvif':
      return new OnvifCamera({ ...common, user: cfg.user, pass: cfg.pass });
    case 'visca-tcp':
      return new ViscaCamera({ ...common, mode: 'tcp', address: cfg.address });
    case 'visca-sony':
      return new ViscaCamera({ ...common, mode: 'sony', address: cfg.address });
    default:
      return new ViscaCamera({ ...common, mode: 'udp', address: cfg.address });
  }
}

function startCamera() {
  if (camera) {
    const old = camera;
    old.removeAllListeners();
    Promise.resolve().then(() => old.disconnect()).catch(() => {});
    camera = null;
  }
  camera = createCamera(store.settings.camera);
  if (!camera) {
    camStatus = { state: 'disconnected', detail: t('main.cameraNotConfigured') };
    send('cam:status', camStatus);
    return;
  }
  camera.on('status', (s) => { camStatus = s; send('cam:status', s); if (hub) hub.changed(); });
  camera.on('log', (m) => sendMain('cam:log', m));
  camera.connect().catch((e) => {
    camStatus = { state: 'error', detail: e.message };
    send('cam:status', camStatus);
  });
}

function requireCamera() {
  if (!camera) throw new Error(t('main.configureFirst'));
  return camera;
}

// ---------------------------------------------------------------------------
// Anteprima

preview.on('status', (s) => { previewStatus = s; sendMain('preview:status', s); });
preview.on('frame', (frame) => {
  // controllo di flusso: un fotogramma alla volta, così la latenza non si accumula
  if (frameInFlight && Date.now() - frameSentAt < 500) return;
  frameInFlight = true;
  frameSentAt = Date.now();
  sendMain('preview:frame', frame);
});

function startPreview() {
  const p = store.settings.preview;
  // nelle viste ridotte il video non si vede: ffmpeg resta fermo e non pesa sul PC
  if (p.source === 'rtsp' && p.rtspUrl && currentMode === 'full') {
    preview.start(p.rtspUrl, { width: p.width || 960 });
  } else {
    preview.stop();
    if (previewStatus.state !== 'off') {
      previewStatus = { state: 'off', detail: '' };
      sendMain('preview:status', previewStatus);
    }
  }
}

// ---------------------------------------------------------------------------
// Scorciatoie globali (funzionano anche con un altro programma in primo piano)

function runSafe(promiseOrValue) {
  Promise.resolve().then(() => promiseOrValue()).catch((e) => sendMain('cam:log', e.message));
}

function applyGlobalHotkeys() {
  globalShortcut.unregisterAll();
  const failed = [];
  const used = new Set();
  const reg = (acc, fn) => {
    if (!acc || used.has(acc)) return;
    used.add(acc);
    let ok = false;
    try { ok = globalShortcut.register(acc, fn); } catch (_) { ok = false; }
    if (!ok) failed.push(acc);
  };
  // tasti assegnati dall'utente alle singole funzioni (tastiere macro, Stream Deck in modalità tasto)
  const valid = new Set(hub.actionIds());
  for (const [action, acc] of Object.entries(store.settings.shortcuts || {})) {
    if (valid.has(action)) reg(acc, () => runSafe(() => hub.run(action)));
  }
  if (store.settings.globalHotkeys) {
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].forEach((k, i) => {
      reg(`Control+Alt+${k}`, () => runSafe(() => hub.recallIndex(i + 1)));
    });
    reg('Control+Alt+S', () => runSafe(() => hub.stop()));
  }
  return { ok: failed.length === 0, failed };
}

// ---------------------------------------------------------------------------
// Collegamento esterno (pannello OBS, Stream Deck, Companion)

async function startControl() {
  const a = store.settings.api;
  if (!a.enabled) {
    await control.stop();
    return;
  }
  await control.start({ port: Number(a.port) || 8765, lan: !!a.lan, token: a.token });
}

function apiInfo() {
  const a = store.settings.api;
  const base = `http://127.0.0.1:${Number(a.port) || 8765}`;
  return {
    status: apiStatus,
    enabled: !!a.enabled,
    port: Number(a.port) || 8765,
    lan: !!a.lan,
    token: a.token,
    base,
    obsUrl: `${base}/obs?k=${a.token}`,
    actions: hub.actionIds(),
  };
}

// ---------------------------------------------------------------------------
// Finestre e viste
//  - completa: la Regia, finestra normale
//  - compatta: la stessa finestra diventa una colonna stretta agganciata al bordo
//  - laterale: la finestra principale si nasconde e resta una linguetta sul bordo dello
//    schermo che si apre passandoci sopra con il mouse

const FULL_MIN = { width: 960, height: 640 };
const COMPACT = { width: 260, height: 620, minHeight: 360 };
const SIDE = { tabW: 30, tabH: 150, panelW: 248, panelH: 500, pad: 18 };

function boundsVisible(b) {
  if (!b) return false;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width - 40 && b.x + b.width > a.x + 40 && b.y >= a.y - 10 && b.y < a.y + a.height - 40;
  });
}

const viewSide = () => (store.settings.view && store.settings.view.side === 'left' ? 'left' : 'right');
const viewState = () => ({ mode: currentMode, side: viewSide(), alwaysOnTop: !!store.settings.alwaysOnTop });

// schermo su cui si trova (o si trovava) la finestra principale
function currentDisplay() {
  if (win && !win.isDestroyed() && win.isVisible()) return screen.getDisplayMatching(win.getBounds());
  if (sideWin && !sideWin.isDestroyed()) return screen.getDisplayMatching(sideWin.getBounds());
  const b = normalBounds || store.settings.bounds;
  if (b && boundsVisible(b)) return screen.getDisplayMatching(b);
  return screen.getPrimaryDisplay();
}

function compactBounds(display, side, keep) {
  const a = display.workArea;
  const h = Math.min(keep ? keep.height : COMPACT.height, a.height);
  const x = side === 'left' ? a.x : a.x + a.width - COMPACT.width;
  const y = keep ? clamp(keep.y, a.y, a.y + a.height - h) : Math.round(a.y + (a.height - h) / 2);
  return { x, y, width: COMPACT.width, height: h };
}

function fullBounds() {
  const nb = normalBounds || store.settings.bounds;
  if (nb && boundsVisible(nb)) return nb;
  const a = currentDisplay().workArea;
  const w = Math.min(1280, a.width);
  const h = Math.min(820, a.height);
  return { x: Math.round(a.x + (a.width - w) / 2), y: Math.round(a.y + (a.height - h) / 2), width: w, height: h };
}

function applyOnTop() {
  // la vista Compatta resta sempre sopra le altre finestre (è il suo scopo); la completa solo se richiesto
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(currentMode === 'compact' || !!store.settings.alwaysOnTop, 'floating');
}

// limiti di dimensione della finestra principale per la vista indicata
function applyWindowLimits(mode) {
  if (!win) return;
  if (mode === 'compact') {
    win.setMaximizable(false);
    win.setFullScreenable(false);
    win.setMinimumSize(COMPACT.width, COMPACT.minHeight);
    win.setMaximumSize(COMPACT.width, 10000); // larghezza fissa, altezza libera
    if (IS_MAC) win.setWindowButtonVisibility(false);
  } else {
    win.setMaximumSize(0, 0); // 0 = nessun limite
    win.setMinimumSize(FULL_MIN.width, FULL_MIN.height);
    win.setMaximizable(true);
    win.setFullScreenable(true);
    if (IS_MAC) win.setWindowButtonVisibility(true);
  }
}

function rememberFullBounds() {
  if (!win || win.isDestroyed() || currentMode !== 'full') return;
  wasMaximized = win.isMaximized();
  normalBounds = wasMaximized ? win.getNormalBounds() : win.getBounds();
  try { store.saveSettings({ bounds: normalBounds }); } catch (_) { /* non essenziale */ }
}

async function setView(mode) {
  if (!VIEW_MODES.includes(mode)) mode = 'full';
  if (!win || win.isDestroyed()) return viewState();
  // durante la modifica di un'inquadratura si resta nella vista completa (l'editor è lì)
  if (mode !== 'full' && hub && hub.editing) return viewState();
  const prev = currentMode;
  if (prev === mode) {
    if (mode !== 'side') { win.show(); win.focus(); }
    return viewState();
  }
  // da schermo intero (Mac) si esce prima: è asincrono e altrimenti dimensioni e Space restano sbagliati
  if (win.isFullScreen()) {
    await new Promise((resolve) => {
      const tm = setTimeout(resolve, 1500);
      win.once('leave-full-screen', () => { clearTimeout(tm); setTimeout(resolve, 80); });
      win.setFullScreen(false);
    });
    if (!win || win.isDestroyed()) return viewState();
  }
  const display = currentDisplay();
  rememberFullBounds();
  currentMode = mode;
  try { store.saveSettings({ view: { mode } }); } catch (_) { /* si ricorda al prossimo salvataggio */ }
  // prima cambia l'interfaccia, poi la finestra: niente vista completa schiacciata a 260 px
  send('view:changed', viewState());

  if (mode === 'side') {
    showSideWindow(display);
    win.hide();
  } else {
    destroySideWindow();
    if (win.isMaximized()) win.unmaximize();
    if (win.isFullScreen()) win.setFullScreen(false);
    applyWindowLimits(mode);
    if (mode === 'compact') {
      win.setBounds(compactBounds(display, viewSide()));
    } else {
      win.setBounds(fullBounds());
      if (wasMaximized) win.maximize();
    }
    applyOnTop();
    win.show();
    win.focus();
  }
  startPreview();
  return viewState();
}

function setSide(side) {
  const s = side === 'left' ? 'left' : 'right';
  try { store.saveSettings({ view: { side: s } }); } catch (_) { /* ignora */ }
  if (currentMode === 'compact' && win && !win.isDestroyed()) {
    win.setBounds(compactBounds(currentDisplay(), s, win.getBounds()));
  } else if (currentMode === 'side' && sideWin && !sideWin.isDestroyed()) {
    placeSideWindow(sideExpanded);
  }
  send('view:changed', viewState());
  return viewState();
}

// ---- vista laterale --------------------------------------------------------

let sideExpanded = false;
let sideDisplayId = null;

function sideBounds(expanded) {
  const d = screen.getAllDisplays().find((x) => x.id === sideDisplayId) || screen.getPrimaryDisplay();
  const a = d.workArea;
  const w = (expanded ? SIDE.panelW : SIDE.tabW) + SIDE.pad;
  const h = Math.min((expanded ? SIDE.panelH : SIDE.tabH) + SIDE.pad * 2, a.height);
  const x = viewSide() === 'left' ? a.x : a.x + a.width - w;
  const y = Math.round(a.y + (a.height - h) / 2);
  return { x, y, width: w, height: h };
}

// Schermo staccato o area di lavoro cambiata (barra delle applicazioni, risoluzione):
// la linguetta e la colonna compatta tornano agganciate al bordo
function relayoutReducedViews() {
  if (currentMode === 'side' && sideWin && !sideWin.isDestroyed()) {
    if (!screen.getAllDisplays().some((d) => d.id === sideDisplayId)) sideDisplayId = screen.getPrimaryDisplay().id;
    placeSideWindow(sideExpanded);
  } else if (currentMode === 'compact' && win && !win.isDestroyed()) {
    win.setBounds(compactBounds(currentDisplay(), viewSide(), win.getBounds()));
  }
}

function placeSideWindow(expanded) {
  if (!sideWin || sideWin.isDestroyed()) return;
  sideExpanded = !!expanded;
  const b = sideBounds(sideExpanded);
  // su Linux una finestra non ridimensionabile ha dimensioni bloccate anche per il programma
  const unlock = process.platform === 'linux';
  if (unlock) sideWin.setResizable(true);
  sideWin.setBounds(b);
  if (unlock) sideWin.setResizable(false);
}

function webPrefs() {
  return {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    backgroundThrottling: false,
  };
}

function showSideWindow(display) {
  sideDisplayId = (display || currentDisplay()).id;
  if (sideWin && !sideWin.isDestroyed()) {
    placeSideWindow(false);
    sideWin.showInactive();
    return;
  }
  sideExpanded = false;
  sideWin = new BrowserWindow({
    ...sideBounds(false),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: APP_TITLE,
    icon: path.join(__dirname, '..', 'renderer', 'icon.png'),
    webPreferences: webPrefs(),
  });
  sideWin.setMenu(null);
  sideWin.setAlwaysOnTop(true, 'floating');
  if (IS_MAC) sideWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  sideWin.loadFile(path.join(__dirname, '..', 'renderer', 'side.html'));
  sideWin.once('ready-to-show', () => { if (sideWin && !sideWin.isDestroyed()) sideWin.showInactive(); });
  sideWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  sideWin.webContents.on('will-navigate', (e) => e.preventDefault());
  sideWin.webContents.on('render-process-gone', () => {
    setTimeout(() => { if (sideWin && !sideWin.isDestroyed()) sideWin.webContents.reload(); }, 1000);
  });
  const own = sideWin;
  sideWin.on('closed', () => {
    if (sideWin === own) sideWin = null;
    // chiusa da sola (Alt+F4) mentre era la vista attiva: torna l'app completa
    if (!closingApp && !quitting && currentMode === 'side' && win && !win.isDestroyed()) setView('full');
  });
}

function destroySideWindow() {
  if (!sideWin) return;
  const w = sideWin;
  sideWin = null;
  if (!w.isDestroyed()) w.destroy();
}

// ---- finestra principale ---------------------------------------------------

function createWindow() {
  const saved = store.settings.bounds;
  currentMode = store.settings.view.mode;
  if (boundsVisible(saved)) normalBounds = saved;
  const compact = currentMode === 'compact';
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: FULL_MIN.width,
    minHeight: FULL_MIN.height,
    ...(boundsVisible(saved) ? saved : {}),
    backgroundColor: '#F5F5F7',
    title: APP_TITLE,
    icon: path.join(__dirname, '..', 'renderer', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    // barra del titolo disegnata dall'app (chiara come il resto); sul Mac restano i pulsanti di sistema
    ...(IS_MAC ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 13 } } : { frame: false }),
    webPreferences: webPrefs(),
  });
  win.setMenu(null);
  applyOnTop();
  if (compact) {
    applyWindowLimits('compact');
    win.setBounds(compactBounds(currentDisplay(), viewSide()));
  }
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query: { view: currentMode } });
  win.once('ready-to-show', () => {
    if (currentMode === 'side') showSideWindow(currentDisplay());
    else win.show();
  });

  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  const saveBounds = () => {
    if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
    if (currentMode !== 'full') return; // nelle viste ridotte si conservano le dimensioni della completa
    normalBounds = win.getBounds();
    try { store.saveSettings({ bounds: normalBounds }); } catch (_) { /* non essenziale */ }
  };
  let boundsTimer = null;
  const queueSave = () => { clearTimeout(boundsTimer); boundsTimer = setTimeout(saveBounds, 600); };
  win.on('resize', queueSave);
  win.on('move', queueSave);
  win.on('maximize', () => sendMain('win:maximized', true));
  win.on('focus', checkUpdatesOnFocus);
  win.on('unmaximize', () => sendMain('win:maximized', false));
  win.on('closed', () => {
    win = null;
    destroySideWindow(); // senza la finestra principale l'app si chiude
    // anche se resta aperta la finestra nascosta della camera USB
    if (!quitting && !closingApp) app.quit();
  });
  // se l'interfaccia va in crash, la testa si ferma e la pagina si ricarica
  win.webContents.on('render-process-gone', () => {
    if (camera) camera.stopAll();
    if (hub) hub.setEditing(false); // l'editor si è chiuso con la pagina: i richiami esterni ripartono
    setTimeout(() => { if (win && !win.isDestroyed()) win.webContents.reload(); }, 1000);
  });
}

// ---------------------------------------------------------------------------
// Aggiornamenti: si controlla subito dopo l'avvio, poi ogni 6 ore e quando si torna sulla
// finestra dopo almeno un'ora; se il controllo non riesce si riprova dopo 15 minuti. Si avvisa soltanto

function runUpdateCheck() {
  if (!UPDATE_REPO) {
    updateStatus = { state: 'disabled' };
    return Promise.resolve(updateStatus);
  }
  if (updateRunning) return updateRunning;
  updateStatus = { ...updateStatus, state: 'checking' };
  sendMain('update:status', updateStatus);
  updateRunning = updates.checkForUpdate({
    repo: UPDATE_REPO,
    current: APP_VERSION,
    fetch: (url, init) => net.fetch(url, init),
    apiBase: UPDATE_API,
  }).then((r) => r, (e) => ({ state: 'error', current: APP_VERSION, detail: updateErrorText(e) }))
    .then((r) => {
      updateStatus = { ...r, checkedAt: Date.now() };
      updateRunning = null;
      sendMain('update:status', updateStatus);
      return updateStatus;
    });
  return updateRunning;
}

function updateErrorText(e) {
  const code = e && e.code;
  if (code === 'rate') return t('up.err.rate');
  if (code === 'http') return t('up.err.http', { status: e.status });
  if (code === 'badVersion') return t('up.err.badVersion');
  if (code === 'timeout' || (e && e.name === 'AbortError')) return t('up.err.timeout');
  return t('up.err.network');
}

// Windows: programmi che hanno la precedenza sulla camera USB (OBS, Zoom…). L'anteprima USB di
// PTZ Hub li controlla ogni 2 secondi e lascia libera la camera; i comandi non ne hanno bisogno.
let camApps = [];
function watchCameraApps() {
  if (process.platform !== 'win32') return;
  const self = [path.basename(process.execPath)];
  const tick = async () => {
    try {
      const list = store.settings.preview.source === 'usb' ? await scanCameraApps(self) : [];
      if (JSON.stringify(list) !== JSON.stringify(camApps)) {
        camApps = list;
        sendMain('camapps:changed', list);
      }
    } catch (_) { /* nuovo tentativo al giro dopo */ }
    setTimeout(tick, 2000).unref();
  };
  tick();
}

function scheduleUpdateChecks() {
  clearTimeout(updateTimer);
  updateTimer = null;
  updateGen += 1;
  const gen = updateGen;
  if (!UPDATE_REPO || !store.settings.updates.check) return;
  const envDelay = Number(TEST_ENV.PTZ_UPDATE_DELAY_MS);
  const first = TEST_ENV.PTZ_UPDATE_DELAY_MS && envDelay >= 0 ? envDelay : 3000;
  const tick = () => {
    if (gen !== updateGen) return;
    runUpdateCheck().then((r) => {
      if (gen !== updateGen || !store.settings.updates.check) return;
      const wait = r && r.state === 'error' ? UPDATE_RETRY_MS : UPDATE_EVERY_MS;
      clearTimeout(updateTimer);
      updateTimer = setTimeout(tick, wait);
    });
  };
  updateTimer = setTimeout(tick, first);
}

// tornando sulla finestra dopo almeno un'ora dall'ultimo controllo se ne fa subito un altro
function checkUpdatesOnFocus() {
  if (!UPDATE_REPO || !store.settings.updates.check || updateRunning) return;
  const last = updateStatus && updateStatus.checkedAt;
  if (last && Date.now() - last < UPDATE_FOCUS_MS) return;
  if (!last && updateTimer) return; // il primo controllo è già in programma
  runUpdateCheck();
}

// pagina del progetto su GitHub (solo se il repository è configurato e valido)
function projectUrl() {
  if (!UPDATE_REPO) return '';
  const url = `https://github.com/${UPDATE_REPO}`;
  return /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(url) ? url : '';
}

// ---------------------------------------------------------------------------
// IPC

const fromMain = (e) => !!win && !win.isDestroyed() && e.sender === win.webContents;
const fromSide = (e) => !!sideWin && !sideWin.isDestroyed() && e.sender === sideWin.webContents;

function registerIpc() {
  ipcMain.handle('init', (e) => {
    // pagina principale appena caricata (o ricaricata): non c'è nessun editor aperto
    if (fromMain(e)) hub.setEditing(false);
    return initData();
  });
  const initData = () => ({
    settings: store.settings,
    presets: store.presets,
    activeId: hub.activeId,
    camStatus,
    previewStatus,
    view: viewState(),
    info: {
      user: os.userInfo().username,
      dataDir: app.getPath('userData'),
      version: APP_VERSION,
      platform: process.platform,
      uvcNative: !!uvcExe(), // camere USB su Windows comandate senza aprire il video
      lang: I18N.getLang(),
      hasProject: !!projectUrl(),
      maximized: !!(win && !win.isDestroyed() && win.isMaximized()),
    },
    update: updateStatus,
    camApps,
  });

  ipcMain.handle('settings:save', async (_e, partial) => {
    const before = JSON.stringify(store.settings.camera);
    const beforePrev = JSON.stringify(store.settings.preview);
    const beforeApi = JSON.stringify(store.settings.api);
    const beforeUpd = JSON.stringify(store.settings.updates);
    const beforeSide = viewSide();
    const p = { ...(partial || {}) };
    delete p.view; // la vista si cambia solo con app:setView / app:setSide
    const s = store.saveSettings(p);
    I18N.setLang(I18N.resolve(s.language, app.getLocale()));
    if (JSON.stringify(s.camera) !== before) startCamera();
    if (JSON.stringify(s.preview) !== beforePrev) startPreview();
    applyOnTop();
    if (JSON.stringify(s.api) !== beforeApi) await startControl();
    if (JSON.stringify(s.updates) !== beforeUpd) scheduleUpdateChecks();
    if (partial && partial.view && partial.view.side && partial.view.side !== beforeSide) setSide(partial.view.side);
    hub.changed();
    const hk = applyGlobalHotkeys();
    if (sideWin && !sideWin.isDestroyed()) sideWin.webContents.send('settings:changed', store.settings);
    send('view:changed', viewState());
    return { settings: store.settings, hotkeys: hk };
  });

  ipcMain.handle('presets:save', (_e, list) => {
    const r = store.savePresets(list);
    // i tasti delle inquadrature che non esistono più si tolgono anche dalle impostazioni
    const ids = new Set(r.map((p) => p.id));
    const sc = store.settings.shortcuts || {};
    const clean = Object.fromEntries(Object.entries(sc).filter(([a]) => !a.startsWith('preset:') || ids.has(a.slice(7))));
    if (Object.keys(clean).length !== Object.keys(sc).length) {
      store.saveSettings({ shortcuts: clean });
      send('settings:changed', store.settings);
    }
    hub.presetsChanged();
    applyGlobalHotkeys(); // i tasti delle inquadrature eliminate si liberano
    if (sideWin && !sideWin.isDestroyed()) sideWin.webContents.send('presets:changed', r);
    return r;
  });

  ipcMain.handle('cam:recallPreset', async (e, id, speed, opts) => {
    // dall'editor il richiamo passa anche con la modifica in corso (solo dalla finestra principale)
    const force = !!(opts && opts.editor) && fromMain(e);
    const p = await hub.recallId(id, speed, { force });
    return p ? { id: p.id } : { id: null, superseded: true };
  });
  ipcMain.on('ui:editing', (e, on) => { if (fromMain(e)) hub.setEditing(!!on); });
  // inquadratura appena salvata: la camera è lì, tutti (OBS, successiva/precedente) lo sanno
  ipcMain.on('cam:setActive', (_e, id) => {
    hub.setActive(store.presets.some((p) => p.id === id) ? id : null);
  });
  // «Riprova ora»: si riapre subito il collegamento con la camera
  ipcMain.handle('cam:reconnect', () => { startCamera(); return camStatus; });
  ipcMain.handle('api:info', () => apiInfo());
  ipcMain.handle('api:newToken', async () => {
    store.saveSettings({ api: { token: Store.newToken() } });
    await startControl();
    return apiInfo();
  });
  ipcMain.handle('app:copy', (_e, text) => { clipboard.writeText(String(text)); return true; });

  ipcMain.handle('presets:export', async (_e, list) => {
    const r = await dialog.showSaveDialog(win, {
      title: t('main.exportTitle'),
      defaultPath: path.join(app.getPath('documents'), `ptz-hub-presets-${os.userInfo().username}.json`),
      filters: [{ name: t('main.fileFilter'), extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, JSON.stringify({
      version: 1, app: 'PTZ Hub', exportedBy: os.userInfo().username, exportedAt: new Date().toISOString(), presets: list,
    }, null, 2));
    return r.filePath;
  });

  // restituisce { presets, name }: il nome del file serve alla conferma
  ipcMain.handle('presets:import', async () => {
    let file = TEST_ENV.PTZ_TEST_IMPORT_FILE || null; // solo per i test automatici
    if (!file) {
      const r = await dialog.showOpenDialog(win, {
        title: t('main.importTitle'),
        properties: ['openFile'],
        filters: [{ name: t('main.fileFilter'), extensions: ['json'] }],
      });
      if (r.canceled || !r.filePaths[0]) return null;
      [file] = r.filePaths;
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data.presets)) throw new Error(t('main.invalidFile'));
    return { presets: data.presets, name: path.basename(file) };
  });

  // comandi di movimento: senza risposta, per la latenza minima
  ipcMain.on('cam:cmd', (_e, { name, args = [] }) => {
    if (!camera) return;
    try {
      switch (name) {
        case 'move': camera.move(args[0], args[1]); break;
        case 'zoom': camera.zoom(args[0]); break;
        case 'focus': camera.focus(args[0]); break;
        case 'focusAuto': camera.setFocusAuto(!!args[0]); break;
        case 'onePush': camera.focusOnePush(); break;
        case 'home': hub.home(); break;
        case 'step': hub.stepMove(args[0]); break;
        case 'stop': hub.stop(); break;
        default: break;
      }
    } catch (e) {
      sendMain('cam:log', e.message);
    }
  });

  ipcMain.handle('cam:getPosition', async () => {
    const c = requireCamera();
    c.stopAll();
    await new Promise((r) => setTimeout(r, 250)); // la testa si ferma prima della lettura
    return c.getPosition();
  });
  ipcMain.handle('cam:saveSlot', (_e, n) => requireCamera().saveSlot(n));
  ipcMain.handle('cam:recallSlot', (_e, n) => requireCamera().recallSlot(n));

  // verifica di una camera USB su Windows senza aprire il video (OBS o Zoom possono averla aperta)
  ipcMain.handle('uvc:probe', async (_e, label) => {
    const exe = uvcExe();
    if (!exe) return { ok: false, name: 'NotSupportedError', message: 'ptzhub-uvc.exe mancante' };
    return uvcProbeNative(exe, typeof label === 'string' ? label.slice(0, 300) : '');
  });

  ipcMain.handle('detect:discover', async () => {
    const [onvif, scan] = await Promise.all([probe.wsDiscovery(), probe.scanNetwork()]);
    const byIp = new Map();
    // solo telecamere: chi risponde in VISCA o RTSP (scanNetwork) o si annuncia ONVIF (WS-Discovery)
    for (const s of scan) byIp.set(s.ip, { ip: s.ip, rtsp: s.rtsp, visca: s.visca });
    for (const d of onvif) byIp.set(d.ip, { ...(byIp.get(d.ip) || { ip: d.ip }), onvif: true, name: d.name, hardware: d.hardware });
    const out = [...byIp.values()];
    // prima quelle comandabili (VISCA o ONVIF), poi quelle con solo il video
    const score = (d) => (d.visca || d.onvif ? 2 : 0) + (d.rtsp ? 1 : 0);
    out.sort((a, b) => score(b) - score(a));
    return { networks: probe.localNetworks(), devices: out };
  });

  ipcMain.handle('detect:protocols', async (_e, { host, user, pass, address }) => {
    const [visca, onvif, http] = await Promise.all([
      probe.probeVisca(host, { address: address || 1 }),
      probe.probeOnvif(host, { user, pass }),
      probe.probeHttp(host),
    ]);
    return { visca, onvif, http };
  });

  ipcMain.handle('detect:rtsp', async (_e, { host, user, pass, onvifPort }) => {
    const enc = (s) => encodeURIComponent(s || '');
    const withAuth = (url) => {
      if (!user) return url;
      const u = new URL(url);
      u.username = enc(user);
      u.password = enc(pass);
      return u.toString();
    };
    const candidates = [];
    if (onvifPort) {
      try {
        const r = await probe.probeOnvif(host, { user, pass, ports: [onvifPort] });
        for (const s of r.streams || []) candidates.push({ url: s.uri, note: `ONVIF ${s.width || '?'}x${s.height || '?'}` });
      } catch (_) { /* ignora */ }
    }
    const described = await probe.findRtsp(host, { user, pass });
    for (const d of described) {
      if (d.status === 200) candidates.push({ url: d.url, note: 'RTSP' });
    }
    // percorsi che chiedono password: possibili ma non verificati
    for (const d of described) {
      if (d.status === 401 && !candidates.some((c) => c.url === d.url)) candidates.push({ url: d.url, note: t('r.needsPassword') });
    }
    const results = [];
    const seen = new Set();
    for (const c of candidates) {
      if (seen.has(c.url)) continue;
      seen.add(c.url);
      const full = withAuth(c.url);
      // eslint-disable-next-line no-await-in-loop
      const tr = await testUrl(full, 7000);
      results.push({ url: full, display: c.url, note: c.note, ok: tr.ok, error: tr.error });
      if (results.filter((r) => r.ok).length >= 3) break;
    }
    return results;
  });

  ipcMain.handle('detect:testUrl', (_e, url) => testUrl(url, 7000));

  ipcMain.on('preview:ack', () => { frameInFlight = false; });

  // viste: completa, compatta, laterale e bordo dello schermo
  ipcMain.handle('app:setView', (_e, mode) => setView(mode));
  ipcMain.handle('app:setSide', (_e, side) => setSide(side));
  ipcMain.handle('app:setOnTop', (_e, on) => {
    store.saveSettings({ alwaysOnTop: !!on });
    applyOnTop();
    send('view:changed', viewState());
    send('settings:changed', store.settings);
    return viewState();
  });
  // compatibilità con la 1.3: compatta sì/no
  ipcMain.handle('app:setCompact', async (_e, on) => (await setView(on ? 'compact' : 'full')).mode === 'compact');
  ipcMain.on('side:expand', (e, on) => { if (fromSide(e)) placeSideWindow(!!on); });

  // pulsanti della barra del titolo disegnata dall'app
  ipcMain.on('win:control', (e, what) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w || w !== win) return;
    if (what === 'minimize') w.minimize();
    else if (what === 'maximize') { if (w.isMaximized()) w.unmaximize(); else if (currentMode === 'full') w.maximize(); }
    else if (what === 'close') w.close();
  });

  ipcMain.handle('app:openDataFolder', () => shell.openPath(app.getPath('userData')));
  ipcMain.handle('update:check', () => runUpdateCheck());
  ipcMain.handle('update:open', () => {
    const url = updateStatus && updateStatus.url;
    if (!updates.isSafeReleaseUrl(url, UPDATE_REPO)) return false;
    shell.openExternal(url);
    return true;
  });
  // crediti: indirizzo fisso, la pagina non può aprire altro
  ipcMain.handle('app:openCredits', () => {
    shell.openExternal('https://redmango.agency/?utm_source=ptzhub&utm_medium=app&utm_campaign=ptzhub');
    return true;
  });

  // pagina web della telecamera (per attivare ONVIF o cambiare la password): solo indirizzi della
  // rete locale, la pagina non può aprire siti qualsiasi
  ipcMain.handle('app:openCameraPage', (_e, host) => {
    const h = String(host || '').trim();
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    const priv = m && m.slice(1).every((x) => Number(x) <= 255)
      && (m[1] === '10' || (m[1] === '192' && m[2] === '168') || (m[1] === '172' && Number(m[2]) >= 16 && Number(m[2]) <= 31)
        || (m[1] === '169' && m[2] === '254'));
    const local = /^[a-z0-9-]+(\.local)?$/i.test(h);
    if (!priv && !local) return false;
    shell.openExternal(`http://${h}/`);
    return true;
  });

  // guida passo passo su GitHub, nella lingua dell'app
  ipcMain.handle('app:openGuide', (_e, topic) => {
    const base = 'https://github.com/Redmango-Agency/PTZhub/blob/main/docs/';
    const en = I18N.getLang() === 'en';
    const page = en ? 'guide.md' : 'guida.md';
    const anchors = { password: en ? '#the-camera-asks-for-a-password' : '#la-telecamera-chiede-utente-e-password' };
    shell.openExternal(base + page + (anchors[topic] || ''));
    return true;
  });

  ipcMain.handle('app:openProject', () => {
    const url = projectUrl();
    if (!url) return false;
    shell.openExternal(url);
    return true;
  });
}

// ---------------------------------------------------------------------------

app.on('second-instance', () => {
  if (!win) return;
  if (currentMode === 'side') { setView('full'); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

// Mac: clic sull'icona nel Dock con la finestra nascosta (vista laterale)
app.on('activate', () => {
  if (win && currentMode === 'side') setView('full');
});

app.whenReady().then(() => {
  if (!gotLock) return;
  if (IS_MAC) {
    // sul Mac serve il menu in alto: Esci (⌘Q) e Copia/Incolla nei campi di testo
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
  }
  for (const ev of ['display-removed', 'display-added', 'display-metrics-changed']) {
    screen.on(ev, () => setTimeout(relayoutReducedViews, 300));
  }
  const sharedDefaults = path.join(path.dirname(process.execPath), 'ptz-defaults.json');
  store = new Store(app.getPath('userData'), sharedDefaults, os.userInfo().username);
  I18N.setLang(I18N.resolve(store.settings.language, app.getLocale()));
  // modo di accesso ONVIF che ha funzionato per ogni camera (Dahua con l'orologio sbagliato e simili):
  // si ricorda per non ripetere tentativi sbagliati, che alcune camere puniscono bloccando l'utente
  setAuthHints(store.settings.onvifAuth);
  onAuthHint((all) => { try { store.saveSettings({ onvifAuth: all }); } catch (_) { /* non essenziale */ } });
  hub = new Hub({ store, getCamera: () => camera, getCamStatus: () => camStatus });
  hub.on('active', (id) => send('preset:active', id));
  hub.on('stopped', () => send('hotkey', { type: 'stop' }));
  hub.on('manual', () => send('cam:manual')); // comandi manuali da fuori: la miniatura non va aggiornata
  control = new ControlServer(hub, { app: APP_TITLE, version: APP_VERSION });
  control.on('status', (st) => { apiStatus = st; sendMain('api:status', st); });
  registerIpc();
  createWindow();
  startCamera();
  startPreview();
  applyGlobalHotkeys();
  startControl().catch((e) => { apiStatus = { state: 'error', detail: e.message }; });
  scheduleUpdateChecks();
  watchCameraApps();
});

// In uscita si manda lo stop e si aspetta che parta prima di chiudere i socket
app.on('will-quit', (e) => {
  if (quitting || !gotLock) return;
  e.preventDefault();
  quitting = true;
  globalShortcut.unregisterAll();
  clearTimeout(updateTimer);
  updateGen += 1;
  preview.stop();
  if (control) control.stop().catch(() => {});
  const c = camera;
  camera = null;
  const stop = c ? Promise.resolve().then(() => c.disconnect()).catch(() => {}) : Promise.resolve();
  Promise.race([stop, new Promise((r) => setTimeout(r, 1500))]).finally(() => app.exit(0));
});
app.on('before-quit', () => { closingApp = true; });

// Un errore imprevisto non deve aprire finestre bloccanti durante l'evento
process.on('uncaughtException', (err) => {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'errori.log'), `${new Date().toISOString()} ${err && err.stack ? err.stack : err}\n`);
  } catch (_) { /* ignora */ }
  sendMain('cam:log', t('main.internalError', { error: err && err.message ? err.message : err }));
});
process.on('unhandledRejection', (err) => {
  sendMain('cam:log', t('main.internalError', { error: err && err.message ? err.message : err }));
});

app.on('window-all-closed', () => app.quit());
