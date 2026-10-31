'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const {
  app, BrowserWindow, ipcMain, globalShortcut, dialog, shell, screen, clipboard, net,
} = require('electron');
const { Store, DEFAULT_PORTS } = require('./store');
const { ViscaCamera } = require('./visca');
const { OnvifCamera } = require('./onvif');
const { Preview, testUrl } = require('./preview');
const probe = require('./probe');
const { Hub } = require('./hub');
const { ControlServer } = require('./control');
const I18N = require('../shared/i18n');
const updates = require('./updates');
const PKG = require('../../package.json');

const { t } = I18N;

app.setName('PTZ Panel');
app.setPath('userData', path.join(app.getPath('appData'), 'PTZ Panel'));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // un'altra copia è già aperta: questa si chiude subito (l'altra viene portata davanti)
  app.exit(0);
}

let win = null;
let store = null;
let camera = null;
let camStatus = { state: 'disconnected', detail: '' };
const preview = new Preview();
let previewStatus = { state: 'off', detail: '' };
let frameInFlight = false;
let frameSentAt = 0;
let normalBounds = null;
let hub = null;
let control = null;
let apiStatus = { state: 'off', detail: '' };

// Aggiornamenti: repository GitHub da cui si scarica il programma (vuoto = controllo spento)
// PTZ_UPDATE_REPO / PTZ_UPDATE_API servono solo ai test automatici
const TEST_ENV = app.isPackaged ? {} : process.env;
const UPDATE_REPO = updates.repoFromPackage(TEST_ENV.PTZ_UPDATE_REPO
  ? { ptzPanel: { updateRepo: TEST_ENV.PTZ_UPDATE_REPO } } : PKG);
const UPDATE_API = TEST_ENV.PTZ_UPDATE_API || updates.API_BASE;
const UPDATE_EVERY_MS = 24 * 60 * 60 * 1000;
const APP_VERSION = PKG.version; // come app.getVersion() nel programma installato, anche nei test
let updateStatus = { state: UPDATE_REPO ? 'idle' : 'disabled' };
let updateTimer = null;
let updateRunning = null;
let updateGen = 0; // cambia quando si riprogramma: le catene di controlli vecchie si fermano

const send = (ch, data) => {
  if (win && !win.isDestroyed()) win.webContents.send(ch, data);
};

// ---------------------------------------------------------------------------
// Camera

function createCamera(cfg) {
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
  camera.on('log', (m) => send('cam:log', m));
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

preview.on('status', (s) => { previewStatus = s; send('preview:status', s); });
preview.on('frame', (frame) => {
  // controllo di flusso: un fotogramma alla volta, così la latenza non si accumula
  if (frameInFlight && Date.now() - frameSentAt < 500) return;
  frameInFlight = true;
  frameSentAt = Date.now();
  send('preview:frame', frame);
});

function startPreview() {
  const p = store.settings.preview;
  if (p.source === 'rtsp' && p.rtspUrl) {
    preview.start(p.rtspUrl, { width: p.width || 960 });
  } else {
    preview.stop();
  }
}

// ---------------------------------------------------------------------------
// Scorciatoie globali (funzionano anche con un altro programma in primo piano)

function runSafe(promiseOrValue) {
  Promise.resolve().then(() => promiseOrValue()).catch((e) => send('cam:log', e.message));
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
// Finestra

function boundsVisible(b) {
  if (!b) return false;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width - 40 && b.x + b.width > a.x + 40 && b.y >= a.y - 10 && b.y < a.y + a.height - 40;
  });
}

function createWindow() {
  const saved = store.settings.bounds;
  const compact = !!store.settings.compact;
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: compact ? 360 : 960,
    minHeight: compact ? 260 : 640,
    ...(boundsVisible(saved) ? saved : {}),
    backgroundColor: '#0e1014',
    title: 'PTZ Panel',
    icon: path.join(__dirname, '..', 'renderer', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.setMenu(null);
  win.setAlwaysOnTop(!!store.settings.alwaysOnTop, 'floating');
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  const saveBounds = () => {
    if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
    if (store.settings.compact) return; // in modalità compatta si conservano le dimensioni normali
    try { store.saveSettings({ bounds: win.getBounds() }); } catch (_) { /* non essenziale */ }
  };
  let boundsTimer = null;
  const queueSave = () => { clearTimeout(boundsTimer); boundsTimer = setTimeout(saveBounds, 600); };
  win.on('resize', queueSave);
  win.on('move', queueSave);
  win.on('closed', () => { win = null; });
  // se l'interfaccia va in crash, la testa si ferma e la pagina si ricarica
  win.webContents.on('render-process-gone', () => {
    if (camera) camera.stopAll();
    if (hub) hub.setEditing(false); // l'editor si è chiuso con la pagina: i richiami esterni ripartono
    setTimeout(() => { if (win && !win.isDestroyed()) win.webContents.reload(); }, 1000);
  });
  if (compact) {
    const b = win.getBounds();
    win.setBounds({ x: b.x + b.width - 520, y: b.y, width: 520, height: 420 });
  }
}

function setCompact(on) {
  if (!win) return;
  if (on) {
    if (!store.settings.compact) normalBounds = win.getBounds();
    store.saveSettings({ compact: true, bounds: normalBounds || store.settings.bounds });
    win.setMinimumSize(360, 260);
    const b = win.getBounds();
    win.setBounds({ x: b.x + b.width - 520, y: b.y, width: 520, height: 420 });
  } else {
    store.saveSettings({ compact: false });
    win.setMinimumSize(960, 640);
    const nb = normalBounds || store.settings.bounds;
    if (nb && boundsVisible(nb)) win.setBounds(nb); else win.setSize(1280, 820);
  }
}

// ---------------------------------------------------------------------------
// Aggiornamenti: si controlla poco dopo l'avvio e poi una volta al giorno; si avvisa soltanto

function runUpdateCheck() {
  if (!UPDATE_REPO) {
    updateStatus = { state: 'disabled' };
    return Promise.resolve(updateStatus);
  }
  if (updateRunning) return updateRunning;
  updateStatus = { ...updateStatus, state: 'checking' };
  send('update:status', updateStatus);
  updateRunning = updates.checkForUpdate({
    repo: UPDATE_REPO,
    current: APP_VERSION,
    fetch: (url, init) => net.fetch(url, init),
    apiBase: UPDATE_API,
  }).then((r) => r, (e) => ({ state: 'error', current: APP_VERSION, detail: updateErrorText(e) }))
    .then((r) => {
      updateStatus = { ...r, checkedAt: Date.now() };
      updateRunning = null;
      send('update:status', updateStatus);
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

function scheduleUpdateChecks() {
  clearTimeout(updateTimer);
  updateTimer = null;
  updateGen += 1;
  const gen = updateGen;
  if (!UPDATE_REPO || !store.settings.updates.check) return;
  const envDelay = Number(TEST_ENV.PTZ_UPDATE_DELAY_MS);
  const first = TEST_ENV.PTZ_UPDATE_DELAY_MS && envDelay >= 0 ? envDelay : 20000;
  const tick = () => {
    if (gen !== updateGen) return;
    runUpdateCheck().finally(() => {
      if (gen === updateGen && store.settings.updates.check) updateTimer = setTimeout(tick, UPDATE_EVERY_MS);
    });
  };
  updateTimer = setTimeout(tick, first);
}

// ---------------------------------------------------------------------------
// IPC

function registerIpc() {
  ipcMain.handle('init', () => {
    // pagina appena caricata (o ricaricata): non c'è nessun editor aperto
    hub.setEditing(false);
    return initData();
  });
  const initData = () => ({
    settings: store.settings,
    presets: store.presets,
    activeId: hub.activeId,
    camStatus,
    previewStatus,
    info: {
      user: os.userInfo().username,
      dataDir: app.getPath('userData'),
      version: APP_VERSION,
      platform: process.platform,
      lang: I18N.getLang(),
    },
    update: updateStatus,
  });

  ipcMain.handle('settings:save', async (_e, partial) => {
    const before = JSON.stringify(store.settings.camera);
    const beforePrev = JSON.stringify(store.settings.preview);
    const beforeApi = JSON.stringify(store.settings.api);
    const beforeUpd = JSON.stringify(store.settings.updates);
    const s = store.saveSettings(partial || {});
    I18N.setLang(I18N.resolve(s.language, app.getLocale()));
    if (JSON.stringify(s.camera) !== before) startCamera();
    if (JSON.stringify(s.preview) !== beforePrev) startPreview();
    if (win) win.setAlwaysOnTop(!!s.alwaysOnTop, 'floating');
    if (JSON.stringify(s.api) !== beforeApi) await startControl();
    if (JSON.stringify(s.updates) !== beforeUpd) scheduleUpdateChecks();
    hub.changed();
    const hk = applyGlobalHotkeys();
    return { settings: s, hotkeys: hk };
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
    return r;
  });

  ipcMain.handle('cam:recallPreset', async (_e, id, speed, opts) => {
    // dall'editor il richiamo passa anche con la modifica in corso
    const p = await hub.recallId(id, speed, { force: !!(opts && opts.editor) });
    return p ? { id: p.id } : { id: null, superseded: true };
  });
  ipcMain.on('ui:editing', (_e, on) => hub.setEditing(!!on));
  // inquadratura appena salvata: la camera è lì, tutti (OBS, successiva/precedente) lo sanno
  ipcMain.on('cam:setActive', (_e, id) => {
    hub.setActive(store.presets.some((p) => p.id === id) ? id : null);
  });
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
      defaultPath: path.join(app.getPath('documents'), `ptz-panel-presets-${os.userInfo().username}.json`),
      filters: [{ name: t('main.fileFilter'), extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, JSON.stringify({
      version: 1, app: 'PTZ Panel', exportedBy: os.userInfo().username, exportedAt: new Date().toISOString(), presets: list,
    }, null, 2));
    return r.filePath;
  });

  ipcMain.handle('presets:import', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: t('main.importTitle'),
      properties: ['openFile'],
      filters: [{ name: t('main.fileFilter'), extensions: ['json'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    if (!Array.isArray(data.presets)) throw new Error(t('main.invalidFile'));
    return data.presets;
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
        case 'stop': hub.stop(); break;
        default: break;
      }
    } catch (e) {
      send('cam:log', e.message);
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

  ipcMain.handle('detect:discover', async () => {
    const [onvif, scan] = await Promise.all([probe.wsDiscovery(), probe.scanNetwork()]);
    const byIp = new Map();
    for (const s of scan) byIp.set(s.ip, { ip: s.ip, rtsp: s.rtsp, http: s.http });
    for (const d of onvif) byIp.set(d.ip, { ...(byIp.get(d.ip) || { ip: d.ip }), onvif: true, name: d.name, hardware: d.hardware });
    const out = [...byIp.values()];
    out.sort((a, b) => (Number(!!b.onvif) + Number(!!b.rtsp)) - (Number(!!a.onvif) + Number(!!a.rtsp)));
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
      const t = await testUrl(full, 7000);
      results.push({ url: full, display: c.url, note: c.note, ok: t.ok, error: t.error });
      if (results.filter((r) => r.ok).length >= 3) break;
    }
    return results;
  });

  ipcMain.handle('detect:testUrl', (_e, url) => testUrl(url, 7000));

  ipcMain.on('preview:ack', () => { frameInFlight = false; });

  ipcMain.handle('app:setCompact', (_e, on) => { setCompact(!!on); return store.settings.compact; });
  ipcMain.handle('app:openDataFolder', () => shell.openPath(app.getPath('userData')));
  ipcMain.handle('update:check', () => runUpdateCheck());
  ipcMain.handle('update:open', () => {
    const url = updateStatus && updateStatus.url;
    if (!updates.isSafeReleaseUrl(url, UPDATE_REPO)) return false;
    shell.openExternal(url);
    return true;
  });
}

// ---------------------------------------------------------------------------

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  if (!gotLock) return;
  const sharedDefaults = path.join(path.dirname(process.execPath), 'ptz-defaults.json');
  store = new Store(app.getPath('userData'), sharedDefaults, os.userInfo().username);
  I18N.setLang(I18N.resolve(store.settings.language, app.getLocale()));
  if (store.settings.compact) normalBounds = store.settings.bounds;
  hub = new Hub({ store, getCamera: () => camera, getCamStatus: () => camStatus });
  hub.on('active', (id) => send('preset:active', id));
  hub.on('stopped', () => send('hotkey', { type: 'stop' }));
  control = new ControlServer(hub);
  control.on('status', (st) => { apiStatus = st; send('api:status', st); });
  registerIpc();
  createWindow();
  startCamera();
  startPreview();
  applyGlobalHotkeys();
  startControl().catch((e) => { apiStatus = { state: 'error', detail: e.message }; });
  scheduleUpdateChecks();
});

// In uscita si manda lo stop e si aspetta che parta prima di chiudere i socket
let quitting = false;
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

// Un errore imprevisto non deve aprire finestre bloccanti durante l'evento
process.on('uncaughtException', (err) => {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'errori.log'), `${new Date().toISOString()} ${err && err.stack ? err.stack : err}\n`);
  } catch (_) { /* ignora */ }
  send('cam:log', t('main.internalError', { error: err && err.message ? err.message : err }));
});
process.on('unhandledRejection', (err) => {
  send('cam:log', t('main.internalError', { error: err && err.message ? err.message : err }));
});

app.on('window-all-closed', () => app.quit());
