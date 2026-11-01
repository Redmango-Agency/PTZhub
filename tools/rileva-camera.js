#!/usr/bin/env node
'use strict';
// Rileva la telecamera nella rete locale e verifica come si controlla.
// Uso:  node tools/rileva-camera.js [--ip 192.168.1.50] [--user admin] [--pass xxx]
// Richiede solo Node.js (nessun pacchetto da installare).

const fs = require('fs');
const path = require('path');
const probe = require('../src/main/probe');

const argv = process.argv.slice(2);
const arg = (k, d = '') => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};

(async () => {
  const report = { at: new Date().toISOString(), networks: probe.localNetworks(), candidates: [] };
  console.log('Reti di questo computer:', report.networks.map((n) => `${n.address} (${n.iface})`).join(', ') || 'nessuna');

  let ips = [];
  const fixed = arg('ip');
  if (fixed) {
    ips = [fixed];
  } else {
    console.log('\nRicerca ONVIF (WS-Discovery)…');
    const onvif = await probe.wsDiscovery(3000);
    report.wsDiscovery = onvif;
    for (const d of onvif) console.log(`  ${d.ip}  ${d.name || ''} ${d.hardware || ''}`);
    if (!onvif.length) console.log('  nessuna risposta');

    console.log('\nScansione rete (porte 554 RTSP e 80 HTTP)…');
    const scan = await probe.scanNetwork({
      onProgress: (n, tot) => process.stdout.write(`\r  ${n}/${tot}`),
    });
    process.stdout.write('\n');
    report.scan = scan;
    for (const s of scan) console.log(`  ${s.ip}  ${s.rtsp ? 'RTSP ' : ''}${s.visca ? `VISCA (${s.visca})` : ''}`);
    ips = [...new Set([...onvif.map((d) => d.ip), ...scan.filter((s) => s.rtsp).map((s) => s.ip), ...scan.map((s) => s.ip)])].slice(0, 8);
  }

  const user = arg('user', 'admin');
  const pass = arg('pass', '');
  for (const ip of ips) {
    console.log(`\n=== ${ip} ===`);
    const c = { ip };
    c.http = await probe.probeHttp(ip);
    console.log('  Web:', c.http.ok ? `${c.http.status} ${c.http.title || ''} ${c.http.server || ''}` : 'no');
    c.visca = await probe.probeVisca(ip);
    for (const v of c.visca) {
      console.log(`  ${v.label}: ${v.ok ? `OK${v.position ? `, posizione pan=${v.panTilt.pan} tilt=${v.panTilt.tilt} zoom=${v.zoom}` : ` (posizione: ${v.positionError})`}` : 'nessuna risposta'}`);
    }
    c.onvif = await probe.probeOnvif(ip, { user, pass });
    console.log('  ONVIF:', c.onvif.ok ? JSON.stringify({ port: c.onvif.port, ptz: c.onvif.ptz, position: c.onvif.position, error: c.onvif.error, streams: (c.onvif.streams || []).map((s) => s.uri) }) : 'no');
    c.rtsp = await probe.findRtsp(ip, { user, pass });
    const good = c.rtsp.filter((r) => r.status === 200 || r.status === 401);
    console.log('  RTSP:', good.length ? good.map((r) => `${r.url} [${r.status}]`).join('  ') : 'nessun percorso noto');
    report.candidates.push(c);
  }

  const out = path.join(process.cwd(), 'rileva-camera-risultato.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\nRisultato completo salvato in ${out}`);
  process.exit(0);
})().catch((e) => {
  console.error('Errore:', e);
  process.exit(1);
});
