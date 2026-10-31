const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
  plan: (request) => ipcRenderer.invoke('agent:plan', request),
  reviseEmail: (draft, instruction) => ipcRenderer.invoke('agent:revise-email', { draft, instruction }),
  approveDraft: (draft) => ipcRenderer.invoke('agent:approve-draft', draft),
  execute: (plan, capability) => ipcRenderer.invoke('agent:execute', { plan, capability }),
  clearHistory: () => ipcRenderer.invoke('agent:clear-history'),
});
