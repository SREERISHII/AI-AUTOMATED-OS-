const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const crypto = require('crypto');
const EventEmitter = require('events');

const SESSION_STATES = {
  IDLE: 'IDLE',
  ANALYZING: 'ANALYZING',
  ACTION_PROPOSED: 'ACTION_PROPOSED',
  WAITING_FOR_APPROVAL: 'WAITING_FOR_APPROVAL',
  APPROVED: 'APPROVED',
  EXECUTING: 'EXECUTING',
  COMPLETED: 'COMPLETED',
  BLOCKED: 'BLOCKED',
  SUSPENDED: 'SUSPENDED',
  EMERGENCY_STOP: 'EMERGENCY_STOP',
  TERMINATED: 'TERMINATED',
  FAILED: 'FAILED'
};

const HIGH_RISK_ACTIONS = new Set([
  'create_file',
  'create_folder',
  'rename',
  'move',
  'delete',
  'send_email',
  'copy',
  'upload',
  'share',
  'execute_command',
  'download',
  'archive'
]);

const ALLOWED_TOOLS = new Set([
  'list_directory',
  'search_files',
  'show_task_history',
  'create_folder',
  'create_file',
  'rename',
  'move',
  'delete',
  'open',
  'send_email'
]);

const SENSITIVE_FILE_PATTERN = /(^|[\\/])(\.env|\.git|\.ssh|id_rsa|id_ed25519|credentials|passwords?|secrets?|wallet|.*\.pem|.*\.key|.*\.pfx|.*\.p12|windows|system32|programdata|appdata)([\\/]|$)/i;
const TRAVERSAL_PATTERN = /(\.\.[/\\]|\.\.$)/;
const HIDDEN_FILE_PATTERN = /(^|[/\\])\.[^/\\]+/;

function sanitizeSecrets(data) {
  if (data === null || data === undefined) return data;
  if (typeof data === 'string') {
    return data
      .replace(/pass(word)?\s*[:=]\s*['"]?[^'"\s\n]+['"]?/gi, 'password=[REDACTED]')
      .replace(/auth\s*[:=]\s*\{[^}]+\}/gi, 'auth=[REDACTED]')
      .replace(/bearer\s+[a-zA-Z0-9_\-\.]+/gi, 'Bearer [REDACTED]')
      .replace(/api[_-]?key\s*[:=]\s*['"]?[^'"\s\n]+['"]?/gi, 'api_key=[REDACTED]')
      .replace(/secret\s*[:=]\s*['"]?[^'"\s\n]+['"]?/gi, 'secret=[REDACTED]')
      .replace(/-----BEGIN [A-Z ]+ PRIVATE KEY-----[^-]+-----END [A-Z ]+ PRIVATE KEY-----/gs, '[REDACTED PRIVATE KEY]');
  }
  if (Array.isArray(data)) return data.map(sanitizeSecrets);
  if (typeof data === 'object') {
    const cleaned = {};
    for (const [k, v] of Object.entries(data)) {
      if (/password|secret|pass|token|key|auth|credential/i.test(k)) {
        cleaned[k] = '[REDACTED]';
      } else {
        cleaned[k] = sanitizeSecrets(v);
      }
    }
    return cleaned;
  }
  return data;
}

class SessionActivityManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.documentsRoot = path.resolve(options.documentsRoot || path.join(require('os').homedir(), 'Documents'));
    this.auditPath = options.auditPath || path.join(this.documentsRoot, '..', 'session-audit.jsonl');
    this.emergencyAuditPath = options.emergencyAuditPath || path.join(this.documentsRoot, '..', 'security-emergency.jsonl');
    this.approvalTtlMs = options.approvalTtlMs || 5 * 60 * 1000; // 5 minutes default
    
    // Security Config
    this.allowedFolders = new Set([this.documentsRoot, ...(options.allowedFolders || []).map((f) => path.resolve(f))]);
    this.allowedNetworkDomains = new Set([
      '127.0.0.1',
      'localhost',
      ...(options.allowedNetworkDomains || [])
    ]);
    this.networkAccessEnabled = options.networkAccessEnabled !== undefined ? Boolean(options.networkAccessEnabled) : true;
    this.fileSharingEnabled = options.fileSharingEnabled !== undefined ? Boolean(options.fileSharingEnabled) : false;

    // Shutdown handler
    this.onEmergencyShutdown = options.onEmergencyShutdown || ((violation) => {
      try {
        const { app } = require('electron');
        if (app && typeof app.quit === 'function') {
          app.quit();
          return;
        }
      } catch (_) {}
      process.exit(1);
    });

    this.autoQuitOnViolation = options.autoQuitOnViolation !== undefined ? options.autoQuitOnViolation : true;

    // Session State
    this.sessionId = `sess-${crypto.randomUUID()}`;
    this.state = SESSION_STATES.IDLE;
    this.sessionStartTime = new Date().toISOString();
    this.sessionClosed = false;

    // Trackers
    this.activities = [];
    this.securityAlerts = [];
    this.pendingApprovals = new Map(); // approvalId -> approvalObject
    this.approvedTokens = new Map();   // approvalId -> approvalObject
    this.activeTasks = new Map();      // taskId -> taskObject
    this.childProcesses = new Set();
    this.abortControllers = new Set();
    this.createdTempFiles = new Set();

    this.writeAudit('session_started', {
      sessionId: this.sessionId,
      startTime: this.sessionStartTime,
      allowedFolders: Array.from(this.allowedFolders),
      networkAccessEnabled: this.networkAccessEnabled,
      fileSharingEnabled: this.fileSharingEnabled
    });
  }

  getState() {
    return this.state;
  }

  getSessionId() {
    return this.sessionId;
  }

  setState(newState, detail = {}) {
    const previousState = this.state;
    this.state = newState;
    this.emit('state_changed', { previousState, newState, sessionId: this.sessionId, detail, timestamp: new Date().toISOString() });
    this.writeAudit('state_transition', { from: previousState, to: newState, detail });
  }

  // --- Safe Audit Writing ---
  async writeAudit(event, detail = {}) {
    const record = {
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      event,
      detail: sanitizeSecrets(detail)
    };
    try {
      const line = JSON.stringify(record) + '\n';
      await fs.appendFile(this.auditPath, line, 'utf8');
    } catch (_) {}
    return record;
  }

  async writeEmergencyAudit(record) {
    try {
      const line = JSON.stringify(sanitizeSecrets(record)) + '\n';
      await fs.appendFile(this.emergencyAuditPath, line, 'utf8');
      await fs.appendFile(this.auditPath, line, 'utf8');
    } catch (_) {}
  }

  // --- Activity Tracking ---
  recordActivity(entry) {
    const activity = {
      id: `act-${crypto.randomUUID()}`,
      sessionId: this.sessionId,
      userMessage: entry.userMessage || '',
      modelResponse: entry.modelResponse || '',
      requestedAction: entry.requestedAction || null,
      toolName: entry.toolName || entry.requestedAction?.type || 'unknown',
      sourcePath: entry.sourcePath || entry.requestedAction?.path || null,
      destinationPath: entry.destinationPath || entry.requestedAction?.destination || null,
      networkDestination: entry.networkDestination || null,
      emailRecipient: entry.emailRecipient || (entry.requestedAction?.to ? entry.requestedAction.to.join(', ') : null),
      actionReason: entry.actionReason || '',
      permissionStatus: entry.permissionStatus || 'UNKNOWN',
      approvalStatus: entry.approvalStatus || 'NONE',
      currentStatus: entry.currentStatus || this.state,
      errorMessage: entry.errorMessage || null,
      timestamp: new Date().toISOString()
    };

    const sanitized = sanitizeSecrets(activity);
    this.activities.push(sanitized);
    this.emit('activity_recorded', sanitized);
    this.writeAudit('activity_recorded', sanitized);
    return sanitized;
  }

  // --- Strict Path Validation ---
  validatePathSafety(targetPath, options = {}) {
    const allowNonExistent = options.allowNonExistent || false;
    const isDestination = options.isDestination || false;

    if (typeof targetPath !== 'string' || !targetPath.trim()) {
      return { safe: false, reason: 'Empty or invalid file path' };
    }

    // Check path traversal
    if (TRAVERSAL_PATTERN.test(targetPath)) {
      return { safe: false, reason: 'Path traversal attempt detected (..)' };
    }

    // Check sensitive file names
    if (SENSITIVE_FILE_PATTERN.test(targetPath)) {
      return { safe: false, reason: `Access to sensitive or system path is prohibited: ${path.basename(targetPath)}` };
    }

    // Check hidden files or folders
    if (HIDDEN_FILE_PATTERN.test(targetPath)) {
      return { safe: false, reason: `Access to hidden path or temporary staging area is prohibited: ${targetPath}` };
    }

    // Check against allowed folders
    let canonical = null;
    let insideAllowed = false;

    for (const allowedFolder of this.allowedFolders) {
      const resolved = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(allowedFolder, targetPath);
      const isInside = resolved === allowedFolder || resolved.startsWith(allowedFolder + path.sep);
      if (isInside) {
        canonical = resolved;
        insideAllowed = true;
        break;
      }
    }

    if (!insideAllowed || !canonical) {
      return { safe: false, reason: `Path "${targetPath}" is outside the allowed directories.` };
    }

    return { safe: true, canonical };
  }

  // --- Strict Network Validation ---
  validateNetworkDestination(targetUrlOrHost) {
    if (!this.networkAccessEnabled) {
      return { safe: false, reason: 'Network access is disabled by security configuration.' };
    }

    let hostname = targetUrlOrHost;
    try {
      if (targetUrlOrHost.includes('://')) {
        const parsed = new URL(targetUrlOrHost);
        hostname = parsed.hostname;
      }
    } catch (_) {
      hostname = targetUrlOrHost;
    }

    hostname = (hostname || '').toLowerCase().trim();
    if (this.allowedNetworkDomains.has(hostname) || hostname === '127.0.0.1' || hostname === 'localhost') {
      return { safe: true, hostname };
    }

    return { safe: false, reason: `Network destination "${hostname}" is not on the allowed domain list.` };
  }

  // --- Ollama / AI Input & Output Protection ---
  sanitizeModelPrompt(userPrompt, metadata = {}) {
    const sanitizedPrompt = sanitizeSecrets(userPrompt);
    const purpose = metadata.purpose || 'general_interaction';
    const includesFileContent = Boolean(metadata.includesFileContent);

    this.writeAudit('ollama_prompt_prepared', {
      sessionId: this.sessionId,
      purpose,
      includesFileContent,
      promptLength: sanitizedPrompt.length
    });

    return {
      sanitizedPrompt,
      sessionId: this.sessionId,
      purpose,
      includesFileContent
    };
  }

  validateModelOutput(modelOutput) {
    if (!modelOutput || typeof modelOutput !== 'object') {
      return { valid: false, reason: 'Model output is not valid structured object.' };
    }

    // Check if AI attempted to self-approve or inject approval claims
    if (modelOutput.approved || modelOutput.isApproved || modelOutput.status === 'APPROVED' || modelOutput.bypassApproval) {
      return {
        valid: false,
        securityViolation: true,
        reason: 'AI attempted to self-approve an action or forge an approval status.'
      };
    }

    const actions = Array.isArray(modelOutput.actions) ? modelOutput.actions : [];
    for (const action of actions) {
      if (!action || typeof action !== 'object') {
        return { valid: false, reason: 'Malformed action in plan' };
      }

      // Check for file copy / staging / upload attempt
      if (['copy', 'upload', 'archive', 'download', 'share', 'execute_command'].includes(action.type)) {
        return {
          valid: false,
          securityViolation: true,
          action,
          reason: `AI attempted unauthorized file replication or export: ${action.type}`
        };
      }

      // Check tool allowlist
      if (!ALLOWED_TOOLS.has(action.type)) {
        return {
          valid: false,
          securityViolation: true,
          action,
          reason: `AI requested an unauthorized or forbidden tool: ${action.type}`
        };
      }

      // Check file sharing prohibition
      if (action.type === 'send_email' && !this.networkAccessEnabled) {
        return {
          valid: false,
          securityViolation: true,
          action,
          reason: 'AI attempted email transmission while network access is disabled.'
        };
      }

      // Validate paths
      if (action.path) {
        const check = this.validatePathSafety(action.path);
        if (!check.safe) {
          return {
            valid: false,
            securityViolation: true,
            action,
            reason: `AI requested path violation: ${check.reason}`
          };
        }
      }

      if (action.destination) {
        const destCheck = this.validatePathSafety(action.destination, { isDestination: true });
        if (!destCheck.safe) {
          return {
            valid: false,
            securityViolation: true,
            action,
            reason: `AI requested destination violation: ${destCheck.reason}`
          };
        }
      }

      // Email attachments validation
      if (action.type === 'send_email' && Array.isArray(action.attachments)) {
        for (const att of action.attachments) {
          const attCheck = this.validatePathSafety(att);
          if (!attCheck.safe) {
            return {
              valid: false,
              securityViolation: true,
              action,
              reason: `AI attached unauthorized or sensitive file: ${attCheck.reason}`
            };
          }
        }
      }
    }

    return { valid: true };
  }

  // --- Strict Approval Gate ---
  createApprovalRequest(action, metadata = {}) {
    if (this.sessionClosed || this.state === SESSION_STATES.TERMINATED || this.state === SESSION_STATES.EMERGENCY_STOP) {
      throw new Error('Cannot request approval: Session is closed or terminated.');
    }

    const approvalId = `appr-${crypto.randomUUID()}`;
    const approval = {
      approvalId,
      sessionId: this.sessionId,
      action: JSON.parse(JSON.stringify(action)), // deep copy
      actionHash: crypto.createHash('sha256').update(JSON.stringify(action)).digest('hex'),
      tool: action.type,
      source: action.path || null,
      destination: action.destination || null,
      recipients: Array.isArray(action.to) ? [...action.to] : null,
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.approvalTtlMs).toISOString(),
      status: 'PENDING',
      reason: metadata.reason || 'User confirmation required for high-risk action'
    };

    this.pendingApprovals.set(approvalId, approval);
    this.setState(SESSION_STATES.WAITING_FOR_APPROVAL, { approvalId, action: approval.action });
    this.recordActivity({
      requestedAction: action,
      permissionStatus: 'REQUIRES_APPROVAL',
      approvalStatus: 'WAITING',
      currentStatus: SESSION_STATES.WAITING_FOR_APPROVAL
    });

    return approval;
  }

  userApproveAction(approvalId) {
    if (this.sessionClosed || this.state === SESSION_STATES.TERMINATED) {
      throw new Error('Session is no longer active.');
    }

    const approval = this.pendingApprovals.get(approvalId);
    if (!approval) {
      throw new Error('Approval request not found or already consumed.');
    }

    if (Date.now() > Date.parse(approval.expiresAt)) {
      approval.status = 'EXPIRED';
      this.pendingApprovals.delete(approvalId);
      this.recordActivity({
        requestedAction: approval.action,
        permissionStatus: 'EXPIRED',
        approvalStatus: 'EXPIRED',
        errorMessage: 'Approval token expired before execution.'
      });
      throw new Error('Approval has expired. Please propose the action again.');
    }

    approval.status = 'APPROVED';
    approval.approvedAt = new Date().toISOString();
    this.pendingApprovals.delete(approvalId);
    this.approvedTokens.set(approvalId, approval);

    this.setState(SESSION_STATES.APPROVED, { approvalId });
    this.recordActivity({
      requestedAction: approval.action,
      permissionStatus: 'ALLOWED',
      approvalStatus: 'APPROVED',
      currentStatus: SESSION_STATES.APPROVED
    });

    return approval;
  }

  userCancelAction(approvalId, reason = 'User cancelled action') {
    const approval = this.pendingApprovals.get(approvalId);
    if (approval) {
      approval.status = 'CANCELLED';
      this.pendingApprovals.delete(approvalId);
    }
    this.approvedTokens.delete(approvalId);

    this.setState(SESSION_STATES.IDLE, { cancelledApprovalId: approvalId, reason });
    this.recordActivity({
      requestedAction: approval ? approval.action : null,
      permissionStatus: 'CANCELLED',
      approvalStatus: 'CANCELLED',
      actionReason: reason,
      currentStatus: SESSION_STATES.IDLE
    });
  }

  // --- Pre-Execution Verification ---
  verifyExecutionEligibility(action, approvalId) {
    // Session state check
    if (this.sessionClosed || this.state === SESSION_STATES.TERMINATED || this.state === SESSION_STATES.EMERGENCY_STOP) {
      const err = 'Execution blocked: Session has been closed or terminated.';
      this.recordActivity({ requestedAction: action, errorMessage: err, currentStatus: this.state });
      throw new Error(err);
    }

    if (this.state === SESSION_STATES.SUSPENDED) {
      const err = 'Execution blocked: Session is currently suspended.';
      this.recordActivity({ requestedAction: action, errorMessage: err, currentStatus: this.state });
      throw new Error(err);
    }

    // Default deny check: High risk action MUST have valid approval
    const isHighRisk = HIGH_RISK_ACTIONS.has(action.type);
    if (isHighRisk) {
      if (!approvalId) {
        throw new Error(`Unauthorized execution: Action "${action.type}" requires explicit user approval.`);
      }

      const token = this.approvedTokens.get(approvalId);
      if (!token) {
        throw new Error('Unauthorized execution: No valid backend approval record found for this action.');
      }

      if (token.sessionId !== this.sessionId) {
        throw new Error('Security violation: Approval token was issued for a different session.');
      }

      if (Date.now() > Date.parse(token.expiresAt)) {
        this.approvedTokens.delete(approvalId);
        throw new Error('Security violation: Approval token has expired.');
      }

      // Check if action was modified after approval
      const currentHash = crypto.createHash('sha256').update(JSON.stringify(action)).digest('hex');
      if (currentHash !== token.actionHash) {
        this.approvedTokens.delete(approvalId);
        throw new Error('Security violation: Action parameters were modified after approval was granted.');
      }

      // Single-use guarantee: consume token immediately
      this.approvedTokens.delete(approvalId);
    }

    // Double check path safety immediately before execution
    if (action.path) {
      const pathCheck = this.validatePathSafety(action.path);
      if (!pathCheck.safe) {
        throw new Error(`Pre-execution safety failure: ${pathCheck.reason}`);
      }
    }

    if (action.destination) {
      const destCheck = this.validatePathSafety(action.destination, { isDestination: true });
      if (!destCheck.safe) {
        throw new Error(`Pre-execution safety failure: ${destCheck.reason}`);
      }
    }

    // Email recipient and network check
    if (action.type === 'send_email') {
      if (!this.networkAccessEnabled) {
        throw new Error('Pre-execution network failure: Network access is disabled.');
      }
      if (!Array.isArray(action.to) || !action.to.length) {
        throw new Error('Pre-execution validation failure: Invalid recipient email.');
      }
    }

    return true;
  }

  // --- Immediate Emergency Response ---
  async triggerEmergencyStop(violation) {
    const eventId = `sec-${crypto.randomUUID()}`;
    const timestamp = new Date().toISOString();

    const securityEvent = {
      eventId,
      timestamp,
      sessionId: this.sessionId,
      violatingAction: violation.action || violation.violatingAction || 'Unknown action',
      toolOrProcess: violation.tool || violation.toolOrProcess || 'AI / Model Agent',
      target: sanitizeSecrets(violation.target || violation.path || violation.destination || violation.url || 'None'),
      reason: violation.reason || 'Unauthorized security boundary violation',
      dataStagedOrCopied: false,
      terminated: true
    };

    this.setState(SESSION_STATES.EMERGENCY_STOP, securityEvent);
    this.securityAlerts.push(securityEvent);

    // 1. Block action & stop tool execution
    // 2. Cancel pending & queued tasks
    this.pendingApprovals.clear();
    this.approvedTokens.clear();
    this.activeTasks.clear();

    // 3. Abort all active fetch / network / Ollama requests
    for (const controller of this.abortControllers) {
      try { controller.abort('Emergency security stop triggered'); } catch (_) {}
    }
    this.abortControllers.clear();

    // 4. Terminate child processes
    for (const child of this.childProcesses) {
      try {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      } catch (_) {}
    }
    this.childProcesses.clear();

    // 5. Clean up temporary files
    await this.cleanupTempFiles();

    // 6. Record minimal local audit log
    await this.writeEmergencyAudit({
      event: 'EMERGENCY_SECURITY_STOP',
      detail: securityEvent
    });

    this.recordActivity({
      requestedAction: violation.action || null,
      permissionStatus: 'BLOCKED_EMERGENCY',
      approvalStatus: 'REVOKED',
      currentStatus: SESSION_STATES.EMERGENCY_STOP,
      errorMessage: securityEvent.reason
    });

    // 7. Emit urgent notification to user (read-only)
    this.emit('security_alert', securityEvent);

    // 8. Mark session TERMINATED
    this.sessionClosed = true;
    this.setState(SESSION_STATES.TERMINATED, { eventId, reason: securityEvent.reason });

    // 9. Automatic termination without asking for confirmation
    if (typeof this.onEmergencyShutdown === 'function') {
      try {
        this.onEmergencyShutdown(securityEvent);
      } catch (err) {
        if (this.autoQuitOnViolation) {
          process.exit(1);
        }
      }
    }

    return securityEvent;
  }

  // --- Tracking Child Processes & Abort Controllers ---
  registerChildProcess(child) {
    if (this.sessionClosed || this.state === SESSION_STATES.TERMINATED) {
      try { child.kill('SIGKILL'); } catch (_) {}
      throw new Error('Cannot start child process: Session is terminated.');
    }
    this.childProcesses.add(child);
    child.once('exit', () => this.childProcesses.delete(child));
    child.once('error', () => this.childProcesses.delete(child));
    return child;
  }

  createAbortController() {
    if (this.sessionClosed || this.state === SESSION_STATES.TERMINATED) {
      const controller = new AbortController();
      controller.abort();
      return controller;
    }
    const controller = new AbortController();
    this.abortControllers.add(controller);
    return controller;
  }

  releaseAbortController(controller) {
    this.abortControllers.delete(controller);
  }

  registerTempFile(filePath) {
    this.createdTempFiles.add(filePath);
  }

  async cleanupTempFiles() {
    for (const file of this.createdTempFiles) {
      try {
        await fs.rm(file, { recursive: true, force: true });
      } catch (_) {}
    }
    this.createdTempFiles.clear();
  }

  // --- Session Control Actions ---
  suspendSession(reason = 'Suspended by user') {
    if (this.sessionClosed) return;
    this.setState(SESSION_STATES.SUSPENDED, { reason });
    // Abort pending network / LLM calls
    for (const controller of this.abortControllers) {
      try { controller.abort('Session suspended'); } catch (_) {}
    }
    this.abortControllers.clear();
    this.writeAudit('session_suspended', { reason });
  }

  resumeSession() {
    if (this.sessionClosed || this.state === SESSION_STATES.TERMINATED) {
      throw new Error('Cannot resume a terminated session. Please reset.');
    }
    this.setState(SESSION_STATES.IDLE, { resumed: true });
    this.writeAudit('session_resumed', {});
  }

  terminateSession(reason = 'Session closed by user') {
    this.sessionClosed = true;
    this.pendingApprovals.clear();
    this.approvedTokens.clear();
    this.activeTasks.clear();

    for (const controller of this.abortControllers) {
      try { controller.abort('Session terminated'); } catch (_) {}
    }
    this.abortControllers.clear();

    for (const child of this.childProcesses) {
      try { if (!child.killed) child.kill('SIGKILL'); } catch (_) {}
    }
    this.childProcesses.clear();

    this.cleanupTempFiles();
    this.setState(SESSION_STATES.TERMINATED, { reason });
    this.writeAudit('session_terminated', { reason });
  }

  resetSession() {
    this.terminateSession('Resetting for fresh session');
    this.sessionId = `sess-${crypto.randomUUID()}`;
    this.sessionClosed = false;
    this.activities = [];
    this.securityAlerts = [];
    this.state = SESSION_STATES.IDLE;
    this.sessionStartTime = new Date().toISOString();
    this.writeAudit('session_reset', { newSessionId: this.sessionId });
    this.emit('session_reset', { sessionId: this.sessionId });
    return this.sessionId;
  }

  // --- Security Config Updates ---
  updateSecurityConfig(newConfig = {}) {
    if (newConfig.allowedFolders && Array.isArray(newConfig.allowedFolders)) {
      this.allowedFolders = new Set([this.documentsRoot, ...newConfig.allowedFolders.map((f) => path.resolve(f))]);
    }
    if (newConfig.allowedNetworkDomains && Array.isArray(newConfig.allowedNetworkDomains)) {
      this.allowedNetworkDomains = new Set(['127.0.0.1', 'localhost', ...newConfig.allowedNetworkDomains]);
    }
    if (newConfig.networkAccessEnabled !== undefined) {
      this.networkAccessEnabled = Boolean(newConfig.networkAccessEnabled);
    }
    if (newConfig.fileSharingEnabled !== undefined) {
      this.fileSharingEnabled = Boolean(newConfig.fileSharingEnabled);
    }

    const updated = {
      allowedFolders: Array.from(this.allowedFolders),
      allowedNetworkDomains: Array.from(this.allowedNetworkDomains),
      networkAccessEnabled: this.networkAccessEnabled,
      fileSharingEnabled: this.fileSharingEnabled
    };

    this.writeAudit('security_config_updated', updated);
    this.emit('config_updated', updated);
    return updated;
  }

  getSecurityConfig() {
    return {
      allowedFolders: Array.from(this.allowedFolders),
      allowedNetworkDomains: Array.from(this.allowedNetworkDomains),
      networkAccessEnabled: this.networkAccessEnabled,
      fileSharingEnabled: this.fileSharingEnabled
    };
  }

  getSecurityStatus() {
    return {
      sessionId: this.sessionId,
      state: this.state,
      sessionStartTime: this.sessionStartTime,
      sessionClosed: this.sessionClosed,
      pendingApprovalsCount: this.pendingApprovals.size,
      activeTasksCount: this.activeTasks.size,
      securityAlertsCount: this.securityAlerts.length,
      recentAlert: this.securityAlerts[this.securityAlerts.length - 1] || null,
      config: this.getSecurityConfig()
    };
  }

  exportSecurityReport() {
    const report = {
      reportGeneratedAt: new Date().toISOString(),
      sessionId: this.sessionId,
      state: this.state,
      config: this.getSecurityConfig(),
      securityAlerts: this.securityAlerts,
      recentActivities: this.activities.slice(-50),
      summary: {
        totalActivities: this.activities.length,
        totalAlerts: this.securityAlerts.length,
        isTerminated: this.sessionClosed
      }
    };
    return sanitizeSecrets(report);
  }
}

module.exports = {
  SessionActivityManager,
  SESSION_STATES,
  HIGH_RISK_ACTIONS,
  ALLOWED_TOOLS,
  sanitizeSecrets
};
