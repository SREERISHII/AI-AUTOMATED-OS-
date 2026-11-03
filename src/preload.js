const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
  plan: (request) => ipcRenderer.invoke('agent:plan', request),
  reviseEmail: (draft, instruction) => ipcRenderer.invoke('agent:revise-email', { draft, instruction }),
  approveDraft: (draft) => ipcRenderer.invoke('agent:approve-draft', draft),
  execute: (plan, capability, approvalId) => ipcRenderer.invoke('agent:execute', { plan, capability, approvalId }),
  clearHistory: () => ipcRenderer.invoke('agent:clear-history'),

  // Security Activity Manager APIs
  getSecurityStatus: () => ipcRenderer.invoke('agent:security-status'),
  getActivities: () => ipcRenderer.invoke('agent:security-activities'),
  getAlerts: () => ipcRenderer.invoke('agent:security-alerts'),
  getSecurityConfig: () => ipcRenderer.invoke('agent:security-config'),
  updateSecurityConfig: (config) => ipcRenderer.invoke('agent:security-update-config', config),
  exportSecurityReport: () => ipcRenderer.invoke('agent:security-export-report'),
  suspendSession: (reason) => ipcRenderer.invoke('agent:security-suspend', reason),
  resumeSession: () => ipcRenderer.invoke('agent:security-resume'),
  terminateSession: (reason) => ipcRenderer.invoke('agent:security-terminate', reason),
  resetSession: () => ipcRenderer.invoke('agent:security-reset'),
  approveAction: (approvalId) => ipcRenderer.invoke('agent:security-approve', approvalId),
  cancelAction: (approvalId, reason) => ipcRenderer.invoke('agent:security-cancel', { approvalId, reason }),

  // Event Listeners
  onSecurityAlert: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('security:alert', listener);
    return () => ipcRenderer.removeListener('security:alert', listener);
  },
  onEmergencyShutdown: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('security:emergency-shutdown', listener);
    return () => ipcRenderer.removeListener('security:emergency-shutdown', listener);
  },
  onStateChanged: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('security:state-changed', listener);
    return () => ipcRenderer.removeListener('security:state-changed', listener);
  },
  onActivity: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('security:activity', listener);
    return () => ipcRenderer.removeListener('security:activity', listener);
  }
});
