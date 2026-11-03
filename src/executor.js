require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');
const { execFile, execSync } = require('child_process');
const { safeDocumentPath } = require('./permission-manager');

const EMAIL_WORKER = path.join(__dirname, 'send-email-worker.js');

// process.execPath inside Electron returns electron.exe (which uses BoringSSL).
// We need the system Node.js binary (which uses OpenSSL) to bypass the
// INVALID_FIELD_FOR_VERSION error caused by antivirus SSL inspection.
let _nodePath;
function getNodePath() {
  if (_nodePath) return _nodePath;
  try {
    _nodePath = execSync('where node', { encoding: 'utf8' }).split('\n')[0].trim();
  } catch {
    _nodePath = 'node'; // Fall back to PATH lookup
  }
  return _nodePath;
}

function resolveSafe(root, value) {
  if (!safeDocumentPath(value, root)) throw new Error('Unsafe path rejected during execution.');
  return path.resolve(root, value);
}

async function assertDoesNotExist(target) {
  try { await fs.access(target); throw new Error(`Destination already exists: ${path.basename(target)}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function assertFile(target) {
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error(`${path.basename(target)} is not a file.`);
}

// Sends email via a child Node.js process to bypass Electron's BoringSSL.
// Electron bundles Chromium's BoringSSL which rejects antivirus SSL-inspection
// certificates at the X.509 *parser* level (INVALID_FIELD_FOR_VERSION).
// rejectUnauthorized and NODE_TLS_REJECT_UNAUTHORIZED cannot fix this because
// the certificate is rejected before trust validation even runs.
// Standalone Node.js uses OpenSSL, which handles these certificates correctly.
async function sendEmail(action, root, sessionManager) {
  if (sessionManager && !sessionManager.networkAccessEnabled) {
    throw new Error('Email sending blocked: Network access is disabled by security policy.');
  }

  const port = Number(process.env.SMTP_PORT || 465);
  const secure = process.env.SMTP_SECURE === 'true' || port === 465;
  const config = {
    host: process.env.SMTP_HOST,
    port: port,
    secure: secure,
    requireTLS: !secure,
    // Google displays App Passwords in groups; whitespace is never part of the secret.
    auth: { user: process.env.SMTP_USER?.trim(), pass: process.env.SMTP_PASS?.replace(/\s/g, '') },
    tls: {
      rejectUnauthorized: false,
      servername: process.env.SMTP_HOST
    }
  };
  if (!config.host || !config.auth.user || !config.auth.pass) throw new Error('Email is not configured. Add SMTP values to .env first.');

  const rawAttachments = Array.isArray(action.attachments) ? action.attachments : [];
  const invalidPlaceholders = new Set(['none', 'attachments', 'relative documents path', 'null', 'undefined', '.', 'documents', '']);
  const cleanAttachments = rawAttachments
    .filter((att) => typeof att === 'string' && att.trim() !== '' && att.trim() !== '.' && !invalidPlaceholders.has(att.trim().toLowerCase()));

  const attachments = [];
  for (const attachment of cleanAttachments) {
    const target = resolveSafe(root, attachment);
    let finalTarget = target;
    try {
      const stat = await fs.stat(finalTarget);
      if (stat.isDirectory()) {
        throw new Error(`Attachment "${attachment}" is a folder, not a file.`);
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        const base = path.basename(attachment).replace(/\.[^.]+$/, '');
        const fuzzyMatches = await recursiveSearch(root, root, base, undefined);
        const fileMatch = fuzzyMatches.find((m) => !m.isDir);
        if (fileMatch) {
          finalTarget = resolveSafe(root, fileMatch.relPath);
        } else {
          throw new Error(`Attachment not found in Documents: ${attachment}. Create the file first, then try again.`);
        }
      } else {
        throw error;
      }
    }
    attachments.push({ filename: path.basename(finalTarget), path: finalTarget });
  }

  const mailOptions = { from: process.env.MAIL_FROM || config.auth.user, to: action.to.join(', '), subject: action.subject, text: action.body, attachments };

  // Spawn a standalone Node.js process (uses OpenSSL, not BoringSSL)
  return new Promise((resolve, reject) => {
    const nodeBin = getNodePath();
    const child = execFile(nodeBin, [EMAIL_WORKER], { timeout: 30000 }, (error, stdout, stderr) => {
      try {
        const result = JSON.parse(stdout || '{}');
        if (result.ok) {
          resolve(`Email sent (${result.messageId})`);
        } else {
          reject(new Error(result.error || error?.message || 'Email worker failed'));
        }
      } catch (parseError) {
        reject(new Error(error?.message || stderr || `Email worker error: ${stdout || parseError.message}`));
      }
    });

    if (sessionManager && typeof sessionManager.registerChildProcess === 'function') {
      try {
        sessionManager.registerChildProcess(child);
      } catch (err) {
        return reject(err);
      }
    }

    child.stdin.write(JSON.stringify({ config, mailOptions }));
    child.stdin.end();
  });
}

async function recursiveSearch(dir, root, query, ext, results = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(root, fullPath);
    const nameLower = entry.name.toLowerCase();
    const queryMatch = !query || nameLower.includes(query.toLowerCase());
    const extMatch = !ext || nameLower.endsWith('.' + ext.toLowerCase());

    if (!queryMatch || !extMatch) {
      if (entry.isDirectory()) {
        await recursiveSearch(fullPath, root, query, ext, results).catch(() => {});
      }
      continue;
    }
    try {
      const stats = await fs.stat(fullPath);
      results.push({
        name: entry.name,
        relPath: relPath || '.',
        isDir: entry.isDirectory(),
        size: stats.size,
        mtime: stats.mtime
      });
    } catch (_) {}
    if (entry.isDirectory()) {
      await recursiveSearch(fullPath, root, query, ext, results).catch(() => {});
    }
  }
  return results;
}

async function readJsonLines(filePath) {
  try {
    const contents = await fs.readFile(filePath, 'utf8');
    return contents.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function taskHistory(context) {
  const capabilityRecords = await readJsonLines(context.capabilityLogPath);
  const auditRecords = await readJsonLines(context.auditPath);
  const latest = new Map();
  for (const record of capabilityRecords) if (record.taskId) latest.set(record.taskId, record);
  const outcomes = new Map();
  for (const record of auditRecords) {
    if (record.detail?.taskId && ['plan-executed', 'execution-failed'].includes(record.event)) outcomes.set(record.detail.taskId, record);
  }
  const records = [...latest.values()].sort((a, b) => String(b.issuedAt).localeCompare(String(a.issuedAt))).slice(0, 20);
  if (!records.length) return ['No task history is available yet.'];
  return records.flatMap((record) => {
    const outcome = outcomes.get(record.taskId);
    const result = outcome?.event === 'plan-executed' ? JSON.stringify(outcome.detail.results || []) : '';
    const error = outcome?.event === 'execution-failed' ? outcome.detail.error : (record.reason || '');
    const operation = (record.operation || []).join(', ') || 'Pending';
    const summary = `Task ID: ${record.taskId} | Agent: ${record.agent || 'Unassigned'} | Status: ${record.status}`;
    const request = record.request || '(request not recorded for an older task)';
    const main = `Task asked: ${request} | Task performed: ${operation} | Status: ${record.status}`;
    const details = [
      'Details:',
      `Requested: ${record.issuedAt}`,
      `Expires: ${record.expiresAt}`,
      `Resources: ${(record.resources || []).join(', ') || 'none'}`,
      `Recipients: ${(record.recipients || []).join(', ') || 'none'}`,
      `Attachments: ${(record.attachments || []).join(', ') || 'none'}`,
      result ? `Result: ${result}` : '',
      error ? `Error: ${error}` : ''
    ].filter(Boolean).join('\n');
    return [`${summary}\n${main}\n${details}`];
  });
}

async function executeAction(action, context) {
  const root = context.documentsRoot;
  const sessionManager = context.sessionManager;

  // Session Activity Manager Pre-Execution Safety Verification
  if (sessionManager) {
    sessionManager.verifyExecutionEligibility(action, context.approvalId);
  }

  // Safety: sanitize invalid paths (e.g. numeric 0 from LLM) to Documents root
  if (action.path !== undefined) {
    const p = String(action.path).trim();
    if (!p || /^[0-9]+$/.test(p)) action = { ...action, path: '.' };
  }

  let result;
  switch (action.type) {
    case 'show_task_history': result = await taskHistory(context); break;
    case 'list_directory': {
      let target;
      try {
        target = resolveSafe(root, action.path || '.');
        await fs.access(target);
      } catch (err) {
        const baseName = path.basename(action.path || '').toLowerCase();
        const rootEntries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
        const matchingDir = rootEntries.find((e) => e.isDirectory() && e.name.toLowerCase() === baseName);
        if (matchingDir) {
          target = path.join(root, matchingDir.name);
        } else {
          return [`Folder “${action.path}” does not exist in Documents.`];
        }
      }

      const prefix = String(action.startsWith || '').toLocaleLowerCase();
      const entries = await fs.readdir(target, { withFileTypes: true });
      const entryType = (action.entryType || 'all').toLowerCase();

      const matches = entries
        .filter((entry) => {
          if (prefix && !entry.name.toLocaleLowerCase().startsWith(prefix)) return false;
          if (entryType === 'folder' && !entry.isDirectory()) return false;
          if (entryType === 'file' && entry.isDirectory()) return false;
          return true;
        })
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

      const dirLabel = action.path === '.' || !action.path ? 'Documents' : path.basename(target);
      const typeLabel = entryType === 'folder' ? 'folder' : entryType === 'file' ? 'file' : 'item';

      if (matches.length === 0) {
        if (prefix) return [`No ${typeLabel}s in ${dirLabel} match “${action.startsWith}”.`];
        return [`No ${typeLabel}s found in ${dirLabel}.`];
      }

      result = [
        `Found ${matches.length} ${typeLabel}${matches.length === 1 ? '' : 's'} in ${dirLabel}:`,
        ...matches.map((entry) => `${entry.isDirectory() ? 'Folder' : 'File'}: ${entry.name}`)
      ];
      break;
    }
    case 'search_files': {
      const target = resolveSafe(root, action.path || '.');
      const query = action.query || '';
      const ext = action.ext ? String(action.ext).toLowerCase().replace(/^\./, '') : null;
      const matches = await recursiveSearch(target, root, query, ext);
      const criteria = [query ? `“${query}”` : '', ext ? `*.${ext}` : ''].filter(Boolean).join(' with extension ');
      if (matches.length === 0) return [`No matching files or folders found for ${criteria || 'your search'}.`];
      result = [
        `Found ${matches.length} match${matches.length === 1 ? '' : 'es'} for ${criteria || 'your search'}:`,
        ...matches.map((item) => `${item.isDir ? 'Folder' : 'File'}: ${item.relPath} (${item.isDir ? 'directory' : `${Math.round(item.size / 1024)} KB`})`)
      ];
      break;
    }
    case 'create_folder': {
      const target = resolveSafe(root, action.path);
      await fs.mkdir(target, { recursive: true });
      result = `Created folder: ${action.path}`;
      break;
    }
    case 'create_file': {
      const target = resolveSafe(root, action.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await assertDoesNotExist(target);
      await fs.writeFile(target, String(action.content || ''), { flag: 'wx' });
      result = `Created file: ${action.path}`;
      break;
    }
    case 'rename':
    case 'move': {
      const source = resolveSafe(root, action.path);
      let target = resolveSafe(root, action.destination);
      await fs.access(source);

      // If moving/renaming into an existing directory, place the item inside that directory
      try {
        const destStat = await fs.stat(target);
        if (destStat.isDirectory()) {
          target = path.join(target, path.basename(source));
        }
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }

      await fs.mkdir(path.dirname(target), { recursive: true });
      await assertDoesNotExist(target);
      await fs.rename(source, target);
      const displayDest = path.relative(root, target).replace(/\\/g, '/');
      result = `${action.type === 'rename' ? 'Renamed' : 'Moved'}: ${action.path} → ${displayDest}`;
      break;
    }
    case 'delete': {
      const target = resolveSafe(root, action.path);
      await fs.access(target);
      if (context.shell && typeof context.shell.trashItem === 'function') {
        await context.shell.trashItem(target);
      } else if (context.shell && typeof context.shell.moveItemToTrash === 'function') {
        const trashed = context.shell.moveItemToTrash(target);
        if (!trashed) throw new Error('Could not move item to the Recycle Bin.');
      } else {
        await fs.rm(target, { recursive: true, force: true });
      }
      result = `Moved to Recycle Bin: ${action.path}`;
      break;
    }
    case 'open': {
      let target;
      try {
        target = resolveSafe(root, action.path);
        await fs.access(target);
      } catch (err) {
        const query = path.basename(action.path).replace(/\.[^.]+$/, '');
        const ext = path.extname(action.path).replace(/^\./, '') || undefined;
        const matches = await recursiveSearch(root, root, query, ext);
        if (matches.length === 1) {
          target = resolveSafe(root, matches[0].relPath);
          await fs.access(target);
        } else if (matches.length > 1) {
          return [
            `Found multiple matches for “${action.path}”. Please specify which one to open:`,
            ...matches.map((item) => `${item.isDir ? 'Folder' : 'File'}: ${item.relPath}`)
          ];
        } else {
          throw new Error(`File or folder not found: “${action.path}”. (Looked in Documents and subfolders)`);
        }
      }
      const openResult = await context.shell.openPath(target);
      if (openResult) throw new Error(openResult);
      result = `Opened: ${path.relative(root, target) || action.path}`;
      break;
    }
    case 'send_email':
      result = await sendEmail(action, root, sessionManager);
      break;
    default:
      throw new Error(`Unsupported action: ${action.type}`);
  }

  // Session Activity Manager Post-Execution Validation
  if (sessionManager) {
    if (action.path) {
      const check = sessionManager.validatePathSafety(action.path);
      if (!check.safe) {
        await sessionManager.triggerEmergencyStop({
          action: action.type,
          tool: action.type,
          target: action.path,
          reason: `Post-execution path validation failed: ${check.reason}`
        });
        throw new Error(`Post-execution safety failure: ${check.reason}`);
      }
    }
    if (action.destination) {
      const checkDest = sessionManager.validatePathSafety(action.destination, { isDestination: true });
      if (!checkDest.safe) {
        await sessionManager.triggerEmergencyStop({
          action: action.type,
          tool: action.type,
          target: action.destination,
          reason: `Post-execution destination validation failed: ${checkDest.reason}`
        });
        throw new Error(`Post-execution safety failure: ${checkDest.reason}`);
      }
    }

    sessionManager.recordActivity({
      requestedAction: action,
      permissionStatus: 'ALLOWED',
      approvalStatus: 'EXECUTED',
      currentStatus: 'EXECUTED',
      actionReason: `Action ${action.type} completed successfully.`
    });
  }

  return result;
}

async function executePlan(plan, context) {
  const sessionManager = context.sessionManager;
  if (sessionManager) {
    if (sessionManager.sessionClosed || sessionManager.getState() === 'TERMINATED' || sessionManager.getState() === 'EMERGENCY_STOP') {
      throw new Error('Execution blocked: Session has been closed or terminated.');
    }
    if (sessionManager.getState() === 'SUSPENDED') {
      throw new Error('Execution blocked: Session is suspended.');
    }
    sessionManager.setState('EXECUTING', { planSummary: plan.summary });
  }

  const results = [];
  try {
    for (const action of plan.actions) {
      const actionResults = await executeAction(action, context);
      results.push(...(Array.isArray(actionResults) ? actionResults : [actionResults]));
    }
    if (sessionManager) {
      sessionManager.setState('COMPLETED', { resultsCount: results.length });
    }
    return results;
  } catch (error) {
    if (sessionManager) {
      if (sessionManager.getState() !== 'EMERGENCY_STOP' && sessionManager.getState() !== 'TERMINATED') {
        sessionManager.setState('FAILED', { error: error.message });
      }
    }
    throw error;
  }
}

module.exports = { executePlan };
