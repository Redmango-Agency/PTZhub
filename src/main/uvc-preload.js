'use strict';
// Finestra nascosta della camera USB: riceve i comandi dal processo principale e risponde.
// Nient'altro: questa pagina non può cambiare impostazioni né inquadrature.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('uvcHost', {
  onRequest: (cb) => ipcRenderer.on('uvc:req', (_e, msg) => cb(msg)),
  reply: (msg) => ipcRenderer.send('uvc:res', msg),
  event: (msg) => ipcRenderer.send('uvc:event', msg),
});
