'use strict';
// Rilevamento telecamere e protocolli: WS-Discovery, scansione della rete,
// test VISCA (UDP/TCP/Sony), ONVIF, HTTP e percorsi RTSP.
// Usato sia dall'app sia dallo script da riga di comando (tools/rileva-camera.js).

const dgram = require('dgram');
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const { ViscaTransport, fromNibbles, hex } = require('./visca');
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

// Trova host con porte tipiche delle telecamere aperte (RTSP 554 / HTTP 80)
async function scanNetwork({ extra = KNOWN_DEFAULT_IPS, onProgress } = {}) {
  const targets = [...new Set([...scanTargets(), ...extra])];
  let n = 0;
  const res = await mapLimit(targets, 96, async (ip) => {
    const [rtsp, http] = await Promise.all([tcpOpen(ip, 554), tcpOpen(ip, 80)]);
    n++;
    if (onProgress && n % 32 === 0) onProgress(n, targets.length);
    return (rtsp || http) ? { ip, rtsp, http } : null;
  });
  return res.filter(Boolean);
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
  probeVisca, probeOnvif, probeHttp, rtspDescribe, findRtsp,
};
