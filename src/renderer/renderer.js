const promptInput = document.querySelector('#promptInput');
const sendBtn = document.querySelector('#sendBtn');
const chatMessages = document.querySelector('#chatMessages');
const chatContainer = document.querySelector('#chatContainer');
const newChatBtn = document.querySelector('#newChatBtn');
const safeRootEl = document.querySelector('#safeRoot');

// Security Activity Manager DOM Elements
const sessionStatusPill = document.querySelector('#sessionStatusPill');
const toggleSecurityPanelBtn = document.querySelector('#toggleSecurityPanelBtn');
const securityPanel = document.querySelector('#securityPanel');
const closeSecurityPanelBtn = document.querySelector('#closeSecurityPanelBtn');
const alertCountBadge = document.querySelector('#alertCountBadge');
const panelSessionId = document.querySelector('#panelSessionId');
const panelStateBadge = document.querySelector('#panelStateBadge');
const tabAlertCountBadge = document.querySelector('#tabAlertCountBadge');
const metricActiveTasks = document.querySelector('#metricActiveTasks');
const metricAlertCount = document.querySelector('#metricAlertCount');
const btnSuspendSession = document.querySelector('#btnSuspendSession');
const btnResumeSession = document.querySelector('#btnResumeSession');
const btnTerminateSession = document.querySelector('#btnTerminateSession');
const btnResetSession = document.querySelector('#btnResetSession');
const btnExportReport = document.querySelector('#btnExportReport');
const alertsContainer = document.querySelector('#alertsContainer');
const activityFeedContainer = document.querySelector('#activityFeedContainer');
const chkNetworkAccess = document.querySelector('#chkNetworkAccess');
const chkFileSharing = document.querySelector('#chkFileSharing');
const allowedFoldersList = document.querySelector('#allowedFoldersList');
const newFolderInput = document.querySelector('#newFolderInput');
const btnAddFolder = document.querySelector('#btnAddFolder');
const allowedDomainsList = document.querySelector('#allowedDomainsList');
const newDomainInput = document.querySelector('#newDomainInput');
const btnAddDomain = document.querySelector('#btnAddDomain');

// Emergency Modal Elements
const emergencyModal = document.querySelector('#emergencyModal');
const emergencyAlertBox = document.querySelector('#emergencyAlertBox');
const emEventId = document.querySelector('#emEventId');
const emAction = document.querySelector('#emAction');
const emTool = document.querySelector('#emTool');
const emTarget = document.querySelector('#emTarget');
const emReason = document.querySelector('#emReason');

let isProcessing = false;
let latestEmailDraft = null;
let pendingApproval = null;
let cachedSecurityConfig = { allowedFolders: [], allowedNetworkDomains: [], networkAccessEnabled: true, fileSharingEnabled: false };

function isEmailRevisionInstruction(text) {
  const lower = text.trim().toLowerCase();
  if (/^(email|mail|send\s+email|send\s+mail)\b/.test(lower) && /@/.test(lower)) return false;
  if (/^(list|display|show|find|search|create|delete|remove|open|move|rename)\b/.test(lower)) return false;
  if (/^(make|use|add|change|revise|rewrite|shorten|expand|remove|update|fix|include|mention|keep|switch|set)\b/.test(lower)) return true;
  if (/\b(formal|tone|professional|polite|casual|shorter|longer|small|brief|concise|greeting|closing|subject|body|sign-?off|tomorrow|approval|leave)\b/.test(lower)) return true;
  return false;
}

function scrollToBottom() {
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

// Auto-adjust textarea height
promptInput.addEventListener('input', () => {
  promptInput.style.height = 'auto';
  promptInput.style.height = Math.min(promptInput.scrollHeight, 120) + 'px';
});

promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});

sendBtn.addEventListener('click', handleSend);

newChatBtn.addEventListener('click', async () => {
  latestEmailDraft = null;
  pendingApproval = null;
  if (window.agent?.clearHistory) {
    const res = await window.agent.clearHistory().catch(() => ({}));
    if (res?.sessionId) {
      panelSessionId.textContent = `Session: ${res.sessionId}`;
    }
  }
  chatMessages.innerHTML = `
    <div class="message-group agent-group">
      <div class="avatar">🤖</div>
      <div class="message-bubble agent-bubble">
        <p>Conversation cleared and session reset. How can I help you with your files or emails?</p>
      </div>
    </div>
  `;
  refreshSecurityStatus();
});

function appendUserMessage(text) {
  const group = document.createElement('div');
  group.className = 'message-group user-group';
  group.innerHTML = `
    <div class="avatar">👤</div>
    <div class="message-bubble user-bubble">${escapeHtml(text)}</div>
  `;
  chatMessages.appendChild(group);
  scrollToBottom();
}

function showTypingIndicator() {
  const group = document.createElement('div');
  group.className = 'message-group agent-group typing-group';
  group.innerHTML = `
    <div class="avatar">🤖</div>
    <div class="message-bubble agent-bubble typing-indicator">
      <div class="dot-flashing"></div>
      <div class="dot-flashing"></div>
      <div class="dot-flashing"></div>
    </div>
  `;
  chatMessages.appendChild(group);
  scrollToBottom();
  return group;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function normalizeDraftValue(value) {
  return String(value || '').replace(/\\+r\\+n/g, '\n').replace(/\\+n/g, '\n').replace(/\\+r/g, '\n').replace(/\r\n?/g, '\n').trim();
}

function emailActionsEqual(left, right) {
  const addresses = (value) => (Array.isArray(value) ? value : []).map((item) => String(item).trim().toLowerCase()).filter(Boolean);
  const attachments = (value) => (Array.isArray(value) ? value : []).map((item) => String(item).trim()).filter(Boolean);
  return JSON.stringify(addresses(left.to)) === JSON.stringify(addresses(right.to))
    && normalizeDraftValue(left.subject) === normalizeDraftValue(right.subject)
    && normalizeDraftValue(left.body) === normalizeDraftValue(right.body)
    && JSON.stringify(attachments(left.attachments)) === JSON.stringify(attachments(right.attachments));
}

function describeAction(action) {
  const label = (val) => val === '.' ? 'Documents' : val;
  switch (action.type) {
    case 'create_folder': return `Create folder "${label(action.path)}"`;
    case 'create_file': return `Create file "${label(action.path)}"`;
    case 'rename': return `Rename "${label(action.path)}" to "${label(action.destination)}"`;
    case 'move': return `Move "${label(action.path)}" to "${label(action.destination)}"`;
    case 'delete': return `Move "${label(action.path)}" to Recycle Bin`;
    case 'open': return `Open "${label(action.path)}"`;
    case 'list_directory': {
      const dirName = label(action.path || '.');
      const typeInfo = action.entryType === 'folder' ? ' (folders only)' : action.entryType === 'file' ? ' (files only)' : '';
      const prefixInfo = action.startsWith ? ` starting with "${action.startsWith}"` : '';
      return `List contents of ${dirName}${typeInfo}${prefixInfo}`;
    }
    case 'search_files': {
      const parts = [];
      if (action.query) parts.push(`"${action.query}"`);
      if (action.ext) parts.push(`.${action.ext} files`);
      const details = parts.length > 0 ? parts.join(' ') : 'all files';
      return `Search for ${details} in Documents`;
    }
    case 'show_task_history': return 'Show recent task history';
    case 'send_email': return `Send email to ${action.to?.join(', ') || 'recipient'} — ${action.subject || 'No Subject'}`;
    default: return action.type;
  }
}

async function handleSend() {
  const text = promptInput.value.trim();
  if (!text || isProcessing) return;

  isProcessing = true;
  promptInput.value = '';
  promptInput.style.height = 'auto';
  sendBtn.disabled = true;

  if (pendingApproval && /^(yes|yeah|yep|yup|sure|ok|okay|confirm|confirmed|do it|send|send it|proceed|go ahead|approve|execute)$/i.test(text)) {
    const pending = pendingApproval;
    pendingApproval = null;
    appendUserMessage(text);
    const typingGroup = showTypingIndicator();
    try {
      if (pending.approvalId && window.agent?.approveAction) {
        await window.agent.approveAction(pending.approvalId).catch(() => {});
      }
      const results = await window.agent.execute(pending.plan, pending.capability, pending.approvalId);
      typingGroup.remove();
      renderExecutionResults(results, pending.plan);
    } catch (err) {
      typingGroup.remove();
      renderAgentTextResponse(`I couldn't complete that action: ${err.message}`);
    } finally {
      isProcessing = false;
      sendBtn.disabled = false;
    }
    return;
  }

  if (pendingApproval && /^(no|nope|cancel|stop|not now|never mind|forget it|don'?t|dont|nah|skip)$/i.test(text)) {
    const pending = pendingApproval;
    pendingApproval = null;
    if (pending.approvalId && window.agent?.cancelAction) {
      await window.agent.cancelAction(pending.approvalId, 'User cancelled via chat prompt').catch(() => {});
    }
    appendUserMessage(text);
    renderAgentTextResponse('Understood. I cancelled that action. What would you like to do instead?');
    isProcessing = false;
    sendBtn.disabled = false;
    return;
  }

  if (latestEmailDraft && isEmailRevisionInstruction(text)) {
    const currentDraft = latestEmailDraft.readComposerState();
    appendUserMessage(text);
    const typingGroup = showTypingIndicator();
    try {
      const revisedData = await window.agent.reviseEmail(currentDraft, text);
      typingGroup.remove();
      renderAgentPlanResponse(revisedData, text);
    } catch (err) {
      typingGroup.remove();
      renderAgentTextResponse(`I couldn't revise the draft: ${err.message}`);
    } finally {
      isProcessing = false;
      sendBtn.disabled = false;
    }
    return;
  }

  appendUserMessage(text);
  const typingGroup = showTypingIndicator();

  try {
    const data = await window.agent.plan(text);
    typingGroup.remove();

    if (data.documentsRoot) {
      safeRootEl.textContent = data.documentsRoot;
    }

    renderAgentPlanResponse(data, text);
  } catch (err) {
    typingGroup.remove();
    renderAgentTextResponse(`Something went wrong: ${err.message}. Please try again.`);
  } finally {
    isProcessing = false;
    sendBtn.disabled = false;
  }
}

function renderAgentTextResponse(text) {
  const group = document.createElement('div');
  group.className = 'message-group agent-group';
  group.innerHTML = `
    <div class="avatar">🤖</div>
    <div class="message-bubble agent-bubble">
      <p>${escapeHtml(text)}</p>
    </div>
  `;
  chatMessages.appendChild(group);
  scrollToBottom();
}

function renderAgentPlanResponse(data, originalRequest) {
  const { plan, permission, capability } = data;
  const group = document.createElement('div');
  group.className = 'message-group agent-group';

  if (!plan.actions?.length) {
    const replyText = plan.reply || plan.summary || "I'm here to help. What would you like to do?";
    group.innerHTML = `
      <div class="avatar">🤖</div>
      <div class="message-bubble agent-bubble">
        <p>${escapeHtml(replyText)}</p>
      </div>
    `;
    chatMessages.appendChild(group);
    scrollToBottom();
    return;
  }

  const isEmail = plan.actions.some((a) => a.type === 'send_email');
  const isReadOnly = plan.actions.length > 0 && plan.actions.every((a) => ['list_directory', 'search_files', 'show_task_history'].includes(a.type));

  let cardHtml = '';

  if (isEmail) {
    const emailAction = plan.actions.find((a) => a.type === 'send_email');
    cardHtml = renderEmailDraftCard(emailAction, permission, plan);
  } else {
    cardHtml = renderActionPlanCard(plan, permission, isReadOnly);
  }

  // Natural language summary instead of raw task metadata
  const summaryText = plan.summary || 'Proposed Actions';

  group.innerHTML = `
    <div class="avatar">🤖</div>
    <div class="message-bubble agent-bubble">
      <p>${escapeHtml(summaryText)}</p>
      ${cardHtml}
    </div>
  `;

  chatMessages.appendChild(group);
  scrollToBottom();

  attachCardEventListeners(group, plan, isEmail, capability);

  if (capability && permission.allowed && !isReadOnly) {
    pendingApproval = { plan, capability, approvalId: plan.approvalId, group };
  }

  // If read-only operation (e.g. list directory or search), auto-execute for immediate user delight
  if (isReadOnly && permission.allowed) {
    autoExecuteReadOnly(plan, group, capability);
  }
}

function renderEmailDraftCard(emailAction, permission, plan) {
  const toStr = (emailAction.to || []).join(', ');
  const attachmentsList = (emailAction.attachments || []).length
    ? (emailAction.attachments || []).map((att) => `<code>📎 ${escapeHtml(att)}</code>`).join(' ')
    : 'None';

  const badgeClass = permission.allowed ? 'badge-allowed' : 'badge-blocked';
  const badgeText = permission.allowed ? 'Ready to send' : `Blocked: ${permission.reasons.join('; ')}`;
  const cleanBody = String(emailAction.body || '').replace(/\\+r\\+n/g, '\n').replace(/\\+n/g, '\n');

  return `
    <div class="card email-card">
      <div class="card-header">
        <span class="card-title">✉️ Email Draft</span>
        <span class="badge ${badgeClass}">${escapeHtml(badgeText)}</span>
      </div>

      <div class="email-composer">
        <div class="composer-field">
          <label class="composer-label">To</label>
          <input type="text" class="composer-input email-to-input" value="${escapeHtml(toStr)}" placeholder="recipient@example.com" />
        </div>
        <div class="composer-field">
          <label class="composer-label">Subject</label>
          <input type="text" class="composer-input email-subject-input" value="${escapeHtml(emailAction.subject || '')}" placeholder="Email subject..." />
        </div>
        <div class="composer-field composer-body-field">
          <label class="composer-label">Body</label>
          <textarea class="composer-textarea email-body-input" rows="6" placeholder="Write your email...">${escapeHtml(cleanBody)}</textarea>
        </div>
        <div class="email-field"><strong>Attachments:</strong> ${attachmentsList}</div>
      </div>

      ${permission.allowed ? `
        <div class="composer-prompt">
          <span class="composer-prompt-icon">🤖</span>
          <span>Review the draft above. You can <strong>edit fields directly</strong>, type revision instructions below, or hit <strong>Send</strong> when ready.</span>
        </div>
        <div class="revision-box">
          <input type="text" class="revision-input" placeholder="e.g. Make it more formal, add a greeting, mention deadline..." />
          <button class="btn btn-small btn-outline btn-revise">Revise with AI</button>
        </div>
        <div class="card-actions">
          <button class="btn btn-small btn-success btn-send-email">✉️ Send Email</button>
          <button class="btn btn-small btn-outline btn-copy">Copy Body</button>
        </div>
      ` : `
        <div class="card-actions">
          <p style="color:var(--accent-red); font-size:12px; margin:4px 0 0 0;">Cannot send: ${permission.reasons.map(escapeHtml).join(' ')}</p>
        </div>
      `}
    </div>
  `;
}

function renderActionPlanCard(plan, permission, isReadOnly) {
  const badgeClass = permission.allowed ? 'badge-allowed' : 'badge-blocked';
  const badgeText = permission.allowed ? (isReadOnly ? 'Auto-executing' : 'Waiting for your confirmation') : `Blocked: ${permission.reasons.join('; ')}`;

  const actionsListHtml = plan.actions
    .map((action) => `<li>${escapeHtml(describeAction(action))}</li>`)
    .join('');

  return `
    <div class="card action-card ${!permission.allowed ? 'card-blocked' : ''}">
      <div class="card-header">
        <span class="card-title">📋 Planned Actions</span>
        <span class="badge ${badgeClass}">${escapeHtml(badgeText)}</span>
      </div>
      <ul class="action-list">${actionsListHtml}</ul>
      ${!permission.allowed ? `
        <div class="security-restriction-banner" style="margin-top: 10px; padding: 10px 12px; background: rgba(239, 68, 68, 0.12); border: 1px solid var(--accent-red); border-radius: 6px; color: var(--accent-red); font-size: 13px; line-height: 1.4;">
          <strong>🛡️ Access Restricted</strong><br/>
          This action was blocked by the Security Activity Manager because the target path is outside your protected Documents safe area.
        </div>
      ` : ''}
      ${!isReadOnly && permission.allowed ? `
        <div class="card-actions">
          <button class="btn btn-small btn-primary btn-execute-plan">Confirm & Execute</button>
          <button class="btn btn-small btn-outline btn-cancel-plan">Cancel Action</button>
        </div>
      ` : ''}
    </div>
  `;
}

function attachCardEventListeners(group, plan, isEmail, capability) {
  if (isEmail) {
    const emailAction = plan.actions.find((a) => a.type === 'send_email');
    const reviseBtn = group.querySelector('.btn-revise');
    const revisionInput = group.querySelector('.revision-input');
    const sendBtnEl = group.querySelector('.btn-send-email');
    const copyBtn = group.querySelector('.btn-copy');

    // Helper: read the current state of the composer fields (supports live user edits)
    function readComposerState() {
      const toInput = group.querySelector('.email-to-input');
      const subjectInput = group.querySelector('.email-subject-input');
      const bodyInput = group.querySelector('.email-body-input');
      const fallbackTo = Array.isArray(emailAction.to) ? emailAction.to : [];
      const fallbackSubject = String(emailAction.subject || '');
      const fallbackBody = String(emailAction.body || '');
      const rawBody = (bodyInput?.value || '').trim() || fallbackBody;
      const cleanBody = rawBody.replace(/\\+r\\+n/g, '\n').replace(/\\+n/g, '\n');
      return {
        type: 'send_email',
        to: (toInput?.value || '').split(/[,;]/).map(s => s.trim()).filter(Boolean).length
          ? (toInput.value || '').split(/[,;]/).map(s => s.trim()).filter(Boolean)
          : fallbackTo,
        subject: (subjectInput?.value || '').trim() || fallbackSubject,
        body: cleanBody,
        attachments: emailAction.attachments || []
      };
    }

    latestEmailDraft = {
      group,
      plan,
      capability,
      readComposerState
    };

    group.querySelectorAll('.email-to-input, .email-subject-input, .email-body-input').forEach((input) => {
      input.addEventListener('input', () => {
        if (pendingApproval?.group === group) pendingApproval = null;
      });
    });

    if (reviseBtn && revisionInput) {
      const handleRevision = async () => {
        const instruction = revisionInput.value.trim();
        if (!instruction) return;
        revisionInput.value = '';

        const currentDraft = readComposerState();
        appendUserMessage(instruction);
        const typing = showTypingIndicator();

        try {
          const revisedData = await window.agent.reviseEmail(currentDraft, instruction);
          typing.remove();
          renderAgentPlanResponse(revisedData, instruction);
        } catch (err) {
          typing.remove();
          renderAgentTextResponse(`I couldn't revise the draft: ${err.message}`);
        }
      };

      reviseBtn.addEventListener('click', handleRevision);
      revisionInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleRevision();
      });
    }

    if (sendBtnEl) {
      sendBtnEl.addEventListener('click', async () => {
        sendBtnEl.disabled = true;

        const liveAction = readComposerState();
        let targetPlan = plan;
        let targetCapability = capability;
        let activeApprovalId = plan.approvalId;

        const typing = showTypingIndicator();
        try {
          if (!emailActionsEqual(liveAction, emailAction)) {
            const approved = await window.agent.approveDraft(liveAction);
            targetPlan = approved.plan;
            targetCapability = approved.capability;
            activeApprovalId = approved.approvalId;
          } else if (activeApprovalId && window.agent?.approveAction) {
            await window.agent.approveAction(activeApprovalId).catch(() => {});
          }

          latestEmailDraft = null;
          pendingApproval = null;
          const results = await window.agent.execute(targetPlan, targetCapability, activeApprovalId);
          typing.remove();
          renderExecutionResults(results, targetPlan);
        } catch (err) {
          typing.remove();
          renderAgentTextResponse(`Email dispatch failed: ${err.message}`);
          sendBtnEl.disabled = false;
        }
      });
    }

    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        const bodyInput = group.querySelector('.email-body-input');
        navigator.clipboard.writeText(bodyInput?.value || emailAction.body || '');
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy Body'; }, 2000);
      });
    }
  } else {
    const executeBtn = group.querySelector('.btn-execute-plan');
    const cancelBtn = group.querySelector('.btn-cancel-plan');

    if (executeBtn) {
      executeBtn.addEventListener('click', async () => {
        executeBtn.disabled = true;
        if (plan.approvalId && window.agent?.approveAction) {
          await window.agent.approveAction(plan.approvalId).catch(() => {});
        }
        const typing = showTypingIndicator();
        try {
          const results = await window.agent.execute(plan, capability, plan.approvalId);
          typing.remove();
          renderExecutionResults(results, plan);
        } catch (err) {
          typing.remove();
          renderAgentTextResponse(`Action failed: ${err.message}`);
        }
      });
    }

    if (cancelBtn) {
      cancelBtn.addEventListener('click', async () => {
        if (plan.approvalId && window.agent?.cancelAction) {
          await window.agent.cancelAction(plan.approvalId, 'User clicked Cancel Action button').catch(() => {});
        }
        pendingApproval = null;
        renderAgentTextResponse('Cancelled that action.');
        group.remove();
      });
    }
  }
}

async function autoExecuteReadOnly(plan, group, capability) {
  try {
    const results = await window.agent.execute(plan, capability, plan.approvalId);
    renderExecutionResults(results, plan);
  } catch (err) {
    renderAgentTextResponse(`I couldn't complete that: ${err.message}`);
  }
}

function renderExecutionResults(results, plan) {
  const group = document.createElement('div');
  group.className = 'message-group agent-group';

  const resultItems = (results || [])
    .map((res) => `<li>${escapeHtml(res)}</li>`)
    .join('');

  const actionType = plan?.actions?.[0]?.type || '';
  let completionLabel = 'Done!';
  if (actionType === 'list_directory' || actionType === 'search_files') completionLabel = 'Here\'s what I found:';
  else if (actionType === 'show_task_history') completionLabel = 'Recent task history:';
  else if (actionType === 'send_email') completionLabel = 'Email sent successfully!';
  else if (actionType === 'create_folder' || actionType === 'create_file') completionLabel = 'Created successfully!';
  else if (actionType === 'delete') completionLabel = 'Moved to Recycle Bin.';
  else if (actionType === 'rename') completionLabel = 'Renamed successfully!';
  else if (actionType === 'move') completionLabel = 'Moved successfully!';
  else if (actionType === 'open') completionLabel = 'Opened!';

  group.innerHTML = `
    <div class="avatar">🤖</div>
    <div class="message-bubble agent-bubble">
      <p style="color:var(--accent-green); font-weight:600;">✅ ${escapeHtml(completionLabel)}</p>
      <ul class="action-list">${resultItems}</ul>
    </div>
  `;

  chatMessages.appendChild(group);
  scrollToBottom();
}

// ==========================================================================
//  Security Activity Manager Controller & Panel Logic
// ==========================================================================

function updateStatePill(state) {
  const stateClassMap = {
    IDLE: 'pill-idle',
    ANALYZING: 'pill-analyzing',
    ACTION_PROPOSED: 'pill-action-proposed',
    WAITING_FOR_APPROVAL: 'pill-waiting',
    APPROVED: 'pill-approved',
    EXECUTING: 'pill-executing',
    COMPLETED: 'pill-completed',
    BLOCKED: 'pill-blocked',
    SUSPENDED: 'pill-suspended',
    EMERGENCY_STOP: 'pill-emergency-stop',
    TERMINATED: 'pill-terminated',
    FAILED: 'pill-failed'
  };

  const cls = stateClassMap[state] || 'pill-idle';
  if (sessionStatusPill) {
    sessionStatusPill.className = `session-pill ${cls}`;
    sessionStatusPill.textContent = state;
  }
  if (panelStateBadge) {
    panelStateBadge.className = `session-pill ${cls}`;
    panelStateBadge.textContent = state;
  }

  if (state === 'SUSPENDED') {
    btnSuspendSession?.classList.add('hidden');
    btnResumeSession?.classList.remove('hidden');
  } else {
    btnSuspendSession?.classList.remove('hidden');
    btnResumeSession?.classList.add('hidden');
  }
}

// Panel Toggle
toggleSecurityPanelBtn?.addEventListener('click', () => {
  securityPanel?.classList.toggle('hidden');
  if (!securityPanel?.classList.contains('hidden')) {
    refreshSecurityStatus();
  }
});

closeSecurityPanelBtn?.addEventListener('click', () => {
  securityPanel?.classList.add('hidden');
});

// Tab Switching
document.querySelectorAll('.sec-tab').forEach((tabBtn) => {
  tabBtn.addEventListener('click', () => {
    document.querySelectorAll('.sec-tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.sec-tab-pane').forEach((p) => p.classList.remove('active'));
    tabBtn.classList.add('active');
    const targetId = tabBtn.getAttribute('data-tab');
    const pane = document.querySelector(`#${targetId}`);
    if (pane) pane.classList.add('active');
  });
});

// Controls
btnSuspendSession?.addEventListener('click', async () => {
  await window.agent?.suspendSession('Suspended manually by user from control panel');
  refreshSecurityStatus();
});

btnResumeSession?.addEventListener('click', async () => {
  await window.agent?.resumeSession();
  refreshSecurityStatus();
});

btnTerminateSession?.addEventListener('click', async () => {
  await window.agent?.terminateSession('Terminated manually by user from control panel');
  refreshSecurityStatus();
});

btnResetSession?.addEventListener('click', async () => {
  const res = await window.agent?.resetSession();
  if (res?.sessionId) {
    panelSessionId.textContent = `Session: ${res.sessionId}`;
  }
  refreshSecurityStatus();
});

btnExportReport?.addEventListener('click', async () => {
  const report = await window.agent?.exportSecurityReport();
  if (!report) return;
  const jsonBlob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(jsonBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `security-audit-${report.sessionId || 'session'}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// Configuration Toggles
chkNetworkAccess?.addEventListener('change', async () => {
  cachedSecurityConfig.networkAccessEnabled = chkNetworkAccess.checked;
  await window.agent?.updateSecurityConfig(cachedSecurityConfig);
});

chkFileSharing?.addEventListener('change', async () => {
  cachedSecurityConfig.fileSharingEnabled = chkFileSharing.checked;
  await window.agent?.updateSecurityConfig(cachedSecurityConfig);
});

btnAddFolder?.addEventListener('click', async () => {
  const val = newFolderInput?.value.trim();
  if (!val) return;
  cachedSecurityConfig.allowedFolders = [...new Set([...(cachedSecurityConfig.allowedFolders || []), val])];
  newFolderInput.value = '';
  await window.agent?.updateSecurityConfig(cachedSecurityConfig);
  renderConfigTags();
});

btnAddDomain?.addEventListener('click', async () => {
  const val = newDomainInput?.value.trim().toLowerCase();
  if (!val) return;
  cachedSecurityConfig.allowedNetworkDomains = [...new Set([...(cachedSecurityConfig.allowedNetworkDomains || []), val])];
  newDomainInput.value = '';
  await window.agent?.updateSecurityConfig(cachedSecurityConfig);
  renderConfigTags();
});

function renderConfigTags() {
  if (allowedFoldersList) {
    allowedFoldersList.innerHTML = (cachedSecurityConfig.allowedFolders || []).map((f) => `
      <span class="tag-badge">
        📁 ${escapeHtml(f)}
        <button class="tag-remove-btn" data-type="folder" data-val="${escapeHtml(f)}" title="Remove folder">×</button>
      </span>
    `).join('');
  }

  if (allowedDomainsList) {
    allowedDomainsList.innerHTML = (cachedSecurityConfig.allowedNetworkDomains || []).map((d) => `
      <span class="tag-badge">
        🌐 ${escapeHtml(d)}
        <button class="tag-remove-btn" data-type="domain" data-val="${escapeHtml(d)}" title="Remove domain">×</button>
      </span>
    `).join('');
  }

  document.querySelectorAll('.tag-remove-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const type = btn.getAttribute('data-type');
      const val = btn.getAttribute('data-val');
      if (type === 'folder') {
        cachedSecurityConfig.allowedFolders = cachedSecurityConfig.allowedFolders.filter((x) => x !== val);
      } else if (type === 'domain') {
        cachedSecurityConfig.allowedNetworkDomains = cachedSecurityConfig.allowedNetworkDomains.filter((x) => x !== val);
      }
      await window.agent?.updateSecurityConfig(cachedSecurityConfig);
      renderConfigTags();
    });
  });
}

function renderAlertItem(alert) {
  const div = document.createElement('div');
  div.className = 'alert-item-card read-only';
  div.innerHTML = `
    <div class="alert-item-header">
      <span class="alert-title-strong">🚨 Security Alert: Unauthorized Action Blocked</span>
      <span class="alert-time">${escapeHtml(alert.timestamp || new Date().toISOString())}</span>
    </div>
    <p class="alert-message-text">
      Security alert: The AI attempted to execute <strong>${escapeHtml(alert.violatingAction || 'an action')}</strong> on <code>${escapeHtml(alert.target || 'target')}</code> without approved permission. The action was blocked and the application session status is <strong>${alert.terminated ? 'TERMINATED' : 'BLOCKED'}</strong>.
    </p>
    <div class="alert-meta-grid">
      <div><strong>Audit Event ID:</strong> <code>${escapeHtml(alert.eventId || 'N/A')}</code></div>
      <div><strong>Tool / Process:</strong> ${escapeHtml(alert.toolOrProcess || 'AI Model')}</div>
      <div><strong>Reason:</strong> ${escapeHtml(alert.reason || 'Unauthorized')}</div>
      <div><strong>Data Staging Check:</strong> Staged files cleaned / blocked</div>
    </div>
  `;
  return div;
}

function renderActivityItem(act) {
  const div = document.createElement('div');
  div.className = 'activity-item-card';
  div.innerHTML = `
    <div class="act-header">
      <span class="act-tool">Tool: ${escapeHtml(act.toolName || 'unknown')}</span>
      <span class="act-time">${escapeHtml(act.timestamp?.split('T')[1]?.slice(0, 8) || '')}</span>
    </div>
    <div class="act-detail">
      <strong>User:</strong> "${escapeHtml(act.userMessage || 'N/A')}"
    </div>
    <div class="act-meta">
      Status: <code>${escapeHtml(act.currentStatus || 'UNKNOWN')}</code> |
      Approval: <code>${escapeHtml(act.approvalStatus || 'NONE')}</code>
      ${act.sourcePath ? ` | Source: <code>${escapeHtml(act.sourcePath)}</code>` : ''}
      ${act.destinationPath ? ` | Dest: <code>${escapeHtml(act.destinationPath)}</code>` : ''}
      ${act.emailRecipient ? ` | Recipient: <code>${escapeHtml(act.emailRecipient)}</code>` : ''}
      ${act.errorMessage ? ` | <span style="color:#f87171;">Error: ${escapeHtml(act.errorMessage)}</span>` : ''}
    </div>
  `;
  return div;
}

async function refreshSecurityStatus() {
  if (!window.agent?.getSecurityStatus) return;
  try {
    const status = await window.agent.getSecurityStatus();
    if (!status) return;

    if (panelSessionId) panelSessionId.textContent = `Session: ${status.sessionId}`;
    updateStatePill(status.state);

    if (metricActiveTasks) metricActiveTasks.textContent = status.activeTasksCount || 0;
    if (metricAlertCount) metricAlertCount.textContent = status.securityAlertsCount || 0;

    const count = status.securityAlertsCount || 0;
    if (alertCountBadge) {
      alertCountBadge.textContent = count;
      alertCountBadge.classList.toggle('hidden', count === 0);
    }
    if (tabAlertCountBadge) {
      tabAlertCountBadge.textContent = count;
    }

    if (status.config) {
      cachedSecurityConfig = status.config;
      if (chkNetworkAccess) chkNetworkAccess.checked = Boolean(status.config.networkAccessEnabled);
      if (chkFileSharing) chkFileSharing.checked = Boolean(status.config.fileSharingEnabled);
      renderConfigTags();
    }

    // Refresh Alerts
    const alerts = await window.agent.getAlerts();
    if (alertsContainer && Array.isArray(alerts)) {
      if (alerts.length === 0) {
        alertsContainer.innerHTML = '<div class="sec-empty-state">No security boundary violations detected. System is secure.</div>';
      } else {
        alertsContainer.innerHTML = '';
        for (const a of [...alerts].reverse()) {
          alertsContainer.appendChild(renderAlertItem(a));
        }
      }
    }

    // Refresh Activities
    const activities = await window.agent.getActivities();
    if (activityFeedContainer && Array.isArray(activities)) {
      if (activities.length === 0) {
        activityFeedContainer.innerHTML = '<div class="sec-empty-state">No activities recorded in current session.</div>';
      } else {
        activityFeedContainer.innerHTML = '';
        for (const act of [...activities].reverse().slice(0, 30)) {
          activityFeedContainer.appendChild(renderActivityItem(act));
        }
      }
    }
  } catch (_) {}
}

// Real-time Event Listeners from Main Process
if (window.agent?.onStateChanged) {
  window.agent.onStateChanged((info) => {
    updateStatePill(info.newState);
  });
}

if (window.agent?.onSecurityAlert) {
  window.agent.onSecurityAlert((alert) => {
    refreshSecurityStatus();
    securityPanel?.classList.remove('hidden');
    // Switch to alerts tab
    document.querySelector('.sec-tab[data-tab="tab-alerts"]')?.click();
  });
}

if (window.agent?.onEmergencyShutdown) {
  window.agent.onEmergencyShutdown((violation) => {
    if (emergencyModal) {
      emergencyModal.classList.remove('hidden');
      if (emergencyAlertBox) {
        emergencyAlertBox.textContent = `Security alert: The AI attempted to execute "${violation.violatingAction}" on "${violation.target}" without approved permission. The action was blocked and the application was closed automatically.`;
      }
      if (emEventId) emEventId.textContent = violation.eventId || 'N/A';
      if (emAction) emAction.textContent = violation.violatingAction || 'N/A';
      if (emTool) emTool.textContent = violation.toolOrProcess || 'N/A';
      if (emTarget) emTarget.textContent = violation.target || 'N/A';
      if (emReason) emReason.textContent = violation.reason || 'N/A';
    }
    updateStatePill('EMERGENCY_STOP');
  });
}

if (window.agent?.onActivity) {
  window.agent.onActivity((act) => {
    if (activityFeedContainer) {
      const emptyState = activityFeedContainer.querySelector('.sec-empty-state');
      if (emptyState) emptyState.remove();
      activityFeedContainer.prepend(renderActivityItem(act));
    }
  });
}

// Initial fetch on window load
document.addEventListener('DOMContentLoaded', () => {
  refreshSecurityStatus();
});

