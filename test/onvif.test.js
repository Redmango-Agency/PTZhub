'use strict';
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const { OnvifCamera } = require('../src/main/onvif');
const { probeOnvif } = require('../src/main/probe');

const USER = 'admin';
const PASS = 'segreta';
const state = { x: 0, y: 0, zoom: 0, calls: [], failNextStop: false, slowMs: 0 };

function checkAuth(body) {
  const nonce = /<Nonce[^>]*>([^<]+)<\/Nonce>/.exec(body);
  const created = /<Created[^>]*>([^<]+)<\/Created>/.exec(body);
  const pwd = /<Password[^>]*>([^<]+)<\/Password>/.exec(body);
  if (!nonce || !created || !pwd) return false;
  const d = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(nonce[1], 'base64'), Buffer.from(created[1]), Buffer.from(PASS)])).digest('base64');
  return d === pwd[1];
}

const env = (b) => `<?xml version="1.0"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:tds="x" xmlns:trt="x" xmlns:tptz="x"><SOAP-ENV:Body>${b}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;

function serve(port) {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const op = (/<s:Body><(?:\w+:)?(\w+)/.exec(body) || [])[1];
      state.calls.push(op);
      if (op === 'Stop' && state.failNextStop) {
        state.failNextStop = false;
        res.writeHead(500); res.end('busy');
        return;
      }
      if (op !== 'GetSystemDateAndTime' && !checkAuth(body)) {
        res.writeHead(400, { 'Content-Type': 'application/soap+xml' });
        res.end(env('<SOAP-ENV:Fault><SOAP-ENV:Reason><SOAP-ENV:Text xml:lang="en">Sender not Authorized</SOAP-ENV:Text></SOAP-ENV:Reason></SOAP-ENV:Fault>'));
        return;
      }
      const base = `http://10.99.99.99:${port}`; // IP volutamente sbagliato: il client deve correggerlo
      let out = '';
      switch (op) {
        case 'GetSystemDateAndTime': {
          const n = new Date();
          out = `<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:UTCDateTime><tt:Time><tt:Hour>${n.getUTCHours()}</tt:Hour><tt:Minute>${n.getUTCMinutes()}</tt:Minute><tt:Second>${n.getUTCSeconds()}</tt:Second></tt:Time><tt:Date><tt:Year>${n.getUTCFullYear()}</tt:Year><tt:Month>${n.getUTCMonth() + 1}</tt:Month><tt:Day>${n.getUTCDate()}</tt:Day></tt:Date></tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`;
          break;
        }
        case 'GetCapabilities':
          out = `<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Device><tt:XAddr>${base}/onvif/device_service</tt:XAddr></tt:Device><tt:Imaging><tt:XAddr>${base}/onvif/imaging</tt:XAddr></tt:Imaging><tt:Media><tt:XAddr>${base}/onvif/media</tt:XAddr></tt:Media><tt:PTZ><tt:XAddr>${base}/onvif/ptz</tt:XAddr></tt:PTZ></tds:Capabilities></tds:GetCapabilitiesResponse>`;
          break;
        case 'GetProfiles':
          out = '<trt:GetProfilesResponse>'
            + '<trt:Profiles token="Main" fixed="true"><tt:Name>main</tt:Name><tt:VideoSourceConfiguration token="vsc"><tt:SourceToken>VS1</tt:SourceToken></tt:VideoSourceConfiguration><tt:VideoEncoderConfiguration><tt:Resolution><tt:Width>1920</tt:Width><tt:Height>1080</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration><tt:PTZConfiguration token="ptz"/></trt:Profiles>'
            + '<trt:Profiles token="Sub" fixed="true"><tt:Name>sub</tt:Name><tt:VideoEncoderConfiguration><tt:Resolution><tt:Width>640</tt:Width><tt:Height>360</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration></trt:Profiles>'
            + '</trt:GetProfilesResponse>';
          break;
        case 'GetStreamUri': {
          const tok = /ProfileToken>([^<]+)</.exec(body)[1];
          out = `<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>rtsp://10.99.99.99:554/${tok === 'Main' ? '1' : '2'}</tt:Uri></trt:MediaUri></trt:GetStreamUriResponse>`;
          break;
        }
        case 'GetStatus':
          out = `<tptz:GetStatusResponse><tptz:PTZStatus><tt:Position><tt:PanTilt x="${state.x}" y="${state.y}" space="x"/><tt:Zoom x="${state.zoom}" space="x"/></tt:Position></tptz:PTZStatus></tptz:GetStatusResponse>`;
          break;
        case 'ContinuousMove': {
          const m = /PanTilt x="([^"]+)" y="([^"]+)"/.exec(body);
          state.x += parseFloat(m[1]) * 0.1;
          state.y += parseFloat(m[2]) * 0.1;
          out = '<tptz:ContinuousMoveResponse/>';
          break;
        }
        case 'AbsoluteMove': {
          const m = /<tptz:Position><tt:PanTilt x="([^"]+)" y="([^"]+)"\/><tt:Zoom x="([^"]+)"/.exec(body);
          state.x = parseFloat(m[1]); state.y = parseFloat(m[2]); state.zoom = parseFloat(m[3]);
          out = '<tptz:AbsoluteMoveResponse/>';
          break;
        }
        default:
          out = `<x:${op}Response/>`;
      }
      res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
      res.end(env(out));
    });
  });
  srv.listen(port);
  return srv;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const port = 18080;
  const srv = serve(port);
  await sleep(100);

  // password sbagliata -> errore leggibile
  const bad = new OnvifCamera({ host: '127.0.0.1', port, user: USER, pass: 'no' });
  await bad.connect();
  assert.strictEqual(bad.state, 'error');
  assert.ok(/not Authorized/.test(bad.detail), bad.detail);
  bad.closed = true; clearTimeout(bad.retryTimer);

  const cam = new OnvifCamera({ host: '127.0.0.1', port, user: USER, pass: PASS });
  await cam.connect();
  assert.strictEqual(cam.state, 'connected', cam.detail);
  assert.ok(cam.c.ptzUrl.startsWith('http://127.0.0.1:18080/'), cam.c.ptzUrl);

  cam.move(1, 0.5);
  cam.move(0.8, 0.5);
  cam.move(0, 0);
  await sleep(200);
  assert.ok(state.calls.includes('Stop'), 'stop inviato');
  assert.strictEqual(state.calls[state.calls.length - 1], 'Stop', 'lo stop è l’ultimo comando');

  const p = await cam.getPosition();
  assert.strictEqual(p.kind, 'onvif');
  assert.ok(p.x > 0);

  await cam.gotoPosition({ kind: 'onvif', x: -0.25, y: 0.4, zoom: 0.7 }, 0.5);
  const p2 = await cam.getPosition();
  assert.deepStrictEqual([p2.x, p2.y, p2.zoom], [-0.25, 0.4, 0.7]);

  // stop che fallisce la prima volta: viene ritentato
  state.calls = [];
  state.failNextStop = true;
  cam.move(0.5, 0);
  cam.move(0, 0);
  await sleep(700);
  assert.deepStrictEqual(state.calls.filter((c) => c === 'Stop').length, 2, `stop ritentato: ${state.calls}`);

  // richiamo subito dopo aver lasciato il joystick: lo stop arriva PRIMA del richiamo
  state.calls = [];
  cam.move(1, 1);
  cam.move(0, 0);
  await cam.gotoPosition({ kind: 'onvif', x: 0.1, y: 0.2, zoom: 0.3 }, 1);
  assert.strictEqual(state.calls[state.calls.length - 1], 'AbsoluteMove', `ordine: ${state.calls}`);
  assert.ok(/Timeout/.test('Timeout'));

  const pr = await probeOnvif('127.0.0.1', { user: USER, pass: PASS, ports: [18080] });
  assert.ok(pr.ok && pr.ptz && pr.position, JSON.stringify(pr));
  assert.deepStrictEqual(pr.streams.map((s) => s.uri), ['rtsp://127.0.0.1:554/1', 'rtsp://127.0.0.1:554/2']);

  await cam.disconnect();
  srv.close();
  console.log('TUTTI I TEST ONVIF PASSATI');
  process.exit(0);
})().catch((e) => { console.error('FALLITO:', e); process.exit(1); });
