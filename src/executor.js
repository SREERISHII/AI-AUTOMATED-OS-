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
async function sendEmail(action, root) {
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
  const invalidPlaceholders = new Set(['none', 'attachments', 'relative documents path', 'null', 'undefined', '']);
  const cleanAttachments = rawAttachments.filter((att) => typeof att === 'string' && att.trim() !== '' && !invalidPlaceholders.has(att.toLowerCase()));

  const attachments = [];
  for (const attachment of cleanAttachments) {
    const target = resolveSafe(root, attachment);
    try {
      await assertFile(target);
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Attachment not found in Documents: ${attachment}. Create the file first, then try again.`);
      throw error;
    }
    attachments.push({ filename: path.basename(target), path: target });
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
    child.stdin.write(JSON.stringify({ config, mailOptions }));
    child.stdin.end();
  });
}

async function executeAction(action, context) {
  const root = context.documentsRoot;
  switch (action.type) {
    case 'create_folder': { const target = resolveSafe(root, action.path); await fs.mkdir(target, { recursive: false }); return `Created folder: ${action.path}`; }
    case 'create_file': { const target = resolveSafe(root, action.path); await fs.mkdir(path.dirname(target), { recursive: true }); await assertDoesNotExist(target); await fs.writeFile(target, String(action.content || ''), { flag: 'wx' }); return `Created file: ${action.path}`; }
    case 'rename':
    case 'move': { const source = resolveSafe(root, action.path); const target = resolveSafe(root, action.destination); await fs.access(source); await fs.mkdir(path.dirname(target), { recursive: true }); await assertDoesNotExist(target); await fs.rename(source, target); return `${action.type === 'rename' ? 'Renamed' : 'Moved'}: ${action.path} → ${action.destination}`; }
    case 'delete': { const target = resolveSafe(root, action.path); await fs.access(target); const trashed = context.shell.moveItemToTrash(target); if (!trashed) throw new Error('Could not move item to the Recycle Bin.'); return `Moved to Recycle Bin: ${action.path}`; }
    case 'open': { const target = resolveSafe(root, action.path); await fs.access(target); const result = await context.shell.openPath(target); if (result) throw new Error(result); return `Opened: ${action.path}`; }
    case 'send_email': return sendEmail(action, root);
    default: throw new Error(`Unsupported action: ${action.type}`);
  }
}

async function executePlan(plan, context) {
  const results = [];
  for (const action of plan.actions) results.push(await executeAction(action, context));
  return results;
}

module.exports = { executePlan };
