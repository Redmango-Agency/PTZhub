'use strict';
// Rilevamento telecamere e protocolli: WS-Discovery, scansione della rete,
// test VISCA (UDP/TCP/Sony), ONVIF, HTTP e percorsi RTSP.
// Usato sia dall'app sia dallo script da riga di comando (tools/rileva-camera.js).

const dgram = require('dgram');
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const { ViscaTransport, fromNibbles, splitMessages, hex } = require('./visca');
const { OnvifClient, httpRequest, section } = require('./onvif');

const KNOWN_DEFAULT_IPS = ['192.168.5.163', '192.168.1.188', '192.168.100.88', '192.168.1.18', '192.168.0.88'];

const RTSP_PATHS = [
  '/1', '/2', '/live/av0', '/live/av1', '/stream1', '/stream2', '/live/main', '/live/sub',
  '/h264', '/11', '/12', '/live', '/main', '/sub', '/ch01.264', '/cam/realmonitor?channel=1&subtype=0',
];

function localNetworks() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue;
      out.push({ iface: name, address: a.address, netmask: a.netmask });
    }
  }
  return out;
}

// Indirizzi da scansionare: la /24 di ogni interfaccia (anche se la maschera è più ampia)
function scanTargets() {
  const set = new Set();
  for (const n of localNetworks()) {
    const p = n.address.split('.').map(Number);
    for (let i = 1; i < 255; i++) {
      const ip = `${p[0]}.${p[1]}.${p[2]}.${i}`;
      if (ip !== n.address) set.add(ip);
    }
  }
  return [...set];
}

function wsDiscovery(timeoutMs = 2500) {
  return new Promise((resolve) => {
    const found = new Map();
    const sockets = [];
    const msgId = `uuid:${crypto.randomUUID()}`;
    const probe = Buffer.from('<?xml version="1.0" encoding="UTF-8"?>'
      + '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" '
      + 'xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">'
      + `<e:Header><w:MessageID>${msgId}</w:MessageID><w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>`
      + '<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>'
      + '<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>');

    const onMsg = (msg, rinfo) => {
      const xml = msg.toString('utf8');
      const xaddrs = (section(xml, 'XAddrs') || '').trim().split(/\s+/).filter(Boolean);
      const scopes = (section(xml, 'Scopes') || '').trim().split(/\s+/);
      const scope = (k) => {
        const s = scopes.find((x) => x.includes(`/${k}/`));
        if (!s) return null;
        const v = s.split(`/${k}/`)[1] || '';
        try { return decodeURIComponent(v); } catch (_) { return v; }
      };
      found.set(rinfo.address, {
        ip: rinfo.address,
        xaddrs,
        name: scope('name'),
        hardware: scope('hardware'),
      });
    };

    const nets = localNetworks();
    const ifaces = nets.length ? nets.map((n) => n.address) : [null];
    for (const addr of ifaces) {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sockets.push(s);
      s.on('message', onMsg);
      s.on('error', () => {});
      s.bind(0, addr || undefined, () => {
        try { if (addr) s.setMulticastInterface(addr); } catch (_) { /* ignora */ }
        s.send(probe, 3702, '239.255.255.250', () => {});
        setTimeout(() => { try { s.send(probe, 3702, '239.255.255.250', () => {}); } catch (_) { /* chiuso */ } }, 400);
      });
    }
    setTimeout(() => {
      for (const s of sockets) { try { s.close(); } catch (_) { /* ignora */ } }
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

function tcpOpen(host, port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    let done = false;
    const finish = (ok) => { if (done) return; done = true; s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => finish(false));
    s.on('connect', () => finish(true));
    s.on('error', () => finish(false));
  });
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------------------
// Ricerca in rete: compaiono solo i dispositivi che parlano davvero un protocollo da telecamera
// (VISCA, RTSP; ONVIF arriva da wsDiscovery). Una porta aperta non basta: router, telefoni VoIP,
// stampanti e NAS hanno la pagina web, e la 5678 può essere un altro servizio (es. n8n).

// inquiry «accensione» (81 09 04 00 FF): ogni camera VISCA risponde 90 50 0x FF (o con un errore 90 6x)
const VISCA_POWER_INQ = Buffer.from([0x81, 0x09, 0x04, 0x00, 0xff]);

function isViscaReply(m) {
  return !!m && m.length >= 3 && m[m.length - 1] === 0xff
    && m[0] >= 0x90 && (m[0] & 0x0f) === 0
    && [0x40, 0x50, 0x60].includes(m[1] & 0xf0);
}

// Manda l'inquiry VISCA via UDP a tutti gli indirizzi e raccoglie chi risponde (una sola socket)
function viscaSweep(targets, { port = 1259, sony = false, timeoutMs = 1200 } = {}) {
  return new Promise((resolve) => {
    const found = new Set();
    const sock = dgram.createSocket('udp4');
    const pkt = sony
      ? Buffer.concat([Buffer.from([0x01, 0x10, 0x00, VISCA_POWER_INQ.length, 0, 0, 0, 0]), VISCA_POWER_INQ])
      : VISCA_POWER_INQ;
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      try { sock.close(); } catch (_) { /* già chiusa */ }
      resolve(found);
    };
    sock.on('error', () => {}); // «porta non raggiungibile» dagli indirizzi senza camera: normale
    sock.on('message', (msg, rinfo) => {
      if (sony) {
        // Sony VISCA over IP: intestazione di 8 byte; 0x0111 = risposta VISCA, 0x0201 = risposta di controllo
        if (msg.length < 8) return;
        const type = msg.readUInt16BE(0);
        if (type === 0x0201 || (type === 0x0111 && isViscaReply(msg.subarray(8)))) found.add(rinfo.address);
        return;
      }
      if (isViscaReply(msg)) found.add(rinfo.address);
    });
    sock.bind(0, () => {
      const sendAll = () => {
        for (const ip of targets) {
          if (closed) return;
          try { sock.send(pkt, port, ip, () => {}); } catch (_) { /* indirizzo non valido */ }
        }
      };
      sendAll();
      setTimeout(() => { if (!closed) sendAll(); }, 350); // secondo giro: un pacchetto UDP può perdersi
      setTimeout(finish, timeoutMs);
    });
  });
}

// Apre una connessione TCP, manda `request` e dice se la risposta va bene secondo `accept`
function tcpAsk(host, port, request, accept, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (ok) => { if (done) return; done = true; s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => finish(false));
    s.on('connect', () => s.write(request));
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (accept(buf)) finish(true);
      else if (buf.length > 4096) finish(false);
    });
    s.on('error', () => finish(false));
    s.on('close', () => finish(false));
  });
}

// RTSP vero (non solo la porta 554 aperta): OPTIONS deve rispondere «RTSP/1.x»
function rtspAnswers(host, port = 554) {
  const req = `OPTIONS rtsp://${host}:${port}/ RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: PTZHub\r\n\r\n`;
  return tcpAsk(host, port, req, (b) => b.length >= 8 && b.toString('latin1', 0, 7) === 'RTSP/1.');
}

// VISCA over IP via TCP: l'inquiry deve avere una risposta VISCA valida
function viscaTcpAnswers(host, port = 5678) {
  return tcpAsk(host, port, VISCA_POWER_INQ, (buf) => splitMessages(buf).messages.some(isViscaReply));
}

// Trova le telecamere nelle reti di questo PC. Ritorna [{ ip, rtsp, visca: 'udp'|'sony'|'tcp'|null }]:
// solo chi risponde in VISCA (UDP 1259, Sony 52381, TCP 5678) o in RTSP (554).
// `targets` e `ports` servono ai test (indirizzi e porte diversi da quelli standard).
async function scanNetwork({ extra = KNOWN_DEFAULT_IPS, onProgress, targets: only, ports = {} } = {}) {
  const P = { rtsp: 554, viscaTcp: 5678, viscaUdp: 1259, sony: 52381, ...ports };
  const targets = only || [...new Set([...scanTargets(), ...extra])];
  let n = 0;
  const [udp, sony, hosts] = await Promise.all([
    viscaSweep(targets, { port: P.viscaUdp }),
    viscaSweep(targets, { port: P.sony, sony: true }),
    mapLimit(targets, 96, async (ip) => {
      const [rtspOpen, tcpViscaOpen] = await Promise.all([tcpOpen(ip, P.rtsp), tcpOpen(ip, P.viscaTcp)]);
      const [rtsp, viscaTcp] = await Promise.all([
        rtspOpen ? rtspAnswers(ip, P.rtsp) : false,
        tcpViscaOpen ? viscaTcpAnswers(ip, P.viscaTcp) : false,
      ]);
      n++;
      if (onProgress && n % 32 === 0) onProgress(n, targets.length);
      return { ip, rtsp, viscaTcp };
    }),
  ]);
  const out = [];
  for (const h of hosts) {
    const visca = udp.has(h.ip) ? 'udp' : sony.has(h.ip) ? 'sony' : h.viscaTcp ? 'tcp' : null;
    if (h.rtsp || visca) out.push({ ip: h.ip, rtsp: h.rtsp, visca });
  }
  return out;
}

async function probeVisca(host, { address = 1 } = {}) {
  const variants = [
    { mode: 'udp', port: 1259, label: 'VISCA over IP UDP 1259' },
    { mode: 'sony', port: 52381, label: 'Sony VISCA over IP 52381' },
    { mode: 'tcp', port: 5678, label: 'VISCA over IP TCP 5678' },
  ];
  const out = [];
  for (const v of variants) {
    const t = new ViscaTransport({ host, port: v.port, mode: v.mode, address });
    const r = { ...v, ok: false, position: false };
    t.on('error', () => {});
    try {
      await Promise.race([t.open(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3500))]);
      const pw = await t.inquire([0x09, 0x04, 0x00], 1000);
      r.ok = true;
      r.power = pw[2] === 0x02 ? 'accesa' : pw[2] === 0x03 ? 'standby' : hex(pw);
      try {
        const pt = await t.inquire([0x09, 0x06, 0x12], 1000);
        const data = pt.subarray(2, pt.length - 1);
        const d = data.length - 4;
        r.panTilt = { pan: fromNibbles(data.subarray(0, d)), tilt: fromNibbles(data.subarray(d)), panDigits: d, rawReply: hex(pt) };
        const z = await t.inquire([0x09, 0x04, 0x47], 1000);
        r.zoom = fromNibbles(z.subarray(2, 6));
        r.position = true;
      } catch (e) {
        r.positionError = e.message;
      }
    } catch (e) {
      r.error = e.message;
    } finally {
      t.close();
    }
    out.push(r);
  }
  return out;
}

async function probeOnvif(host, { user = '', pass = '', ports = [80, 8000, 8080, 2020, 8899] } = {}) {
  for (const port of ports) {
    const c = new OnvifClient({ host, port, user, pass });
    try {
      await c.call(c.deviceUrl, '<tds:GetSystemDateAndTime/>', { auth: false, timeout: 1500 });
    } catch (e) {
      if (!e.status) continue; // nessun servizio ONVIF su questa porta
    }
    const r = { port, ok: true };
    try {
      await c.init();
      r.ptz = !!c.ptzUrl;
      r.profiles = c.profiles;
      r.streams = await c.streamUris();
      try {
        const st = await c.ptz(`<tptz:GetStatus>${c.pt()}</tptz:GetStatus>`);
        r.position = /Position/.test(st);
      } catch (e) {
        r.positionError = e.message;
      }
    } catch (e) {
      r.error = e.message;
    }
    return r;
  }
  return { ok: false };
}

async function probeHttp(host) {
  try {
    const r = await httpRequest(`http://${host}/`, { timeout: 2500 });
    const title = (/<title>([^<]*)<\/title>/i.exec(r.text) || [])[1] || null;
    return { ok: true, status: r.status, title, server: r.headers.get('server') };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// RTSP DESCRIBE: 200 = percorso valido, 401 = serve password (o percorso non verificabile), 404 = inesistente
function rtspDescribe(url, { user, pass, timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (_) { resolve({ url, status: 0 }); return; }
    const cleanUrl = `rtsp://${u.hostname}:${u.port || 554}${u.pathname}${u.search}`;
    const s = net.createConnection({ host: u.hostname, port: Number(u.port) || 554 });
    let buf = '';
    let cseq = 1;
    let triedAuth = false;
    const finish = (status, extra = {}) => { s.destroy(); resolve({ url: cleanUrl, status, ...extra }); };
    const send = (auth) => {
      s.write(`DESCRIBE ${cleanUrl} RTSP/1.0\r\nCSeq: ${cseq++}\r\nAccept: application/sdp\r\nUser-Agent: PTZPanel\r\n${auth ? `Authorization: ${auth}\r\n` : ''}\r\n`);
    };
    s.setTimeout(timeoutMs, () => finish(0, { error: 'timeout' }));
    s.on('error', (e) => finish(0, { error: e.message }));
    s.on('connect', () => send(null));
    s.on('data', (d) => {
      buf += d.toString('latin1');
      const headEnd = buf.indexOf('\r\n\r\n');
      if (headEnd < 0) return;
      const head = buf.slice(0, headEnd);
      const status = parseInt((/^RTSP\/1\.\d (\d+)/.exec(head) || [])[1], 10) || 0;
      if (status === 401 && user && !triedAuth) {
        triedAuth = true;
        const wa = (/WWW-Authenticate:\s*(.+)/i.exec(head) || [])[1] || '';
        buf = '';
        if (/^digest/i.test(wa)) {
          const ch = {};
          wa.replace(/(\w+)="([^"]*)"/g, (_, k, v) => { ch[k.toLowerCase()] = v; });
          const md5 = (x) => crypto.createHash('md5').update(x).digest('hex');
          const ha1 = md5(`${user}:${ch.realm}:${pass}`);
          const ha2 = md5(`DESCRIBE:${cleanUrl}`);
          const resp = md5(`${ha1}:${ch.nonce}:${ha2}`);
          send(`Digest username="${user}", realm="${ch.realm}", nonce="${ch.nonce}", uri="${cleanUrl}", response="${resp}"`);
        } else {
          send('Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'));
        }
        return;
      }
      const video = /m=video/.test(buf);
      finish(status, { video });
    });
  });
}

async function findRtsp(host, { user = '', pass = '' } = {}) {
  const results = [];
  for (const p of RTSP_PATHS) {
    // eslint-disable-next-line no-await-in-loop
    const r = await rtspDescribe(`rtsp://${host}:554${p}`, { user, pass });
    results.push(r);
    if (r.status === 0 && /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/.test(r.error || '')) break;
  }
  return results;
}

module.exports = {
  KNOWN_DEFAULT_IPS, RTSP_PATHS, localNetworks, wsDiscovery, scanNetwork, tcpOpen,
  viscaSweep, rtspAnswers, viscaTcpAnswers, isViscaReply,
  probeVisca, probeOnvif, probeHttp, rtspDescribe, findRtsp,
};
