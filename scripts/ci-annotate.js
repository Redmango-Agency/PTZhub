#!/usr/bin/env node
// GitHub Actions: se un comando fallisce, mette le ultime righe del suo output in un avviso (annotation)
// leggibile anche dalla pagina della compilazione e dalle API, senza aprire il log completo.
// Uso: node scripts/ci-annotate.js "<titolo>" -- <comando> [argomenti...]
'use strict';
const { spawn } = require('child_process');

const sep = process.argv.indexOf('--');
const title = process.argv[2] || 'Comando fallito';
const cmd = process.argv.slice(sep + 1);
if (sep < 0 || cmd.length === 0) {
  console.error('Uso: node scripts/ci-annotate.js "<titolo>" -- <comando> [argomenti...]');
  process.exit(2);
}

const lines = [];
const keep = (chunk) => {
  for (const l of chunk.toString().split(/\r?\n/)) if (l.trim()) lines.push(l);
  if (lines.length > 400) lines.splice(0, lines.length - 400);
};
const child = spawn(cmd[0], cmd.slice(1), { shell: process.platform === 'win32', env: process.env });
child.stdout.on('data', (d) => { process.stdout.write(d); keep(d); });
child.stderr.on('data', (d) => { process.stderr.write(d); keep(d); });
child.on('close', (code) => {
  if (code !== 0) {
    const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    const tail = lines.slice(-80).join('\n');
    process.stdout.write(`\n::error title=${esc(`${title} (${process.platform})`).replace(/[:,]/g, ' ')}::${esc(tail)}\n`);
  }
  process.exit(code === null ? 1 : code);
});
