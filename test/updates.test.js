'use strict';
// Test del controllo aggiornamenti con un finto server "GitHub" locale

const http = require('http');
const assert = require('assert');
const {
  parseVersion, compareVersions, repoFromPackage, checkForUpdate, isSafeReleaseUrl,
} = require('../src/main/updates');

let pass = 0;
const ok = (name) => { pass += 1; console.log(`  ok  ${name}`); };

async function main() {
  // --- confronto versioni
  assert.deepStrictEqual(parseVersion('v1.3.0'), { major: 1, minor: 3, patch: 0, pre: '' });
  assert.strictEqual(parseVersion('1.3'), null);
  assert.ok(compareVersions('1.4.0', '1.3.9') > 0);
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
  assert.strictEqual(compareVersions('v1.3.0', '1.3.0'), 0);
  assert.ok(compareVersions('1.3.0', '1.3.0-beta.1') > 0);
  assert.ok(compareVersions('1.3.0-beta.1', '1.3.0') < 0);
  assert.strictEqual(compareVersions('rotta', '1.0.0'), 0);
  ok('confronto versioni');

  // --- repository dal package.json
  assert.strictEqual(repoFromPackage({ ptzPanel: { updateRepo: 'mario/ptz-panel' } }), 'mario/ptz-panel');
  assert.strictEqual(repoFromPackage({ repository: 'github:mario/ptz-panel' }), 'mario/ptz-panel');
  assert.strictEqual(repoFromPackage({ repository: { url: 'git+https://github.com/mario/ptz-panel.git' } }), 'mario/ptz-panel');
  assert.strictEqual(repoFromPackage({ repository: { url: 'https://gitlab.com/mario/ptz-panel' } }), '');
  assert.strictEqual(repoFromPackage({ ptzPanel: { updateRepo: '' } }), '');
  assert.strictEqual(repoFromPackage({ ptzPanel: { updateRepo: '../../etc' } }), '');
  ok('repository letto dal package.json');

  // --- finto GitHub
  let reply = { status: 200, body: {} };
  let lastReq = null;
  const server = http.createServer((req, res) => {
    lastReq = req;
    if (reply.hang) return; // non risponde mai
    res.writeHead(reply.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  const check = (current, extra = {}) => checkForUpdate({ repo: 'mario/ptz-panel', current, fetch, apiBase, ...extra });

  reply = { status: 200, body: { tag_name: 'v1.4.0', html_url: 'https://github.com/mario/ptz-panel/releases/tag/v1.4.0' } };
  let r = await check('1.3.0');
  assert.strictEqual(r.state, 'available');
  assert.strictEqual(r.latest, '1.4.0');
  assert.strictEqual(r.url, 'https://github.com/mario/ptz-panel/releases/tag/v1.4.0');
  assert.strictEqual(lastReq.url, '/repos/mario/ptz-panel/releases/latest');
  assert.match(lastReq.headers['user-agent'], /^PTZ-Panel\/1\.3\.0$/);
  ok('nuova versione trovata');

  r = await check('1.4.0');
  assert.strictEqual(r.state, 'current');
  r = await check('1.5.0');
  assert.strictEqual(r.state, 'current');
  ok('versione già aggiornata (o più recente)');

  reply = { status: 200, body: { tag_name: 'v9.9.9', html_url: 'https://evil.example/download.exe' } };
  r = await check('1.3.0');
  assert.strictEqual(r.url, 'https://github.com/mario/ptz-panel/releases/latest');
  assert.ok(isSafeReleaseUrl(r.url, 'mario/ptz-panel'));
  assert.ok(!isSafeReleaseUrl('https://evil.example/x', 'mario/ptz-panel'));
  assert.ok(!isSafeReleaseUrl('https://github.com/altro/ptz-panel/releases', 'mario/ptz-panel'));
  ok('si apre solo una pagina del repository');

  reply = { status: 404, body: { message: 'Not Found' } };
  r = await check('1.3.0');
  assert.strictEqual(r.state, 'none');
  ok('nessuna release pubblicata');

  reply = { status: 200, body: { tag_name: 'v2.0.0-beta.1', prerelease: true } };
  r = await check('1.3.0');
  assert.strictEqual(r.state, 'none');
  ok('le pre-release non vengono proposte');

  reply = { status: 403, body: { message: 'rate limit' } };
  await assert.rejects(check('1.3.0'), /rate limit/);
  reply = { status: 500, body: {} };
  await assert.rejects(check('1.3.0'), /HTTP 500/);
  reply = { status: 200, body: { tag_name: 'ultima' } };
  await assert.rejects(check('1.3.0'), /not recognised/);
  ok('errori gestiti');

  reply = { hang: true };
  const t0 = Date.now();
  await assert.rejects(check('1.3.0', { timeoutMs: 300 }), /timeout|abort/i);
  assert.ok(Date.now() - t0 < 2000);
  ok('nessuna risposta: si rinuncia dopo il timeout');

  await assert.rejects(checkForUpdate({ repo: '', current: '1.0.0', fetch, apiBase }), /not configured/);
  await assert.rejects(checkForUpdate({ repo: 'mario/ptz-panel', current: '0.0', fetch, apiBase }), /installed version not recognised/);
  ok('repository mancante');

  server.closeAllConnections();
  server.close();
  console.log(`updates: ${pass} test superati`);
}

main().catch((e) => { console.error(e); process.exit(1); });
