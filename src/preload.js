const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
  plan: (request) => ipcRenderer.invoke('agent:plan', request),
  execute: (plan) => ipcRenderer.invoke('agent:execute', plan)
});
