'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (ch) => (cb) => {
  const h = (_e, data) => cb(data);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('ptz', {
  init: () => ipcRenderer.invoke('init'),
  saveSettings: (partial) => ipcRenderer.invoke('settings:save', partial),
  savePresets: (list) => ipcRenderer.invoke('presets:save', list),
  exportPresets: (list) => ipcRenderer.invoke('presets:export', list),
  importPresets: () => ipcRenderer.invoke('presets:import'),

  cmd: (name, ...args) => ipcRenderer.send('cam:cmd', { name, args }),
  getPosition: () => ipcRenderer.invoke('cam:getPosition'),
  goto: (pos, speed) => ipcRenderer.invoke('cam:goto', pos, speed),
  saveSlot: (n) => ipcRenderer.invoke('cam:saveSlot', n),
  recallSlot: (n) => ipcRenderer.invoke('cam:recallSlot', n),

  discover: () => ipcRenderer.invoke('detect:discover'),
  detectProtocols: (opts) => ipcRenderer.invoke('detect:protocols', opts),
  detectRtsp: (opts) => ipcRenderer.invoke('detect:rtsp', opts),
  testUrl: (url) => ipcRenderer.invoke('detect:testUrl', url),

  ackFrame: () => ipcRenderer.send('preview:ack'),
  setCompact: (on) => ipcRenderer.invoke('app:setCompact', on),
  openDataFolder: () => ipcRenderer.invoke('app:openDataFolder'),

  onCamStatus: on('cam:status'),
  onCamLog: on('cam:log'),
  onPreviewStatus: on('preview:status'),
  onFrame: on('preview:frame'),
  onHotkey: on('hotkey'),
});
