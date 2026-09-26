require('dotenv').config();

const OLLAMA_URL = 'http://127.0.0.1:11434/api/chat';
const model = process.env.OLLAMA_MODEL || 'llama3.2:3b';

const systemPrompt = `You are a planning-only assistant for a privacy-first desktop agent. Return ONLY valid JSON matching this schema:
{"summary":"string","actions":[{"type":"create_folder|create_file|rename|move|delete|open|send_email","path":"relative Documents path","destination":"relative Documents path","content":"string","to":["email"],"subject":"string","body":"string","attachments":["relative Documents path"]}]}
Rules: propose no more than 5 actions. Paths must be relative to the user's Documents folder, never an absolute path. Do not invent files, recipients, or content. For send_email use to, subject, body and attachments. If no attachments are requested, attachments MUST be an empty array []. Do not output placeholders like "attachments" or "none". A request to send an attachment must include send_email. Do not execute anything.`;

function cleanJson(text) {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last < first) throw new Error('Planner did not return JSON');
  return JSON.parse(text.slice(first, last + 1));
}

// The planner is told to use paths relative to Documents, but users naturally
// say “in Documents”. Accept that harmless prefix without allowing absolute paths.
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
  if (/\bopen\s+(the\s+)?documents\b/.test(lower)) return { summary: 'Open Documents', actions: [{ type: 'open', path: '.' }] };
  if (/\bcreate\b.*\b(folder|directory)\b/.test(lower)) return { summary: 'Create folder', actions: [{ type: 'create_folder', path: item }] };
  if (/\bcreate\b.*\b(file|\.txt)\b/.test(lower)) return { summary: 'Create file', actions: [{ type: 'create_file', path: item, content: '' }] };
  if (/\bdelete\b|\bremove\b/.test(lower)) return { summary: 'Delete item', actions: [{ type: 'delete', path: item }] };
  if (/\bopen\b/.test(lower)) return { summary: 'Open item', actions: [{ type: 'open', path: item }] };
  return { summary: 'Could not safely infer an action', actions: [] };
}

async function buildPlan(request) {
  if (!request.trim()) return { summary: 'No request supplied', actions: [], planner: 'none' };
  try {
    const response = await fetch(OLLAMA_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false, format: 'json', messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: request }] })
    });
    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
    const data = await response.json();
    const plan = cleanJson(data.message?.content || '');
    if (!Array.isArray(plan.actions)) throw new Error('Plan has no action list');
    return { ...normalizePlanPaths({ summary: String(plan.summary || 'Proposed actions'), actions: plan.actions }), planner: `ollama:${model}` };
  } catch (error) {
    return { ...fallbackPlan(request), planner: `fallback (${error.message})` };
  }
}

module.exports = { buildPlan, normalizeDocumentsPath };
