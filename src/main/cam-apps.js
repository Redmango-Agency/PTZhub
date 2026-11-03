'use strict';
// Windows: quali programmi stanno usando (o stanno per usare) una videocamera.
// Su Windows una camera USB di solito la apre un solo programma alla volta: l'anteprima di PTZ Hub
// lascia il posto a OBS, Zoom & co. e torna quando la camera è libera (i comandi non ne hanno bisogno).
//  - programmi di regia (OBS, vMix…): appena sono aperti, perché aprono le camere all'avvio;
//  - tutti gli altri (Zoom, Teams, browser…): quando Windows dice che stanno usando la camera adesso
//    (Impostazioni › Privacy › Fotocamera: LastUsedTimeStop = 0), purché il programma sia ancora aperto.

const path = require('path');
const { execFile } = require('child_process');

const PRODUCTION_APPS = [
  { re: /^obs(64|32)?\.exe$/i, name: 'OBS' },
  { re: /^streamlabs (obs|desktop)\.exe$/i, name: 'Streamlabs' },
  { re: /^vmix(64)?\.exe$/i, name: 'vMix' },
  { re: /^xsplit\.core\.exe$/i, name: 'XSplit' },
  { re: /^wirecast\.exe$/i, name: 'Wirecast' },
  { re: /^ecamm.*\.exe$/i, name: 'Ecamm' },
];

const FRIENDLY = {
  'zoom.exe': 'Zoom',
  'ms-teams.exe': 'Teams',
  'teams.exe': 'Teams',
  'chrome.exe': 'Chrome',
  'msedge.exe': 'Edge',
  'firefox.exe': 'Firefox',
  'webex.exe': 'Webex',
  'ciscocollabhost.exe': 'Webex',
  'skype.exe': 'Skype',
  'discord.exe': 'Discord',
  'whatsapp.exe': 'WhatsApp',
};

// tasklist /FO CSV /NH -> nomi degli eseguibili aperti (minuscoli)
function parseTasklist(out) {
  const names = new Set();
  for (const line of String(out || '').split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line.trim());
    if (m) names.add(m[1].toLowerCase());
  }
  return names;
}

// reg query …\ConsentStore\webcam /s /v LastUsedTimeStop -> eseguibili con la camera aperta adesso
function parseWebcamInUse(out) {
  const inUse = [];
  let key = '';
  for (const raw of String(out || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (/^HKEY_/i.test(line)) { key = line; continue; }
    const m = /^LastUsedTimeStop\s+REG_QWORD\s+(0x[0-9a-f]+)/i.exec(line);
    if (!m || !key || Number(m[1]) !== 0) continue;
    const last = key.split('\\').pop() || '';
    // programmi classici: «C:#Program Files#obs-studio#bin#64bit#obs64.exe»; app dello Store: nome del pacchetto
    if (/\\NonPackaged\\/i.test(key)) inUse.push({ exe: path.win32.basename(last.replace(/#/g, '\\')).toLowerCase(), packaged: false });
    else inUse.push({ exe: last.split('_')[0], packaged: true });
  }
  return inUse;
}

const friendly = (exe) => FRIENDLY[exe] || exe.replace(/\.exe$/i, '').replace(/^Microsoft\./, '');

// Elenco dei programmi (nomi da mostrare) per cui l'anteprima deve lasciare la camera.
// self: eseguibili di PTZ Hub stesso, da escludere.
function cameraApps({ running, inUse, self = [] }) {
  const mine = new Set(self.map((s) => s.toLowerCase()));
  const out = [];
  for (const exe of running) {
    const p = PRODUCTION_APPS.find((a) => a.re.test(exe));
    if (p && !out.includes(p.name)) out.push(p.name);
  }
  for (const u of inUse) {
    if (!u.packaged && (mine.has(u.exe) || !running.has(u.exe))) continue; // PTZ Hub o programma già chiuso
    const name = u.packaged ? friendly(u.exe) : (PRODUCTION_APPS.find((a) => a.re.test(u.exe)) || {}).name || friendly(u.exe);
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

const WEBCAM_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\webcam';

async function scanCameraApps(self) {
  if (process.platform !== 'win32') return [];
  const [tl, reg] = await Promise.all([
    run('tasklist', ['/FO', 'CSV', '/NH']),
    run('reg', ['query', WEBCAM_KEY, '/s', '/v', 'LastUsedTimeStop']),
  ]);
  return cameraApps({ running: parseTasklist(tl), inUse: parseWebcamInUse(reg), self });
}

module.exports = { parseTasklist, parseWebcamInUse, cameraApps, scanCameraApps, PRODUCTION_APPS };
