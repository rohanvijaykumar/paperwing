const { contextBridge, ipcRenderer } = require('electron');
const ready = new Promise((resolve) =>
  ipcRenderer.once('paperwing:preview-ready', (_event, data) => resolve(data))
);
contextBridge.exposeInMainWorld('printPreview', {
  settings: () => ready,
  submit: (options) => ipcRenderer.invoke('paperwing:preview-submit', options),
  cancel: () => ipcRenderer.invoke('paperwing:preview-cancel'),
});
