// npm run pack: controlla il plugin e crea dist/PTZ-Hub.streamDeckPlugin con la CLI ufficiale Elgato
// (streamdeck validate + streamdeck pack, funzionano anche senza internet). Il file è uno zip la cui
// radice è la cartella agency.redmango.ptzhub.sdPlugin: un doppio clic lo installa in Stream Deck.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PLUGIN_UUID, SD_PLUGIN_DIR } from '../src/manifest.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const OUT_NAME = 'PTZ-Hub.streamDeckPlugin';
const CLI = path.join(ROOT, 'node_modules', '@elgato', 'cli', 'bin', 'streamdeck.mjs');

function cli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--no-update-check'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`streamdeck ${args[0]} failed (${r.status})`);
    process.exit(r.status || 1);
  }
}

if (!fs.existsSync(path.join(ROOT, SD_PLUGIN_DIR, 'manifest.json'))) {
  console.error(`${SD_PLUGIN_DIR} not found: run "npm run build" first`);
  process.exit(1);
}
if (!fs.existsSync(CLI)) {
  console.error('@elgato/cli not installed: run "npm install"');
  process.exit(1);
}

// i log scritti provando il plugin in locale non vanno nel pacchetto
fs.rmSync(path.join(ROOT, SD_PLUGIN_DIR, 'logs'), { recursive: true, force: true });

cli(['validate', SD_PLUGIN_DIR]);
fs.mkdirSync(DIST, { recursive: true });
cli(['pack', SD_PLUGIN_DIR, '--output', DIST, '--force', '--no-file-list']);

const produced = path.join(DIST, `${PLUGIN_UUID}.streamDeckPlugin`);
const target = path.join(DIST, OUT_NAME);
fs.rmSync(target, { force: true });
fs.renameSync(produced, target);
console.log(`\n${path.relative(ROOT, target)} (${(fs.statSync(target).size / 1024).toFixed(0)} kB)`);
