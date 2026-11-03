const { app, BrowserWindow, globalShortcut, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const { buildPlan, buildEmailRevision, clearHistory, conversationContext, pushHistory } = require('./planner');
const { checkPlan } = require('./permission-manager');
const { executePlan } = require('./executor');
const { CapabilityManager } = require('./capability-manager');
const { SessionActivityManager, SESSION_STATES } = require('./session-activity-manager');

let window;
const documentsRoot = path.resolve(path.join(os.homedir(), 'Documents'));
const auditPath = path.join(app.getPath('userData'), 'audit.jsonl');
const sessionAuditPath = path.join(app.getPath('userData'), 'session-audit.jsonl');
const emergencyAuditPath = path.join(app.getPath('userData'), 'security-emergency.jsonl');
const capabilityLogPath = path.join(app.getPath('userData'), 'capabilities.jsonl');
const capabilitySecretPath = path.join(app.getPath('userData'), 'capability-secret.key');
const capabilityManager = new CapabilityManager(capabilityLogPath, capabilitySecretPath);

const sessionManager = new SessionActivityManager({
  documentsRoot,
  auditPath: sessionAuditPath,
  emergencyAuditPath: emergencyAuditPath,
  onEmergencyShutdown: (violation) => {
    if (window && !window.isDestroyed()) {
      window.webContents.send('security:emergency-shutdown', violation);
    }
    // Give renderer a brief window to display the emergency panel before terminating
    setTimeout(() => {
      app.isQuiting = true;
      app.quit();
      setTimeout(() => process.exit(1), 500);
    }, 2000);
  }
});

sessionManager.on('security_alert', (alert) => {
  if (window && !window.isDestroyed()) {
    window.webContents.send('security:alert', alert);
  }
});

sessionManager.on('state_changed', (stateInfo) => {
  if (window && !window.isDestroyed()) {
    window.webContents.send('security:state-changed', stateInfo);
  }
});

sessionManager.on('activity_recorded', (activity) => {
  if (window && !window.isDestroyed()) {
    window.webContents.send('security:activity', activity);
  }
});

function showWindow() {
  if (!window) return;
  window.show();
  window.focus();
}

function writeAudit(event, detail) {
  return fs.appendFile(auditPath, JSON.stringify({ time: new Date().toISOString(), event, detail }) + '\n').catch(() => {});
}

async function createWindow() {
  window = new BrowserWindow({
    width: 860,
    height: 760,
    show: false,
    resizable: true,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  await window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  showWindow();
  window.on('close', (event) => { if (!app.isQuiting) { event.preventDefault(); window.hide(); } });
}

app.whenReady().then(async () => {
  await fs.mkdir(documentsRoot, { recursive: true });
  await createWindow();
  globalShortcut.register('Alt+Space', () => window.isVisible() ? window.hide() : showWindow());
  app.on('activate', showWindow);
});

app.on('window-all-closed', (event) => event.preventDefault());
app.on('will-quit', () => globalShortcut.unregisterAll());

// --- Core Conversation & Plan IPC Handlers ---

ipcMain.handle('agent:clear-history', async () => {
  clearHistory();
  const newSessionId = sessionManager.resetSession();
  return { ok: true, sessionId: newSessionId };
});

ipcMain.handle('agent:plan', async (_event, request) => {
  const plan = await buildPlan(String(request || ''), documentsRoot, sessionManager);

  // Pure conversation: no actions, no task needed
  if (!plan.actions?.length) {
    const reply = plan.reply || plan.summary || "I'm here to help. What would you like to do?";
    await writeAudit('conversation-replied', { request, planner: plan.planner, reply });
    return {
      plan: { ...plan, reply },
      permission: { allowed: true, reasons: [], requiresConfirmation: false },
      documentsRoot,
      capability: null,
      approvalId: null,
      intent: plan.intent || null,
      sessionId: sessionManager.getSessionId()
    };
  }

  // Task execution: create capability token
  const task = await capabilityManager.startTask(String(request || ''));
  const permission = checkPlan(plan, documentsRoot);
  if (!permission.allowed) {
    await capabilityManager.reject(task, permission.reasons.join('; '));
    await writeAudit('plan-created', { taskId: task.taskId, request, planner: plan.planner, allowed: false, reasons: permission.reasons });
    sessionManager.setState(SESSION_STATES.BLOCKED, { reasons: permission.reasons });
    return { plan, permission, documentsRoot, capability: null, approvalId: plan.approvalId || null, sessionId: sessionManager.getSessionId() };
  }

  const capability = await capabilityManager.issue(task, plan);
  await writeAudit('plan-created', { taskId: task.taskId, expiresAt: task.expiresAt, request, planner: plan.planner, allowed: true, reasons: permission.reasons });
  return { plan, permission, documentsRoot, capability, approvalId: plan.approvalId || null, sessionId: sessionManager.getSessionId() };
});

ipcMain.handle('agent:revise-email', async (_event, { draft, instruction }) => {
  const task = await capabilityManager.startTask(`Revise email: ${String(instruction || '')}`);
  let revisedAction;
  try {
    revisedAction = await buildEmailRevision(draft, instruction, sessionManager);
  } catch (error) {
    await capabilityManager.reject(task, error.message);
    await writeAudit('email-revision-failed', { taskId: task.taskId, instruction, error: error.message });
    throw error;
  }
  const approval = sessionManager.createApprovalRequest(revisedAction);
  const plan = { summary: 'Revised email draft', actions: [revisedAction], planner: 'ollama:email-revision', approvalId: approval.approvalId, requiresApproval: true };
  const permission = checkPlan(plan, documentsRoot);
  if (!permission.allowed) {
    await capabilityManager.reject(task, permission.reasons.join('; '));
    return { plan, permission, documentsRoot, capability: null, approvalId: approval.approvalId, sessionId: sessionManager.getSessionId() };
  }
  const capability = await capabilityManager.issue(task, plan);
  await writeAudit('email-revised', { taskId: task.taskId, expiresAt: task.expiresAt, instruction, draft: revisedAction, allowed: true, reasons: permission.reasons });
  return { plan, permission, documentsRoot, capability, approvalId: approval.approvalId, sessionId: sessionManager.getSessionId() };
});

ipcMain.handle('agent:approve-draft', async (_event, draft) => {
  const task = await capabilityManager.startTask('User manually edited email draft');
  const approval = sessionManager.createApprovalRequest(draft);
  sessionManager.userApproveAction(approval.approvalId);

  const plan = { summary: 'Send email', actions: [draft], planner: 'user:manual-edit', approvalId: approval.approvalId };
  const permission = checkPlan(plan, documentsRoot);
  if (!permission.allowed) {
    await capabilityManager.reject(task, permission.reasons.join('; '));
    throw new Error(`Draft blocked: ${permission.reasons.join('; ')}`);
  }
  const capability = await capabilityManager.issue(task, plan);
  await writeAudit('draft-approved', { taskId: task.taskId, draft, allowed: true });
  return { plan, capability, approvalId: approval.approvalId };
});

ipcMain.handle('agent:execute', async (_event, { plan, capability, approvalId }) => {
  const permission = checkPlan(plan, documentsRoot);
  if (!permission.allowed) throw new Error(`Blocked by permission manager: ${permission.reasons.join('; ')}`);

  const activeApprovalId = approvalId || plan?.approvalId;
  // If read-only action (safe query), auto-approve in session activity manager if pending
  const isReadOnly = (plan?.actions || []).every((a) => ['list_directory', 'search_files', 'show_task_history'].includes(a.type));
  if (isReadOnly && activeApprovalId && sessionManager.pendingApprovals.has(activeApprovalId)) {
    sessionManager.userApproveAction(activeApprovalId);
  }

  await capabilityManager.consume(capability, plan);
  try {
    const results = await executePlan(plan, {
      documentsRoot,
      shell,
      capabilityLogPath,
      auditPath,
      sessionManager,
      approvalId: activeApprovalId
    });
    await writeAudit('plan-executed', { taskId: capability.taskId, actions: plan.actions, results });
    conversationContext.lastResults = results;
    return results;
  } catch (error) {
    await writeAudit('execution-failed', { taskId: capability.taskId, actions: plan.actions, error: error.message });
    throw error;
  }
});

// --- Security Activity Manager Management IPCs ---

ipcMain.handle('agent:security-status', async () => {
  return sessionManager.getSecurityStatus();
});

ipcMain.handle('agent:security-activities', async () => {
  return sessionManager.activities;
});

ipcMain.handle('agent:security-alerts', async () => {
  return sessionManager.securityAlerts;
});

ipcMain.handle('agent:security-config', async () => {
  return sessionManager.getSecurityConfig();
});

ipcMain.handle('agent:security-update-config', async (_event, config) => {
  return sessionManager.updateSecurityConfig(config);
});

ipcMain.handle('agent:security-export-report', async () => {
  return sessionManager.exportSecurityReport();
});

ipcMain.handle('agent:security-suspend', async (_event, reason) => {
  sessionManager.suspendSession(reason);
  return { ok: true, state: sessionManager.getState() };
});

ipcMain.handle('agent:security-resume', async () => {
  sessionManager.resumeSession();
  return { ok: true, state: sessionManager.getState() };
});

ipcMain.handle('agent:security-terminate', async (_event, reason) => {
  sessionManager.terminateSession(reason);
  return { ok: true, state: sessionManager.getState() };
});

ipcMain.handle('agent:security-reset', async () => {
  const newSessionId = sessionManager.resetSession();
  clearHistory();
  return { ok: true, sessionId: newSessionId };
});

ipcMain.handle('agent:security-approve', async (_event, approvalId) => {
  return sessionManager.userApproveAction(approvalId);
});

ipcMain.handle('agent:security-cancel', async (_event, { approvalId, reason }) => {
  sessionManager.userCancelAction(approvalId, reason);
  return { ok: true };
});
