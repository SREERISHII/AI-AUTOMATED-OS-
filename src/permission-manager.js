const path = require('path');

const allowedTypes = new Set(['list_directory', 'search_files', 'show_task_history', 'create_folder', 'create_file', 'rename', 'move', 'delete', 'open', 'send_email']);
const protectedNames = /(^|[\\/])(windows|program files|programdata|appdata|\.ssh|\.git|system volume information)([\\/]|$)/i;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sensitiveAttachment = /(^|[\\/])(\.env|id_rsa|id_ed25519|credentials|passwords?|secrets?|wallet|.*\.(pem|key|pfx|p12))$/i;

function safeDocumentPath(value, root) {
  if (typeof value !== 'string' || !value.trim() || path.isAbsolute(value) || protectedNames.test(value)) return false;
  const resolved = path.resolve(root, value);
  return resolved === root || resolved.startsWith(root + path.sep);
}

function checkPlan(plan, root) {
  const reasons = [];
  if (!plan || !Array.isArray(plan.actions) || plan.actions.length === 0) reasons.push('No executable action was proposed.');
  if (plan?.actions?.length > 5) reasons.push('Too many actions in one request.');
  for (const [index, action] of (plan?.actions || []).entries()) {
    const label = `Action ${index + 1}`;
    if (!allowedTypes.has(action.type)) reasons.push(`${label}: action type is not allowed.`);
    const targetPath = action.path || '.';
    if (!['send_email', 'show_task_history'].includes(action.type) && !safeDocumentPath(targetPath, root)) reasons.push(`${label}: path is outside the Documents safe area.`);
    if (['rename', 'move'].includes(action.type) && !safeDocumentPath(action.destination, root)) reasons.push(`${label}: destination is outside the Documents safe area.`);
    if (action.type === 'send_email') {
      if (!Array.isArray(action.to) || action.to.length === 0 || action.to.some((address) => !emailPattern.test(address))) reasons.push(`${label}: recipient email is invalid.`);
      if (!String(action.subject || '').trim() || !String(action.body || '').trim()) reasons.push(`${label}: email subject and body are required.`);
      for (const attachment of action.attachments || []) {
        if (!safeDocumentPath(attachment, root)) reasons.push(`${label}: an attachment is outside the Documents safe area.`);
        if (sensitiveAttachment.test(attachment)) reasons.push(`${label}: a potentially sensitive attachment was blocked.`);
      }
    }
  }
  const requiresConfirmation = (plan?.actions || []).some((action) => !['list_directory', 'search_files', 'show_task_history'].includes(action.type));
  return { allowed: reasons.length === 0, reasons, requiresConfirmation };
}

module.exports = { checkPlan, safeDocumentPath };

