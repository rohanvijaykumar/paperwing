/**
 * Paperwing preload: exposes a minimal, explicit file bridge to the app.
 * Only the top-level app page receives it (tool frames do not).
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('paperwing', {
  platform: process.platform,
  ready: () => ipcRenderer.invoke('paperwing:ready'),
  setTheme: (pref) => ipcRenderer.invoke('paperwing:set-theme', pref),
  openDialog: () => ipcRenderer.invoke('paperwing:open-dialog'),
  readFile: (path) => ipcRenderer.invoke('paperwing:read-file', path),
  readPreview: (path) => ipcRenderer.invoke('paperwing:read-preview', path),
  writeFile: (path, data) =>
    ipcRenderer.invoke('paperwing:write-file', path, data),
  saveAs: (name, data) => ipcRenderer.invoke('paperwing:save-as', name, data),
  confirmClose: () => ipcRenderer.invoke('paperwing:confirm-close'),
  requestClose: () => ipcRenderer.invoke('paperwing:request-close'),
  onCloseRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('paperwing:close-requested', listener);
    return () =>
      ipcRenderer.removeListener('paperwing:close-requested', listener);
  },
  onMenuCommand: (callback) => {
    const listener = (_e, command) => callback(command);
    ipcRenderer.on('paperwing:menu', listener);
    return () => ipcRenderer.removeListener('paperwing:menu', listener);
  },
  onEngineProgress: (callback) => {
    const listener = (_e, progress) => callback(progress);
    ipcRenderer.on('paperwing:engine-progress', listener);
    return () =>
      ipcRenderer.removeListener('paperwing:engine-progress', listener);
  },
  onOpenFile: (callback) => {
    const listener = (_e, file) => callback(file);
    ipcRenderer.on('paperwing:open-file', listener);
    return () => ipcRenderer.removeListener('paperwing:open-file', listener);
  },
});
