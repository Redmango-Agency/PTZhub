#!/usr/bin/env node
'use strict';
// Scarica l'eseguibile ffmpeg da includere nel pacchetto (non è nel repository: pesa ~80 MB).
// Uso: node scripts/fetch-ffmpeg.js [win32-x64|darwin-arm64|darwin-x64|linux-x64]

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const RELEASE = 'b6.1.1'; // binari di ffmpeg-static (https://github.com/eugeneware/ffmpeg-static)
const target = process.argv[2] || `${process.platform}-${process.arch}`;
const exe = target.startsWith('win32') ? 'ffmpeg.exe' : 'ffmpeg';
const outDir = path.join(__dirname, '..', 'vendor', 'ffmpeg', target);
const outFile = path.join(outDir, exe);

(async () => {
  if (fs.existsSync(outFile)) {
    console.log(`ffmpeg già presente: ${outFile}`);
    return;
  }
  const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/${RELEASE}/ffmpeg-${target}.gz`;
  console.log(`Scarico ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download non riuscito: HTTP ${res.status}`);
  const gz = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, zlib.gunzipSync(gz));
  if (exe === 'ffmpeg') fs.chmodSync(outFile, 0o755);
  console.log(`ffmpeg salvato in ${outFile}`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
