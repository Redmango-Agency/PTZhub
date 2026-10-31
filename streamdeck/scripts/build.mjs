// npm run build: crea la cartella agency.redmango.ptzhub.sdPlugin/ pronta da installare o impacchettare.
//  bin/plugin.js   plugin (SDK + codice) in un solo file ES module
//  ui/             Property Inspector (pi.html, pi.js in un solo file, sdpi-components)
//  imgs/           icone generate da scripts/icons.mjs
//  manifest.json, en.json, it.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rollup } from 'rollup';
import commonjs from '@rollup/plugin-commonjs';
import nodeResolve from '@rollup/plugin-node-resolve';
import { LANGUAGES, SD_PLUGIN_DIR, localization, manifest } from '../src/manifest.js';
import {
  categoryIconSvg, commandActionIconSvg, commandKeySvg, pluginIconSvg, presetActionIconSvg, presetKeySvg, svgToPng,
} from './icons.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, SD_PLUGIN_DIR);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function write(rel, data) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

function manifestVersion(v) {
  const parts = String(v).split(/[.+-]/).filter((p) => /^\d+$/.test(p)).slice(0, 4);
  while (parts.length < 4) parts.push('0');
  return parts.join('.');
}

async function bundle(input, output, plugins) {
  const warnings = [];
  const b = await rollup({
    input: path.join(ROOT, input),
    plugins,
    onwarn: (w) => {
      // "this" a livello di modulo e dipendenze circolari interne all'SDK: innocui
      if (w.code === 'THIS_IS_UNDEFINED' || w.code === 'CIRCULAR_DEPENDENCY') return;
      warnings.push(w);
    },
  });
  await b.write({ ...output, file: path.join(OUT, output.file) });
  await b.close();
  for (const w of warnings) console.warn(`  ! ${w.code}: ${w.message}`);
}

async function main() {
  const t0 = Date.now();
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // plugin: Node.js, ES module, tutte le dipendenze dentro (come il modello di @elgato/cli)
  await bundle('src/plugin/plugin.js', { file: 'bin/plugin.js', format: 'es', sourcemap: false }, [
    nodeResolve({ browser: false, exportConditions: ['node'], preferBuiltins: true }),
    commonjs(),
  ]);
  write('bin/package.json', '{ "type": "module" }\n');

  // Property Inspector: un solo script per il browser di Stream Deck
  await bundle('src/pi/pi.js', { file: 'ui/pi.js', format: 'iife', sourcemap: false }, [nodeResolve({ browser: true })]);
  write('ui/pi.html', fs.readFileSync(path.join(ROOT, 'src/pi/pi.html')));
  write('ui/pi.css', fs.readFileSync(path.join(ROOT, 'src/pi/pi.css')));
  write('ui/sdpi-components.js', fs.readFileSync(path.join(ROOT, 'vendor/sdpi-components/sdpi-components.js')));
  write('ui/sdpi-components.LICENSE.md', fs.readFileSync(path.join(ROOT, 'vendor/sdpi-components/LICENSE.md')));

  // manifest e traduzioni
  write('manifest.json', `${JSON.stringify(manifest(manifestVersion(pkg.version)), null, 2)}\n`);
  for (const lang of LANGUAGES) write(`${lang}.json`, `${JSON.stringify(localization(lang), null, 2)}\n`);

  // icone
  write('imgs/plugin/icon.png', await svgToPng(pluginIconSvg(256), 256));
  write('imgs/plugin/icon@2x.png', await svgToPng(pluginIconSvg(512), 512));
  write('imgs/plugin/category.svg', categoryIconSvg());
  write('imgs/actions/preset/icon.svg', presetActionIconSvg());
  write('imgs/actions/preset/key.svg', presetKeySvg());
  write('imgs/actions/command/icon.svg', commandActionIconSvg());
  write('imgs/actions/command/key.svg', commandKeySvg());

  console.log(`Built ${SD_PLUGIN_DIR} (v${manifestVersion(pkg.version)}) in ${Date.now() - t0} ms`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
