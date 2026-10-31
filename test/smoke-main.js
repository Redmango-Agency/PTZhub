'use strict';
// Prova completa dell'app (Electron) con camera simulata: avvia, salva e richiama
// un'inquadratura, cattura schermate. Uso: xvfb-run electron test/smoke-main.js <cartellaOutput>
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const outDir = process.argv[process.argv.length - 1];
const logs = [];
const shot = async (win, name) => {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (...a) => {
    const ev = a[0];
    const msg = ev && ev.message !== undefined ? `${ev.level}: ${ev.message}` : a.slice(1).join(' ');
    logs.push(msg);
  });
  win.webContents.on('preload-error', (_ev, p, err) => logs.push(`PRELOAD ERROR ${p}: ${err}`));
  win.webContents.on('render-process-gone', (_ev, d) => logs.push(`RENDERER GONE ${JSON.stringify(d)}`));
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const result = {};
    try {
      await sleep(4500);
      result.camLabel = await js("document.querySelector('#camLabel').textContent + ' | ' + document.querySelector('#camDetail').textContent");
      result.previewMsg = await js("document.querySelector('#previewMsg').textContent");
      await shot(win, '1-avvio');

      // nuova inquadratura: si apre l'editor, si posiziona, si salva
      await js("document.querySelector('#btnSavePreset').click()");
      await sleep(600);
      result.editorOpen = await js("document.body.classList.contains('editing')");
      await js("document.querySelector('#edName').value='Palco largo'");
      await shot(win, '2-editor-nuova');
      await js("document.querySelector('#edSave').click()");
      await sleep(1200);
      result.presetCount = await js("document.querySelectorAll('.preset').length");
      result.editorClosed = await js("!document.body.classList.contains('editing')");

      // seconda: nell'editor si muove la camera e si salva
      await js("document.querySelector('#btnSavePreset').click()");
      await sleep(500);
      await js("window.ptz.cmd('move', 0.8, 0.2)");
      await sleep(300);
      await js("window.ptz.cmd('move', 0, 0)");
      await js("window.ptz.cmd('zoom', 1)");
      await sleep(200);
      await js("window.ptz.cmd('zoom', 0)");
      await sleep(300);
      await js("document.querySelector('#edName').value='Relatore'; document.querySelector('#edSave').click()");
      await sleep(1200);

      // modifica della prima: l'editor porta la camera lì, si ritocca e si salva
      await js("document.querySelectorAll('.preset .edit')[0].click()");
      await sleep(900);
      result.editTitle = await js("document.querySelector('#edTitle').textContent");
      await shot(win, '2b-editor-modifica');
      await js("window.ptz.cmd('move', -0.5, 0)");
      await sleep(200);
      await js("window.ptz.cmd('move', 0, 0)");
      await sleep(300);
      await js("document.querySelector('#edName').value='Palco largo (ritoccata)'; document.querySelector('#edSave').click()");
      await sleep(1200);

      // richiamo con il tasto 1
      await js("window.dispatchEvent(new KeyboardEvent('keydown', {key:'1', code:'Digit1'}))");
      await sleep(700);
      result.activeAfterKey1 = await js("document.querySelector('.preset.active .name')?.textContent");
      await shot(win, '3-inquadrature');

      // con uno slider selezionato i tasti funzionano ancora
      await js("document.querySelectorAll('.preset')[1].click()");
      await sleep(500);
      await js("document.querySelector('#moveSpeed').focus()");
      await js("window.dispatchEvent(new KeyboardEvent('keydown', {key:'1', code:'Digit1'}))");
      await sleep(600);
      result.activeAfterSliderFocus = await js("document.querySelector('.preset.active .name')?.textContent");

      // zoom con '+': il rilascio con Maiusc (tasto '=') deve fermarlo
      await js("window.dispatchEvent(new KeyboardEvent('keydown', {key:'+', code:'Equal'}))");
      await sleep(250);
      await js("window.dispatchEvent(new KeyboardEvent('keyup', {key:'=', code:'Equal', shiftKey:true}))");
      await sleep(400);

      await js("document.querySelector('#btnSettings').click()");
      await sleep(500);
      await shot(win, '4-impostazioni');
      await js("document.querySelector('#btnDetect').click()");
      await sleep(9000);
      result.detectOut = await js("document.querySelector('#discoverOut').innerText");
      await shot(win, '5-rilevamento');
      await js("document.querySelector('#dlgSettings').close('cancel')");
      await sleep(300);

      await js("document.querySelector('#btnCompact').click()");
      await sleep(1000);
      await shot(win, '6-compatta');

      // nessun testo deve essere rimasto una chiave non tradotta
      result.untranslated = await js(`(() => {
        const keys = new Set(Object.keys(window.I18N.dictionaries.it));
        const out = [];
        const walk = (n) => { if (n.nodeType === 3) { const v = n.textContent.trim(); if (keys.has(v)) out.push(v); } n.childNodes.forEach(walk); };
        walk(document.body);
        document.querySelectorAll('[title],[placeholder]').forEach((el) => { [el.title, el.placeholder].forEach((v) => { if (keys.has(v)) out.push(v); }); });
        return out;
      })()`);
      result.lang = await js('document.documentElement.lang');
      result.presetFile = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'preset.json'), 'utf8')).presets.map((p) => ({ name: p.name, pos: p.pos, thumb: !!p.thumb }));
    } catch (e) {
      result.error = String(e && e.stack ? e.stack : e);
    }
    fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ result, logs }, null, 2));
    app.quit();
  });
});

require('../src/main/main.js');
