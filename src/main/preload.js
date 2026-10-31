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
  recallPreset: (id, speed, opts) => ipcRenderer.invoke('cam:recallPreset', id, speed, opts),
  setActive: (id) => ipcRenderer.send('cam:setActive', id),
  setEditing: (on) => ipcRenderer.send('ui:editing', on),
  apiInfo: () => ipcRenderer.invoke('api:info'),
  newApiToken: () => ipcRenderer.invoke('api:newToken'),
  copy: (text) => ipcRenderer.invoke('app:copy', text),
  saveSlot: (n) => ipcRenderer.invoke('cam:saveSlot', n),
  recallSlot: (n) => ipcRenderer.invoke('cam:recallSlot', n),

  discover: () => ipcRenderer.invoke('detect:discover'),
  detectProtocols: (opts) => ipcRenderer.invoke('detect:protocols', opts),
  detectRtsp: (opts) => ipcRenderer.invoke('detect:rtsp', opts),
  testUrl: (url) => ipcRenderer.invoke('detect:testUrl', url),

  ackFrame: () => ipcRenderer.send('preview:ack'),
  setCompact: (on) => ipcRenderer.invoke('app:setCompact', on),
  openDataFolder: () => ipcRenderer.invoke('app:openDataFolder'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  openUpdate: () => ipcRenderer.invoke('update:open'),

  onCamStatus: on('cam:status'),
  onCamLog: on('cam:log'),
  onPreviewStatus: on('preview:status'),
  onFrame: on('preview:frame'),
  onHotkey: on('hotkey'),
  onActive: on('preset:active'),
  onApiStatus: on('api:status'),
  onUpdateStatus: on('update:status'),
  onSettingsChanged: on('settings:changed'),
});
