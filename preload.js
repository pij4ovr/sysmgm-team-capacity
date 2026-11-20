const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  changeAppZoom: (delta) => ipcRenderer.invoke('app:changeZoom', delta),
  onAppZoomChanged: (cb) => ipcRenderer.on('app:zoomChanged', (_e, zoom) => cb(zoom)),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (partial) => ipcRenderer.invoke('config:set', partial),
  pickOpenPath: () => ipcRenderer.invoke('dialog:pickOpen'),
  pickSavePath: (suggestedName) => ipcRenderer.invoke('dialog:pickSave', suggestedName),
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),
  writeFile: (filePath, text) => ipcRenderer.invoke('file:write', filePath, text),
  getTfsSettings: () => ipcRenderer.invoke('tfs:getSettings'),
  setTfsSettings: (partial) => ipcRenderer.invoke('tfs:setSettings', partial),
  testTfsConnection: (partial) => ipcRenderer.invoke('tfs:testConnection', partial),
  fetchTfsSprint: (params) => ipcRenderer.invoke('tfs:fetchSprint', params),
  fetchTfsRoadmap: (params) => ipcRenderer.invoke('tfs:fetchRoadmap', params),
  openTfsWorkItem: (id) => ipcRenderer.invoke('tfs:openWorkItem', id),
  publishWikiPage: (params) => ipcRenderer.invoke('tfs:publishWikiPage', params),
  attachWikiImage: (params) => ipcRenderer.invoke('tfs:attachWikiImage', params),
  copyToClipboard: (text) => ipcRenderer.invoke('clipboard:writeText', text),
  exportReport: (params) => ipcRenderer.invoke('report:export', params)
});
