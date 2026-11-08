'use strict';
// Telecamera ONVIF finta con password (WS-Security UsernameToken): per i test e per la prova
// completa del primo avvio (PTZ_SMOKE=wizauth). Da riga di comando: node test/fake-onvif.js 8080 [dahua|digest]
const http = require('http');
const crypto = require('crypto');

const USER = 'admin';
const PASS = 'segreta';
const REALM = 'fake-onvif';
const DIGEST_NONCE = 'b1c2d3e4f5';
const state = { x: 0, y: 0, zoom: 0, calls: [], failNextStop: false, slowMs: 0, auth: null };

// Come controlla l'accesso la camera finta. I valori predefiniti sono quelli di una camera ONVIF
// normale; gli altri riproducono i casi visti sulle Dahua (ora dichiarata sbagliata, ecc.).
function resetAuth(over = {}) {
  state.auth = {
    off: false, // autenticazione ONVIF spenta: accetta tutto
    windowMs: null, // tolleranza sull'ora della firma (null = non la controlla)
    clockMs: 0, // ora vera della camera rispetto al PC
    reportSkewMs: 0, // errore dell'ora UTC dichiarata in GetSystemDateAndTime
    localMs: 3600000, // ora locale = UTC + questo (fuso orario)
    validate: 'utc', // la firma si controlla con l'ora vera (utc) o con l'ora locale letta come UTC (local)
    wsseBroken: false, // rifiuta sempre la firma WS-Security
    httpDigest: false, // accetta Digest HTTP (senza firma risponde 401 con la sfida)
    preAuthCaps: false, // GetCapabilities risponde anche senza password
    lockAfter: 0, // dopo tanti errori blocca l'utente
    failures: 0, // tentativi con credenziali rifiutati
    ...over,
  };
  return state.auth;
}
resetAuth();

const sha1 = (b) => crypto.createHash('sha1').update(b).digest('base64');
const md5 = (x) => crypto.createHash('md5').update(x).digest('hex');

function checkWsse(body) {
  const nonce = /<Nonce[^>]*>([^<]+)<\/Nonce>/.exec(body);
  const created = /<Created[^>]*>([^<]+)<\/Created>/.exec(body);
  const pwd = /<Password[^>]*>([^<]+)<\/Password>/.exec(body);
  if (!nonce || !created || !pwd) return false;
  const d = sha1(Buffer.concat([Buffer.from(nonce[1], 'base64'), Buffer.from(created[1]), Buffer.from(PASS)]));
  if (d !== pwd[1]) return false;
  const a = state.auth;
  if (a.windowMs == null) return true;
  const ref = Date.now() + a.clockMs + (a.validate === 'local' ? a.localMs : 0);
  return Math.abs(Date.parse(created[1]) - ref) <= a.windowMs;
}

function checkDigest(h, url) {
  const f = {};
  h.replace(/^Digest\s+/i, '').replace(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g, (_, k, q, v) => { f[k] = q ?? v; });
  if (f.username !== USER || f.nonce !== DIGEST_NONCE) return false;
  const ha1 = md5(`${USER}:${REALM}:${PASS}`);
  const ha2 = md5(`POST:${url}`);
  const want = f.qop ? md5(`${ha1}:${f.nonce}:${f.nc}:${f.cnonce}:${f.qop}:${ha2}`) : md5(`${ha1}:${f.nonce}:${ha2}`);
  return want === f.response;
}

const dt = (ms) => {
  const n = new Date(ms);
  return `<tt:Time><tt:Hour>${n.getUTCHours()}</tt:Hour><tt:Minute>${n.getUTCMinutes()}</tt:Minute><tt:Second>${n.getUTCSeconds()}</tt:Second></tt:Time><tt:Date><tt:Year>${n.getUTCFullYear()}</tt:Year><tt:Month>${n.getUTCMonth() + 1}</tt:Month><tt:Day>${n.getUTCDate()}</tt:Day></tt:Date>`;
};

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
      const a = state.auth;
      const open = a.off || op === 'GetSystemDateAndTime' || (op === 'GetCapabilities' && a.preAuthCaps);
      if (!open) {
        const authz = req.headers.authorization || '';
        const hasWsse = /<Password/.test(body);
        let ok = false;
        if (a.lockAfter && a.failures >= a.lockAfter) {
          res.writeHead(400, { 'Content-Type': 'application/soap+xml' });
          res.end(env('<SOAP-ENV:Fault><SOAP-ENV:Reason><SOAP-ENV:Text xml:lang="en">User locked</SOAP-ENV:Text></SOAP-ENV:Reason></SOAP-ENV:Fault>'));
          return;
        }
        if (hasWsse) ok = !a.wsseBroken && checkWsse(body); // la firma, se c'è, si controlla per prima
        else if (authz && a.httpDigest) ok = checkDigest(authz, req.url);
        if (!ok) {
          if (hasWsse || authz) a.failures += 1;
          if (a.httpDigest && !hasWsse && !authz) {
            res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${REALM}", qop="auth", nonce="${DIGEST_NONCE}"` });
            res.end();
            return;
          }
          res.writeHead(400, { 'Content-Type': 'application/soap+xml' });
          res.end(env('<SOAP-ENV:Fault><SOAP-ENV:Code><SOAP-ENV:Value>SOAP-ENV:Sender</SOAP-ENV:Value><SOAP-ENV:Subcode><SOAP-ENV:Value>ter:NotAuthorized</SOAP-ENV:Value></SOAP-ENV:Subcode></SOAP-ENV:Code><SOAP-ENV:Reason><SOAP-ENV:Text xml:lang="en">Sender not Authorized</SOAP-ENV:Text></SOAP-ENV:Reason></SOAP-ENV:Fault>'));
          return;
        }
      }
      const base = `http://10.99.99.99:${port}`; // IP volutamente sbagliato: il client deve correggerlo
      let out = '';
      switch (op) {
        case 'GetSystemDateAndTime': {
          const utc = Date.now() + a.clockMs + a.reportSkewMs;
          out = `<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:UTCDateTime>${dt(utc)}</tt:UTCDateTime><tt:LocalDateTime>${dt(utc + a.localMs)}</tt:LocalDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`;
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


// casi pronti per la prova completa (PTZ_SMOKE=wizauth) e da riga di comando
const PRESETS = {
  // Dahua con ora o ora legale sbagliate: l'ora UTC dichiarata è avanti di un'ora
  dahua: { windowMs: 5000, reportSkewMs: 3600000, preAuthCaps: true },
  // accetta solo il Digest HTTP
  digest: { wsseBroken: true, httpDigest: true },
};

function createFakeOnvif({ port = 8080, preset } = {}) {
  if (preset) resetAuth(PRESETS[preset] || {});
  return { srv: serve(port), state };
}

module.exports = {
  createFakeOnvif, serve, state, resetAuth, PRESETS, USER, PASS,
};

if (require.main === module) {
  const preset = process.argv[3] || '';
  createFakeOnvif({ port: Number(process.argv[2]) || 8080, preset });
  console.log(`ONVIF finta pronta${preset ? ` (${preset})` : ''}`);
}
