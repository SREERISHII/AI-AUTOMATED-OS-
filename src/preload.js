const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
  plan: (request) => ipcRenderer.invoke('agent:plan', request),
  reviseEmail: (draft, instruction) => ipcRenderer.invoke('agent:revise-email', { draft, instruction }),
  execute: (plan) => ipcRenderer.invoke('agent:execute', plan)
});

