#!/usr/bin/env node
// Note della release su GitHub: file da scaricare + sezione della versione presa da CHANGELOG.md
// Uso: node scripts/release-notes.js 1.4.0 > notes.md
'use strict';
const fs = require('fs');
const path = require('path');

const version = (process.argv[2] || '').replace(/^v/, '');
const m = /^(\d+\.\d+\.\d+)(-[0-9A-Za-z.]+)?$/.exec(version);
if (!m) {
  console.error('Versione non valida: usa ad esempio 1.4.0 o 1.5.0-beta.1');
  process.exit(1);
}
const base = m[1];
const isTest = !!m[2];

const changelog = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8').split(/\r?\n/);
// versione di prova: vale la sezione della versione a cui porta (1.5.0-beta.1 -> 1.5.0)
let start = changelog.findIndex((l) => l.startsWith(`## [${version}]`));
if (start < 0 && isTest) start = changelog.findIndex((l) => l.startsWith(`## [${base}]`));
if (start < 0) {
  console.error(`In CHANGELOG.md manca la sezione ## [${version}]`);
  process.exit(1);
}
let end = changelog.findIndex((l, i) => i > start && (l.startsWith('## [') || /^\[[^\]]+\]: /.test(l)));
if (end < 0) end = changelog.length;
const changes = changelog.slice(start + 1, end).join('\n').trim();

const credit = 'https://redmango.agency/?utm_source=github&utm_medium=referral&utm_campaign=ptzhub-release';

const testNote = isTest
  ? `> **Versione di prova** · *Test build*: per chi la vuole provare prima dell'uscita. Le novità segnate «in prova» possono cambiare; segnala cosa non va nelle [Issue](https://github.com/Redmango-Agency/PTZhub/issues/new/choose).\n\n`
  : '';

process.stdout.write(`${testNote}## Scarica · Download

| | |
|---|---|
| **Windows** (installer) | \`PTZ-Hub-Setup-${version}.exe\` |
| Windows (portatile · portable) | \`PTZ-Hub-${version}-portable-win-x64.zip\` |
| **Mac** con chip Apple · Apple Silicon (M1–M4) | \`PTZ-Hub-${version}-mac-arm64.dmg\` |
| Mac Intel | \`PTZ-Hub-${version}-mac-x64.dmg\` |
| **Stream Deck** (doppio clic · double-click) | \`PTZ-Hub.streamDeckPlugin\` |

**Windows**: il programma non è ancora firmato, quindi Windows può avvisare: «Ulteriori informazioni» → «Esegui comunque». *Not signed yet: "More info" → "Run anyway".*

**Mac**: l'app non è ancora firmata da Apple. La prima volta incolla nel Terminale · *Not signed by Apple yet, on first launch run in Terminal*:
\`\`\`
xattr -cr "/Applications/PTZ Hub.app"
\`\`\`

## Novità

${changes}

---
Realizzato da · *Made by* [**\\*redmango**](${credit}) — Torino. Somme di controllo · *checksums*: \`SHA256SUMS.txt\`.
`);
