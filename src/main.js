const { app, BrowserWindow, globalShortcut, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const { buildPlan } = require('./planner');
const { checkPlan } = require('./permission-manager');
const { executePlan } = require('./executor');

let window;
const documentsRoot = path.resolve(path.join(os.homedir(), 'Documents'));
const auditPath = path.join(app.getPath('userData'), 'audit.jsonl');

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
    width: 720,
    height: 680,
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

ipcMain.handle('agent:plan', async (_event, request) => {
  const plan = await buildPlan(String(request || ''), documentsRoot);
  const permission = checkPlan(plan, documentsRoot);
  await writeAudit('plan-created', { request, planner: plan.planner, allowed: permission.allowed, reasons: permission.reasons });
  return { plan, permission, documentsRoot };
});

ipcMain.handle('agent:execute', async (_event, plan) => {
  const permission = checkPlan(plan, documentsRoot);
  if (!permission.allowed) throw new Error(`Blocked by permission manager: ${permission.reasons.join('; ')}`);
  const results = await executePlan(plan, { documentsRoot, shell });
  await writeAudit('plan-executed', { actions: plan.actions, results });
  return results;
});
