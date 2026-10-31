const promptInput = document.querySelector('#promptInput');
const sendBtn = document.querySelector('#sendBtn');
const chatMessages = document.querySelector('#chatMessages');
const chatContainer = document.querySelector('#chatContainer');
const newChatBtn = document.querySelector('#newChatBtn');
const safeRootEl = document.querySelector('#safeRoot');

let isProcessing = false;
let latestEmailDraft = null;
let pendingApproval = null;

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

newChatBtn.addEventListener('click', () => {
  latestEmailDraft = null;
  pendingApproval = null;
  // Clear backend conversation history
  if (window.agent?.clearHistory) window.agent.clearHistory().catch(() => {});
  chatMessages.innerHTML = `
    <div class="message-group agent-group">
      <div class="avatar">🤖</div>
      <div class="message-bubble agent-bubble">
        <p>Conversation cleared. How can I help you with your files or emails?</p>
      </div>
    </div>
  `;
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
      const results = await window.agent.execute(pending.plan, pending.capability);
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
    pendingApproval = null;
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
    pendingApproval = { plan, capability, group };
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
    <div class="card action-card">
      <div class="card-header">
        <span class="card-title">📋 Planned Actions</span>
        <span class="badge ${badgeClass}">${escapeHtml(badgeText)}</span>
      </div>
      <ul class="action-list">${actionsListHtml}</ul>
      ${!isReadOnly && permission.allowed ? `
        <div class="card-actions">
          <button class="btn btn-small btn-primary btn-execute-plan">Confirm & Execute</button>
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

    // Keep track of active email draft for seamless revisions from either input
    latestEmailDraft = {
      group,
      plan,
      capability,
      readComposerState
    };

    // Any manual edit invalidates the previously approved capability
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

        const typing = showTypingIndicator();
        try {
          if (!emailActionsEqual(liveAction, emailAction)) {
            const approved = await window.agent.approveDraft(liveAction);
            targetPlan = approved.plan;
            targetCapability = approved.capability;
          }

          latestEmailDraft = null;
          pendingApproval = null;
          const results = await window.agent.execute(targetPlan, targetCapability);
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
    if (executeBtn) {
      executeBtn.addEventListener('click', async () => {
        executeBtn.disabled = true;
        const typing = showTypingIndicator();
        try {
          const results = await window.agent.execute(plan, capability);
          typing.remove();
          renderExecutionResults(results, plan);
        } catch (err) {
          typing.remove();
          renderAgentTextResponse(`Action failed: ${err.message}`);
        }
      });
    }
  }
}

async function autoExecuteReadOnly(plan, group, capability) {
  try {
    const results = await window.agent.execute(plan, capability);
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

  // Natural language completion message based on action type
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
