const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (partial) => ipcRenderer.invoke('config:set', partial),
  pickOpenPath: () => ipcRenderer.invoke('dialog:pickOpen'),
  pickSavePath: (suggestedName) => ipcRenderer.invoke('dialog:pickSave', suggestedName),
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),
  writeFile: (filePath, text) => ipcRenderer.invoke('file:write', filePath, text)
});
