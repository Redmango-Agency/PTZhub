'use strict';
// Windows: chi ha la precedenza sulla camera USB (OBS, Zoom…), letto da tasklist e dal registro
// della privacy di Windows. Qui si provano le letture con risposte di esempio.
const assert = require('assert');
const { parseTasklist, parseWebcamInUse, cameraApps } = require('../src/main/cam-apps');

let pass = 0;
const ok = (name) => { pass += 1; console.log(`  ok  ${name}`); };

const TASKLIST = [
  '"System Idle Process","0","Services","0","8 K"',
  '"obs64.exe","4120","Console","1","210.512 K"',
  '"Zoom.exe","5120","Console","1","120.000 K"',
  '"PTZ Hub.exe","6000","Console","1","90.000 K"',
  '"chrome.exe","7000","Console","1","300.000 K"',
].join('\r\n');

const KEY = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\webcam';
const REG = [
  `${KEY}\\NonPackaged\\C:#Program Files#obs-studio#bin#64bit#obs64.exe`,
  '    LastUsedTimeStop    REG_QWORD    0x1db2c5e1a2b3c4d',
  '',
  `${KEY}\\NonPackaged\\C:#Users#mario#AppData#Roaming#Zoom#bin#Zoom.exe`,
  '    LastUsedTimeStop    REG_QWORD    0x0',
  '',
  `${KEY}\\NonPackaged\\C:#Program Files#PTZ Hub#PTZ Hub.exe`,
  '    LastUsedTimeStop    REG_QWORD    0x0',
  '',
  `${KEY}\\NonPackaged\\C:#Program Files#Skype#Skype.exe`,
  '    LastUsedTimeStop    REG_QWORD    0x0',
  '',
  `${KEY}\\Microsoft.WindowsCamera_8wekyb3d8bbwe`,
  '    LastUsedTimeStop    REG_QWORD    0x0',
].join('\r\n');

const running = parseTasklist(TASKLIST);
assert.ok(running.has('obs64.exe') && running.has('zoom.exe') && running.has('ptz hub.exe'));
ok('programmi aperti letti da tasklist');

const inUse = parseWebcamInUse(REG);
assert.deepStrictEqual(inUse.map((u) => u.exe), ['zoom.exe', 'ptz hub.exe', 'skype.exe', 'Microsoft.WindowsCamera']);
ok('programmi con la camera aperta adesso letti dal registro di Windows');

// OBS aperto: precedenza anche se non ha ancora la camera; Zoom con la camera aperta;
// PTZ Hub escluso; Skype nel registro ma già chiuso: escluso; app Fotocamera dello Store inclusa
assert.deepStrictEqual(cameraApps({ running, inUse, self: ['PTZ Hub.exe'] }), ['OBS', 'Zoom', 'WindowsCamera']);
ok('OBS e Zoom hanno la precedenza, PTZ Hub e i programmi chiusi no');

assert.deepStrictEqual(cameraApps({ running: parseTasklist('"chrome.exe","1","Console","1","1 K"'), inUse: [], self: [] }), []);
ok('nessun programma di regia o videochiamata: la camera è libera');

console.log(`cam-apps: ${pass} test superati`);
