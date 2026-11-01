#!/usr/bin/env node
// Compila ptzhub-uvc.exe (comandi delle camere USB su Windows senza aprire il video).
// Serve mingw-w64: su Linux x86_64-w64-mingw32-g++, su Windows g++ (MinGW, già presente su GitHub Actions).
// Uscita: vendor/uvc-win/ptzhub-uvc.exe, che il pacchetto Windows copia in resources/uvc.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'native', 'uvc-win', 'ptzhub-uvc.cpp');
const outDir = path.join(root, 'vendor', 'uvc-win');
const out = path.join(outDir, 'ptzhub-uvc.exe');
const compilers = process.platform === 'win32'
  ? ['g++', 'x86_64-w64-mingw32-g++', 'C:\\mingw64\\bin\\g++.exe', 'C:\\msys64\\mingw64\\bin\\g++.exe']
  : ['x86_64-w64-mingw32-g++', 'x86_64-w64-mingw32-g++-posix'];
const args = [
  '-std=c++17', '-O2', '-s', '-static', '-Wall', '-o', out, src,
  '-lole32', '-loleaut32', '-lstrmiids', '-luuid',
];

fs.mkdirSync(outDir, { recursive: true });
let lastErr = null;
for (const cc of compilers) {
  try {
    execFileSync(cc, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    console.log(`ptzhub-uvc.exe pronto: ${path.relative(root, out)} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
    process.exit(0);
  } catch (e) {
    lastErr = e;
  }
}
console.error(`Compilazione non riuscita: serve mingw-w64 (${compilers.join(' o ')}).`, lastErr && lastErr.message);
// in sviluppo va bene anche l'eseguibile compilato prima; senza, le camere USB su Windows
// userebbero il video per i comandi (conflitto con OBS): nella compilazione automatica è un errore
if (fs.existsSync(out) && !process.env.CI) {
  console.warn(`Uso l'eseguibile già presente: ${path.relative(root, out)}`);
  process.exit(0);
}
process.exit(1);
