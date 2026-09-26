require('dotenv').config();

const OLLAMA_URL = 'http://127.0.0.1:11434/api/chat';
const model = process.env.OLLAMA_MODEL || 'llama3.2:3b';

const plannerTypes = new Set(['list_directory', 'search_files', 'create_folder', 'create_file', 'rename', 'move', 'delete', 'open', 'send_email']);

const systemPrompt = `You are an AI assistant for a privacy-first desktop agent. Return ONLY valid JSON matching this schema:
{"summary":"string","actions":[{"type":"list_directory|search_files|create_folder|create_file|rename|move|delete|open|send_email","path":"relative Documents path","startsWith":"string","query":"string","destination":"relative Documents path","content":"string","to":["email"],"subject":"string","body":"string","attachments":["relative Documents path"]}]}

Rules:
1. Every action type must be ONE of: list_directory, search_files, create_folder, create_file, rename, move, delete, open, send_email.
2. For send_email:
   - Generate a complete, professional, well-written email in "body" with a proper greeting, clear message body, professional tone, and polite closing/sign-off. DO NOT simply repeat the user's sentence verbatim.
   - Provide an appropriate, concise "subject".
   - "to" MUST be an array of recipient emails. If no recipient was specified in the user request, use an empty array [].
   - "attachments" MUST be an array of relative paths under Documents. If none, use empty array [].
3. For file/folder listing or searching:
   - Use list_directory (path: ".") for displaying files/folders in Documents.
   - Use search_files (query: "search term") for recursive file searches.
4. All file paths MUST be relative to user's Documents folder.
5. Propose no more than 5 actions. Return JSON ONLY with no extra commentary or markdown.`;

function cleanJson(text) {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last < first) throw new Error('Planner did not return valid JSON');
  return JSON.parse(text.slice(first, last + 1));
}

function normalizeDocumentsPath(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (/^documents$/i.test(trimmed)) return '.';
  return trimmed.replace(/^documents[\\/]+/i, '');
}

function filterValidAttachments(attachments) {
  if (!attachments) return [];
  const list = Array.isArray(attachments) ? attachments : [attachments];
  const invalidPlaceholders = new Set(['none', 'attachments', 'relative documents path', 'null', 'undefined', '']);
  return list
    .map(normalizeDocumentsPath)
    .filter(item => typeof item === 'string' && item.trim() !== '' && !invalidPlaceholders.has(item.toLowerCase()));
}

function normalizePlanPaths(plan) {
  return {
    ...plan,
    actions: plan.actions.map((action) => ({
      ...action,
      path: action.path ? normalizeDocumentsPath(action.path) : action.path,
      destination: action.destination ? normalizeDocumentsPath(action.destination) : action.destination,
      attachments: filterValidAttachments(action.attachments)
    }))
  };
}

function fallbackPlan(request) {
  const text = request.trim();
  const quoted = /["']([^"']+)["']/.exec(text)?.[1];
  const pathMatch = /(Documents[\\/][^,]+|[\w .-]+\.(?:txt|pdf|docx|xlsx|png|jpg|jpeg))/i.exec(text);
  const item = quoted || pathMatch?.[1]?.replace(/^Documents[\\/]/i, '') || '';
  const lower = text.toLowerCase();
  
  const emailMatch = /\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/.exec(text);
  if (/\b(email|send email|mail)\b/.test(lower)) {
    const to = emailMatch ? [emailMatch[1]] : [];
    return {
      summary: 'Draft email',
      actions: [{
        type: 'send_email',
        to,
        subject: 'Message from Private OS Agent',
        body: `Hello,\n\n${text}\n\nBest regards,\nUser`,
        attachments: item ? [item] : []
      }]
    };
  }

  if (/\bopen\s+(the\s+)?documents\b/.test(lower)) return { summary: 'Open Documents', actions: [{ type: 'open', path: '.' }] };
  if (/\b(list|show|display)\b.*\b(files?|folders?|documents?)\b/.test(lower)) {
    const startsWith = /\bstart(?:ing)?\s+(?:with\s+)?["']?([a-z0-9])["']?/i.exec(text)?.[1];
    return { summary: 'List Documents folder', actions: [{ type: 'list_directory', path: '.', ...(startsWith ? { startsWith } : {}) }] };
  }
  if (/\b(search|find)\b/.test(lower)) {
    return { summary: 'Search files', actions: [{ type: 'search_files', path: '.', query: item || text.replace(/^(search|find)\s+/i, '') }] };
  }
  if (/\bcreate\b.*\b(folder|directory)\b/.test(lower)) return { summary: 'Create folder', actions: [{ type: 'create_folder', path: item }] };
  if (/\bcreate\b.*\b(file|\.txt)\b/.test(lower)) return { summary: 'Create file', actions: [{ type: 'create_file', path: item, content: '' }] };
  if (/\bdelete\b|\bremove\b/.test(lower)) return { summary: 'Delete item', actions: [{ type: 'delete', path: item }] };
  if (/\bopen\b/.test(lower)) return { summary: 'Open item', actions: [{ type: 'open', path: item }] };
  return { summary: 'Could not safely infer an action', actions: [] };
}

async function buildPlan(request) {
  if (!request.trim()) return { summary: 'No request supplied', actions: [], planner: 'none' };
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(OLLAMA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          format: 'json',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: request }
          ]
        })
      });
      if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
      const data = await response.json();
      const plan = cleanJson(data.message?.content || '');
      if (!Array.isArray(plan.actions)) throw new Error('Plan has no action list');
      if (plan.actions.some((action) => !plannerTypes.has(action.type))) throw new Error('Planner proposed an unsupported action type');
      return { ...normalizePlanPaths({ summary: String(plan.summary || 'Proposed actions'), actions: plan.actions }), planner: `ollama:${model}` };
    } catch (error) {
      lastError = error;
    }
  }
  return { ...fallbackPlan(request), planner: `fallback (${lastError?.message || 'planner failed'})` };
}

async function buildEmailRevision(currentDraft, revisionInstruction) {
  const revisionPrompt = `You are revising an existing email draft based on user feedback.
Current Draft:
- To: ${JSON.stringify(currentDraft.to || [])}
- Subject: ${JSON.stringify(currentDraft.subject || '')}
- Body: ${JSON.stringify(currentDraft.body || '')}
- Attachments: ${JSON.stringify(currentDraft.attachments || [])}

User Revision Instruction:
"${revisionInstruction}"

Return ONLY valid JSON matching this schema:
{"to":["email"],"subject":"string","body":"string","attachments":["relative Documents path"]}

Rules:
1. Preserve "to" and "attachments" UNLESS the user explicitly asks to change recipients or attachments.
2. Rewrite the "body" and/or "subject" completely according to the user's requested tone, length, formatting, or missing detail.
3. Make the body sound natural, professional, and well-written.`;

  try {
    const response = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        messages: [{ role: 'user', content: revisionPrompt }]
      })
    });
    if (!response.ok) throw new Error(`Ollama returned status ${response.status}`);
    const data = await response.json();
    const revised = cleanJson(data.message?.content || '');
    return {
      type: 'send_email',
      to: Array.isArray(revised.to) ? revised.to : (currentDraft.to || []),
      subject: revised.subject || currentDraft.subject || 'Email Subject',
      body: revised.body || currentDraft.body || '',
      attachments: filterValidAttachments(revised.attachments || currentDraft.attachments || [])
    };
  } catch (error) {
    // Fallback: simple text modification if Ollama fails during revision
    return {
      type: 'send_email',
      to: currentDraft.to || [],
      subject: currentDraft.subject || 'Email Subject',
      body: `${currentDraft.body}\n\n[Note: Revised according to: "${revisionInstruction}"]`,
      attachments: filterValidAttachments(currentDraft.attachments || [])
    };
  }
}

module.exports = { buildPlan, buildEmailRevision, normalizeDocumentsPath };

