const { app, BrowserWindow, globalShortcut, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const { buildPlan, buildEmailRevision, clearHistory, conversationContext, pushHistory } = require('./planner');
const { checkPlan } = require('./permission-manager');
const { executePlan } = require('./executor');
const { CapabilityManager } = require('./capability-manager');

let window;
const documentsRoot = path.resolve(path.join(os.homedir(), 'Documents'));
const auditPath = path.join(app.getPath('userData'), 'audit.jsonl');
const capabilityLogPath = path.join(app.getPath('userData'), 'capabilities.jsonl');
const capabilitySecretPath = path.join(app.getPath('userData'), 'capability-secret.key');
const capabilityManager = new CapabilityManager(capabilityLogPath, capabilitySecretPath);

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
    width: 760,
    height: 720,
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

// Clear conversation history on new chat
ipcMain.handle('agent:clear-history', async () => {
  clearHistory();
  return { ok: true };
});

ipcMain.handle('agent:plan', async (_event, request) => {
  const plan = await buildPlan(String(request || ''), documentsRoot);

  // Pure conversation: no actions, no task needed
  if (!plan.actions?.length) {
    const reply = plan.reply || plan.summary || "I'm here to help. What would you like to do?";
    await writeAudit('conversation-replied', { request, planner: plan.planner, reply });
    return {
      plan: { ...plan, reply },
      permission: { allowed: true, reasons: [], requiresConfirmation: false },
      documentsRoot,
      capability: null,
      intent: plan.intent || null
    };
  }

  // Task execution: create capability token
  const task = await capabilityManager.startTask(String(request || ''));
  const permission = checkPlan(plan, documentsRoot);
  if (!permission.allowed) {
    await capabilityManager.reject(task, permission.reasons.join('; '));
    await writeAudit('plan-created', { taskId: task.taskId, request, planner: plan.planner, allowed: false, reasons: permission.reasons });
    return { plan, permission, documentsRoot, capability: null };
  }
  const capability = await capabilityManager.issue(task, plan);
  await writeAudit('plan-created', { taskId: task.taskId, expiresAt: task.expiresAt, request, planner: plan.planner, allowed: true, reasons: permission.reasons });
  return { plan, permission, documentsRoot, capability };
});

ipcMain.handle('agent:revise-email', async (_event, { draft, instruction }) => {
  const task = await capabilityManager.startTask(`Revise email: ${String(instruction || '')}`);
  let revisedAction;
  try {
    revisedAction = await buildEmailRevision(draft, instruction);
  } catch (error) {
    await capabilityManager.reject(task, error.message);
    await writeAudit('email-revision-failed', { taskId: task.taskId, instruction, error: error.message });
    throw error;
  }
  const plan = { summary: 'Revised email draft', actions: [revisedAction], planner: 'ollama:email-revision' };
  const permission = checkPlan(plan, documentsRoot);
  if (!permission.allowed) {
    await capabilityManager.reject(task, permission.reasons.join('; '));
    return { plan, permission, documentsRoot, capability: null };
  }
  const capability = await capabilityManager.issue(task, plan);
  await writeAudit('email-revised', { taskId: task.taskId, expiresAt: task.expiresAt, instruction, draft: revisedAction, allowed: true, reasons: permission.reasons });
  return { plan, permission, documentsRoot, capability };
});

ipcMain.handle('agent:approve-draft', async (_event, draft) => {
  const task = await capabilityManager.startTask('User manually edited email draft');
  const plan = { summary: 'Send email', actions: [draft], planner: 'user:manual-edit' };
  const permission = checkPlan(plan, documentsRoot);
  if (!permission.allowed) {
    await capabilityManager.reject(task, permission.reasons.join('; '));
    throw new Error(`Draft blocked: ${permission.reasons.join('; ')}`);
  }
  const capability = await capabilityManager.issue(task, plan);
  await writeAudit('draft-approved', { taskId: task.taskId, draft, allowed: true });
  return { plan, capability };
});

ipcMain.handle('agent:execute', async (_event, { plan, capability }) => {
  const permission = checkPlan(plan, documentsRoot);
  if (!permission.allowed) throw new Error(`Blocked by permission manager: ${permission.reasons.join('; ')}`);
  await capabilityManager.consume(capability, plan);
  try {
    const results = await executePlan(plan, { documentsRoot, shell, capabilityLogPath, auditPath });
    await writeAudit('plan-executed', { taskId: capability.taskId, actions: plan.actions, results });
    // Store results in conversation context for follow-up questions
    conversationContext.lastResults = results;
    return results;
  } catch (error) {
    await writeAudit('execution-failed', { taskId: capability.taskId, actions: plan.actions, error: error.message });
    throw error;
  }
});
