const promptInput = document.querySelector('#promptInput');
const sendBtn = document.querySelector('#sendBtn');
const chatMessages = document.querySelector('#chatMessages');
const chatContainer = document.querySelector('#chatContainer');
const newChatBtn = document.querySelector('#newChatBtn');
const safeRootEl = document.querySelector('#safeRoot');

let isProcessing = false;

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

function describeAction(action) {
  const label = (val) => val === '.' ? 'Documents' : val;
  switch (action.type) {
    case 'create_folder': return `📁 Create folder: “${label(action.path)}”`;
    case 'create_file': return `📄 Create file: “${label(action.path)}”`;
    case 'rename': return `✏️ Rename: “${label(action.path)}” ➔ “${label(action.destination)}”`;
    case 'move': return `📦 Move: “${label(action.path)}” ➔ “${label(action.destination)}”`;
    case 'delete': return `🗑️ Move to Recycle Bin: “${label(action.path)}”`;
    case 'open': return `📂 Open: “${label(action.path)}”`;
    case 'list_directory': return `📋 List directory: “${label(action.path || '.')}${action.startsWith ? ` (starting with '${action.startsWith}')` : ''}”`;
    case 'search_files': return `🔍 Search files: “${action.query || ''}” in Documents`;
    case 'send_email': return `✉️ Send email to ${action.to?.join(', ') || 'recipient'} — ${action.subject || 'No Subject'}`;
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
    renderAgentTextResponse(`⚠️ Could not create a plan: ${err.message}`);
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
  const { plan, permission } = data;
  const group = document.createElement('div');
  group.className = 'message-group agent-group';

  const isEmail = plan.actions.some((a) => a.type === 'send_email');
  const isReadOnly = plan.actions.length > 0 && plan.actions.every((a) => ['list_directory', 'search_files'].includes(a.type));

  let cardHtml = '';

  if (isEmail) {
    const emailAction = plan.actions.find((a) => a.type === 'send_email');
    cardHtml = renderEmailDraftCard(emailAction, permission, plan);
  } else {
    cardHtml = renderActionPlanCard(plan, permission, isReadOnly);
  }

  group.innerHTML = `
    <div class="avatar">🤖</div>
    <div class="message-bubble agent-bubble">
      <p><strong>${escapeHtml(plan.summary || 'Proposed Actions')}</strong></p>
      ${cardHtml}
    </div>
  `;

  chatMessages.appendChild(group);
  scrollToBottom();

  attachCardEventListeners(group, plan, isEmail);

  // If read-only operation (e.g. list directory or search), auto-execute for immediate user delight
  if (isReadOnly && permission.allowed) {
    autoExecuteReadOnly(plan, group);
  }
}

function renderEmailDraftCard(emailAction, permission, plan) {
  const toList = (emailAction.to || []).join(', ') || '<em>No recipient specified</em>';
  const attachmentsList = (emailAction.attachments || []).length
    ? (emailAction.attachments || []).map((att) => `<code>📎 ${escapeHtml(att)}</code>`).join(' ')
    : 'None';

  const badgeClass = permission.allowed ? 'badge-allowed' : 'badge-blocked';
  const badgeText = permission.allowed ? 'Permission Approved' : `Blocked: ${permission.reasons.join('; ')}`;

  return `
    <div class="card email-card">
      <div class="card-header">
        <span class="card-title">✉️ Email Draft</span>
        <span class="badge ${badgeClass}">${escapeHtml(badgeText)}</span>
      </div>
      <div class="email-field"><strong>To:</strong> ${toList}</div>
      <div class="email-field"><strong>Subject:</strong> ${escapeHtml(emailAction.subject || '')}</div>
      <div class="email-body-box">${escapeHtml(emailAction.body || '')}</div>
      <div class="email-field"><strong>Attachments:</strong> ${attachmentsList}</div>

      ${permission.allowed ? `
        <div class="revision-box">
          <input type="text" class="revision-input" placeholder="Want changes? e.g. Make it more formal, mention returning tomorrow..." />
          <button class="btn btn-small btn-outline btn-revise">Revise</button>
        </div>
        <div class="card-actions">
          <button class="btn btn-small btn-danger btn-send-email">Confirm & Send Email</button>
          <button class="btn btn-small btn-outline btn-copy">Copy Body</button>
        </div>
      ` : `
        <div class="card-actions">
          <p style="color:var(--accent-red); font-size:12px; margin:4px 0 0 0;">Cannot execute: ${permission.reasons.map(escapeHtml).join(' ')}</p>
        </div>
      `}
    </div>
  `;
}

function renderActionPlanCard(plan, permission, isReadOnly) {
  const badgeClass = permission.allowed ? 'badge-allowed' : 'badge-blocked';
  const badgeText = permission.allowed ? 'Permission Approved' : `Blocked: ${permission.reasons.join('; ')}`;

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

function attachCardEventListeners(group, plan, isEmail) {
  if (isEmail) {
    const emailAction = plan.actions.find((a) => a.type === 'send_email');
    const reviseBtn = group.querySelector('.btn-revise');
    const revisionInput = group.querySelector('.revision-input');
    const sendBtnEl = group.querySelector('.btn-send-email');
    const copyBtn = group.querySelector('.btn-copy');

    if (reviseBtn && revisionInput) {
      const handleRevision = async () => {
        const instruction = revisionInput.value.trim();
        if (!instruction) return;
        revisionInput.value = '';

        appendUserMessage(instruction);
        const typing = showTypingIndicator();

        try {
          const revisedData = await window.agent.reviseEmail(emailAction, instruction);
          typing.remove();
          renderAgentPlanResponse(revisedData, instruction);
        } catch (err) {
          typing.remove();
          renderAgentTextResponse(`⚠️ Could not revise draft: ${err.message}`);
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
        const typing = showTypingIndicator();
        try {
          const results = await window.agent.execute(plan);
          typing.remove();
          renderExecutionResults(results);
        } catch (err) {
          typing.remove();
          renderAgentTextResponse(`❌ Email dispatch failed: ${err.message}`);
        }
      });
    }

    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(emailAction.body || '');
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
          const results = await window.agent.execute(plan);
          typing.remove();
          renderExecutionResults(results);
        } catch (err) {
          typing.remove();
          renderAgentTextResponse(`❌ Execution failed: ${err.message}`);
        }
      });
    }
  }
}

async function autoExecuteReadOnly(plan, group) {
  try {
    const results = await window.agent.execute(plan);
    renderExecutionResults(results);
  } catch (err) {
    renderAgentTextResponse(`❌ Action failed: ${err.message}`);
  }
}

function renderExecutionResults(results) {
  const group = document.createElement('div');
  group.className = 'message-group agent-group';

  const resultItems = (results || [])
    .map((res) => `<li>${escapeHtml(res)}</li>`)
    .join('');

  group.innerHTML = `
    <div class="avatar">🤖</div>
    <div class="message-bubble agent-bubble">
      <p style="color:var(--accent-green); font-weight:600;">✅ Execution Completed</p>
      <ul class="action-list">${resultItems}</ul>
    </div>
  `;

  chatMessages.appendChild(group);
  scrollToBottom();
}

