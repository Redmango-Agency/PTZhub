'use strict';
// Test della ricerca in rete: compaiono solo i dispositivi che rispondono come telecamere
// (VISCA via UDP, Sony o TCP, oppure RTSP). Router, telefoni e stampanti con la sola pagina web
// o con porte aperte per altri servizi non devono comparire.

const net = require('net');
const http = require('http');
const assert = require('assert');
const { createFakeCamera } = require('./fake-visca');
const { scanNetwork, isViscaReply, rtspAnswers, viscaTcpAnswers } = require('../src/main/probe');

let pass = 0;
const ok = (name) => { pass += 1; console.log(`  ok  ${name}`); };

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

// porta libera (UDP o TCP) su cui non risponde nessuno
async function freePort() {
  const s = net.createServer();
  const port = await listen(s);
  await new Promise((r) => s.close(r));
  return port;
}

async function main() {
  // --- riconoscimento delle risposte VISCA
  assert.ok(isViscaReply(Buffer.from([0x90, 0x50, 0x02, 0xff])));
  assert.ok(isViscaReply(Buffer.from([0x90, 0x60, 0x02, 0xff])));
  assert.ok(isViscaReply(Buffer.from([0xa0, 0x41, 0xff])));
  assert.ok(!isViscaReply(Buffer.from('HTTP/1.1 200 OK\r\n')));
  assert.ok(!isViscaReply(Buffer.from([0x81, 0x09, 0x04, 0x00, 0xff]))); // comando, non risposta
  assert.ok(!isViscaReply(Buffer.from([0x90, 0x50])));
  ok('risposte VISCA riconosciute');

  // --- camera VISCA simulata su porte di prova
  const ports = { udp: 21259, tcp: 25678, sony: 25381 };
  const cam = createFakeCamera({ udpPort: ports.udp, tcpPort: ports.tcp, sonyPort: ports.sony });

  // server RTSP finto e server che non parlano da telecamera
  const rtsp = net.createServer((s) => s.on('data', () => s.end('RTSP/1.0 200 OK\r\nCSeq: 1\r\nPublic: OPTIONS, DESCRIBE\r\n\r\n')));
  const rtspPort = await listen(rtsp);
  const web = http.createServer((q, r) => r.end('<title>Router</title>'));
  const webPort = await listen(web);
  const other = net.createServer((s) => s.on('data', () => s.end('HTTP/1.1 404 Not Found\r\n\r\n'))); // es. n8n sulla 5678
  const otherPort = await listen(other);
  const nobody = await freePort();
  await new Promise((r) => setTimeout(r, 150));

  assert.strictEqual(await rtspAnswers('127.0.0.1', rtspPort), true);
  assert.strictEqual(await rtspAnswers('127.0.0.1', webPort), false);
  assert.strictEqual(await viscaTcpAnswers('127.0.0.1', ports.tcp), true);
  assert.strictEqual(await viscaTcpAnswers('127.0.0.1', otherPort), false);
  ok('RTSP e VISCA TCP verificati col protocollo, non solo con la porta aperta');

  const scan = (p) => scanNetwork({ targets: ['127.0.0.1'], ports: p });

  // camera VISCA UDP (Tenveo, PTZOptics…) con video RTSP
  let r = await scan({ viscaUdp: ports.udp, sony: nobody, viscaTcp: nobody, rtsp: rtspPort });
  assert.deepStrictEqual(r, [{ ip: '127.0.0.1', rtsp: true, visca: 'udp' }]);
  ok('camera VISCA UDP con video RTSP trovata');

  r = await scan({ viscaUdp: nobody, sony: ports.sony, viscaTcp: nobody, rtsp: nobody });
  assert.deepStrictEqual(r, [{ ip: '127.0.0.1', rtsp: false, visca: 'sony' }]);
  ok('camera Sony VISCA over IP trovata');

  r = await scan({ viscaUdp: nobody, sony: nobody, viscaTcp: ports.tcp, rtsp: nobody });
  assert.deepStrictEqual(r, [{ ip: '127.0.0.1', rtsp: false, visca: 'tcp' }]);
  ok('camera VISCA TCP trovata');

  r = await scan({ viscaUdp: nobody, sony: nobody, viscaTcp: nobody, rtsp: rtspPort });
  assert.deepStrictEqual(r, [{ ip: '127.0.0.1', rtsp: true, visca: null }]);
  ok('dispositivo con solo video RTSP trovato');

  // router o telefono: pagina web sulla porta «RTSP» e un altro servizio sulla 5678 → non compare
  r = await scan({ viscaUdp: nobody, sony: nobody, viscaTcp: otherPort, rtsp: webPort });
  assert.deepStrictEqual(r, []);
  ok('router, telefoni e altri servizi esclusi');

  cam.close();
  for (const s of [rtsp, web, other]) s.close();
  console.log(`probe: ${pass} test superati`);
}

main().catch((e) => { console.error(e); process.exit(1); });
