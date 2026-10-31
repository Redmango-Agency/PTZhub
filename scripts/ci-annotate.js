#!/usr/bin/env node
// GitHub Actions: se un comando fallisce, mette le ultime righe del suo output in un avviso (annotation)
// leggibile anche dalla pagina della compilazione e dalle API, senza aprire il log completo.
// Con --retry N riprova fino a N volte: il primo fallimento resta come avviso (warning), così un test
// che dipende dai tempi della macchina non blocca la release ma si vede quale è stato.
// Uso: node scripts/ci-annotate.js "<titolo>" [--retry N] -- <comando> [argomenti...]
'use strict';
const { spawn } = require('child_process');

const sep = process.argv.indexOf('--');
const opts = process.argv.slice(2, sep < 0 ? undefined : sep);
const title = opts[0] && !opts[0].startsWith('--') ? opts[0] : 'Comando fallito';
const ri = opts.indexOf('--retry');
const retries = ri >= 0 ? Math.max(0, parseInt(opts[ri + 1], 10) || 0) : 0;
const cmd = sep < 0 ? [] : process.argv.slice(sep + 1);
if (cmd.length === 0) {
  console.error('Uso: node scripts/ci-annotate.js "<titolo>" [--retry N] -- <comando> [argomenti...]');
  process.exit(2);
}

const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escTitle = (s) => esc(s).replace(/[:,]/g, ' ');

function run() {
  return new Promise((resolve) => {
    const lines = [];
    const keep = (chunk) => {
      for (const l of chunk.toString().split(/\r?\n/)) if (l.trim()) lines.push(l);
      if (lines.length > 400) lines.splice(0, lines.length - 400);
    };
    const child = spawn(cmd[0], cmd.slice(1), { shell: process.platform === 'win32', env: process.env });
    child.stdout.on('data', (d) => { process.stdout.write(d); keep(d); });
    child.stderr.on('data', (d) => { process.stderr.write(d); keep(d); });
    child.on('error', (e) => { lines.push(String(e)); resolve({ code: 1, lines }); });
    child.on('close', (code) => resolve({ code: code === null ? 1 : code, lines }));
  });
}

(async () => {
  for (let attempt = 0; ; attempt++) {
    const { code, lines } = await run();
    if (code === 0) process.exit(0);
    const last = attempt >= retries;
    const level = last ? 'error' : 'warning';
    const label = `${title} (${process.platform})${retries ? ` tentativo ${attempt + 1} di ${retries + 1}` : ''}`;
    process.stdout.write(`\n::${level} title=${escTitle(label)}::${esc(lines.slice(-80).join('\n'))}\n`);
    if (last) process.exit(code);
    console.log(`\nRiprovo (${attempt + 2} di ${retries + 1})…\n`);
  }
})();
