require('dotenv').config();
const path = require('path');
const fs = require('fs/promises');

const OLLAMA_URL = 'http://127.0.0.1:11434/api/chat';
const model = process.env.OLLAMA_MODEL || 'llama3.2:3b';

const plannerTypes = new Set(['list_directory', 'search_files', 'show_task_history', 'create_folder', 'create_file', 'rename', 'move', 'delete', 'open', 'send_email']);

// ---------------------------------------------------------------------------
//  Conversation History  (kept in-memory, shared across calls)
// ---------------------------------------------------------------------------
const MAX_HISTORY = 12;            // keep last N user+assistant turns
const conversationHistory = [];    // { role: 'user'|'assistant', content: string, timestamp: number }
const conversationContext = {      // lightweight state the renderer/main can also read
  lastResults: null,               // results of last executed action
  lastPlan: null,                  // last proposed plan
  lastIntent: null,                // last classified intent
  pendingAction: null,             // action awaiting confirmation
};

function pushHistory(role, content) {
  conversationHistory.push({ role, content: String(content || '').slice(0, 800), timestamp: Date.now() });
  if (conversationHistory.length > MAX_HISTORY * 2) conversationHistory.splice(0, conversationHistory.length - MAX_HISTORY * 2);
}

function getRecentHistory(maxTurns = 8) {
  return conversationHistory.slice(-maxTurns * 2);
}

function clearHistory() {
  conversationHistory.length = 0;
  conversationContext.lastResults = null;
  conversationContext.lastPlan = null;
  conversationContext.lastIntent = null;
  conversationContext.pendingAction = null;
}

// ---------------------------------------------------------------------------
//  Intent Classification
// ---------------------------------------------------------------------------
const INTENTS = {
  GREETING:        'greeting',
  GOODBYE:         'goodbye',
  THANKS:          'thanks',
  CAPABILITIES:    'capabilities',
  PERSONAL:        'personal',
  CASUAL:          'casual',
  LISTENING:       'listening',
  FILE_LIST:       'file_list',
  FILE_SEARCH:     'file_search',
  FILE_OPEN:       'file_open',
  FILE_CREATE:     'file_create',
  FILE_ORGANIZE:   'file_organize',
  FILE_DELETE:     'file_delete',
  EMAIL:           'email',
  TASK_HISTORY:    'task_history',
  CONFIRMATION:    'confirmation',
  CANCELLATION:    'cancellation',
  FOLLOW_UP:       'follow_up',
  CLARIFICATION:   'clarification',
  UNSUPPORTED:     'unsupported',
};

function isEmailCapabilityRequest(norm) {
  if (/@/.test(norm)) return false;
  return /^(can|could|are)\s+(you|yu|u)\s+(?:able\s+to\s+)?(?:mail|email|send\s+(?:an?\s+)?emails?)\b/i.test(norm)
    || /\b(can\s+(?:you|yu|u)\s+(?:able\s+to\s+)?(?:mail|email|send\s+email))\b/i.test(norm);
}

function classifyIntent(request) {
  let clean = String(request || '').trim();
  if (!clean) return INTENTS.CASUAL;

  // Strip leading negation or conversational prefix like "no list documents", "wait, show files"
  const noPrefixMatch = /^(?:no|nah|nope|wait|stop)[,\s]+(.+)$/i.exec(clean);
  if (noPrefixMatch) {
    clean = noPrefixMatch[1].trim();
  }

  const norm = clean.toLowerCase().replace(/\s+/g, ' ').replace(/[!?.]+$/, '').trim();

  // --- Confirmation / Cancellation (short responses) ---
  if (/^(yes|yeah|yep|yup|sure|ok|okay|go ahead|confirm|confirmed|do it|send|send it|proceed|approve|execute)$/i.test(norm)) return INTENTS.CONFIRMATION;
  if (/^(no|nope|cancel|stop|not now|never mind|forget it|don'?t|dont|nah|skip)$/i.test(norm)) return INTENTS.CANCELLATION;

  // --- Greetings ---
  if (/^(hi+|hello+|hey+|he+y+|hel+|hai+|hola|yo|sup|greetings|good\s+(morning|afternoon|evening|day|night))(\s+there)?[.!,' ]*$/i.test(clean)) return INTENTS.GREETING;

  // --- Goodbye ---
  if (/^(bye|goodbye|see you|see ya|later|good\s*bye|take care|cya|ttyl|goodnight|good\s+night)[.!,' ]*$/i.test(clean)) return INTENTS.GOODBYE;

  // --- Thanks ---
  if (/^(thanks|thank you|thx|ty|thankyou|thank u|appreciated|much appreciated)[.!,' ]*$/i.test(clean)) return INTENTS.THANKS;

  // --- Listening / Presence ---
  if (/\b(are you (there|listening|alive|awake|still there|ready|on)|you there|hello\??|anyone there)\b/i.test(norm)) return INTENTS.LISTENING;

  // --- Personal questions (meals, feelings, body, identity, etc.) ---
  if (/\b(have you (eaten|had|slept)|do you (eat|sleep|feel|have|drink|breathe)|are you (hungry|tired|happy|sad|bored|human|alive|real)|how are you|how do you feel|what('s| is) your (name|age|favorite)|who\s+am\s+i|who\s+is\s+the\s+user|what('s|\s+is)\s+my\s+name|do\s+you\s+know\s+me)\b/i.test(norm)) return INTENTS.PERSONAL;

  // --- Capabilities / Help ---
  if (isCapabilityRequest(clean)) return INTENTS.CAPABILITIES;

  // --- Task History ---
  if (isTaskHistoryRequest(clean)) return INTENTS.TASK_HISTORY;

  // --- Email ---
  if (!isEmailCapabilityRequest(norm) && (/\b(email|send\s+email|mail|send\s+mail|draft\s+email|compose|write\s+(?:an?\s+)?(?:email|mail|letter))\b/i.test(norm) || /@/.test(norm))) return INTENTS.EMAIL;

  // --- File Delete ---
  if (/\b(delete|remove|trash|erase)\b/i.test(norm) && !/\b(delete|remove)\s+(what|the\s+email)\b/i.test(norm)) return INTENTS.FILE_DELETE;

  // --- File Create ---
  if (/\b(create|make|new)\b.*\b(folder|file|directory|document)\b/i.test(norm)) return INTENTS.FILE_CREATE;

  // --- File Organize (rename, move) ---
  if (/\b(rename|move|reorganize|rearrange|copy)\b/i.test(norm)) return INTENTS.FILE_ORGANIZE;

  // --- File Open (opens folder or file in OS, does not list in chat) ---
  if (/^open\b/i.test(norm) || (/\bopen\b/i.test(norm) && !/\b(list|show)\b/i.test(norm))) return INTENTS.FILE_OPEN;

  // --- File List (lists files and folders in chat) ---
  if (/^(?:list|show|display|view|explore)\b/i.test(norm)) return INTENTS.FILE_LIST;
  if (/\b(list|show|display|view|explore|what('s| is) (in|inside)|contents?\s+of)\b/i.test(norm) &&
      /\b(files?|folders?|documents?|directory|items?|stuff)\b/i.test(norm)) return INTENTS.FILE_LIST;
  if (/\b(list|show|display)\s+(files?|folders?|everything|all|items?)\b/i.test(norm)) return INTENTS.FILE_LIST;
  if (/\bfolders?\s+(alone|only)\b/i.test(norm) || /\bfiles?\s+(alone|only)\b/i.test(norm)) return INTENTS.FILE_LIST;

  // --- File Search ---
  if (/\b(search|find|look\s+for|locate|where\s+is|which\s+one)\b/i.test(norm)) return INTENTS.FILE_SEARCH;

  // --- Follow-up (short contextual references) ---
  if (conversationContext.lastResults && norm.split(/\s+/).length <= 8) {
    if (/\b(which|that|the|this|it|one|first|second|last|resume|pdf|file|folder)\b/i.test(norm)) return INTENTS.FOLLOW_UP;
  }

  // --- Unsupported topics ---
  if (/\b(weather|joke|recipe|movie|song|politics|stock\s+price|medical\s+advice|write\s+code|browse\s+the\s+internet|play\s+music|tell\s+me\s+a\s+story)\b/i.test(norm)) return INTENTS.UNSUPPORTED;

  // --- Catch-all: if it references file-like things, treat as search ---
  if (/\b(pdf|docx?|xlsx?|txt|pptx?|csv|jpg|jpeg|png|resume|report|invoice|certificate|letter|note)\b/i.test(norm)) return INTENTS.FILE_SEARCH;

  // --- Anything short and conversational ---
  if (norm.split(/\s+/).length <= 5 && !/\b(list|show|create|delete|rename|move|open|search|find|email|send|attach)\b/i.test(norm)) return INTENTS.CASUAL;

  return INTENTS.CASUAL;
}

// ---------------------------------------------------------------------------
//  Capability Check (deterministic, fast)
// ---------------------------------------------------------------------------
function isCapabilityRequest(request) {
  const norm = String(request || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (/@/.test(norm)) return false;
  if (/^delete\s+what\s+can\s+you\s+do\.txt$/i.test(norm)) return false;
  if (/\b(delete|remove)\s+["']?[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+/i.test(norm)) return false;
  if (/\b(create|make)\s+(?:folder|file|directory)\s+["']?[a-zA-Z0-9_-]+/i.test(norm)) return false;
  if (/\b(rename|move)\s+["']?[a-zA-Z0-9_-]+/i.test(norm)) return false;

  if (isEmailCapabilityRequest(norm)) return true;

  return /\b(what\s+(?:can|could)\s+(?:you|yu|u)(\s+do)?|what\s+(?:do|can)\s+(?:you|yu|u)\s+(?:actually\s+)?do|what\s+(?:you|yu|u)\s+can(\s+do)?|what\s+are\s+(?:you|yu|u)\s+able\s+to\s+do|what\s+are\s+(?:your|ur)\s+(?:capabilities|features|functions|commands)|what\s+are\s+(?:the\s+)?(?:capabilities|features|commands)|tell\s+me\s+what\s+(?:you|yu|u)\s+can(\s+do)?|tell\s+me\s+(?:your|ur)\s+(?:features|capabilities)|show\s+(?:me\s+)?(?:your|ur\s+)?(?:features|capabilities|commands)|help\s*me|how\s+does\s+this\s+work|how\s+do\s+i\s+use\s+(?:this|you)|who\s+are\s+you|what\s+is\s+this)\b/i.test(norm)
    || /^(features|capabilities|help|commands|\?)$/i.test(norm);
}

// ---------------------------------------------------------------------------
//  Conversation-Mode Responses (deterministic fallbacks + LLM-enhanced)
// ---------------------------------------------------------------------------

// Pools of varied replies to prevent repetition
const greetingReplies = [
  'Hello! What would you like help with today?',
  'Hi! I\'m here and ready. What can I do for you?',
  'Hey there! Need help with your files or an email?',
  'Hello! Tell me what you need and I\'ll get right on it.',
  'Hi! How can I help you today?',
];

const goodbyeReplies = [
  'Goodbye! I\'ll be here whenever you need me.',
  'See you later! Just press Alt+Space when you need me.',
  'Take care! I\'m always a keystroke away.',
  'Bye for now!',
];

const thanksReplies = [
  'You\'re welcome!',
  'Happy to help!',
  'Glad I could help!',
  'Anytime!',
  'No problem at all!',
];

const listeningReplies = [
  'Yes, I\'m listening. What do you need?',
  'I\'m here! Tell me what you\'d like to do.',
  'Right here. What can I help you with?',
  'I\'m ready and listening. Go ahead!',
];

const CAPABILITY_GUIDE = `Here is what I can do for you:

📁 File Operations (Inside Documents)
• List files & folders: "list folders" or "show items in Documents"
• Search files: "find my resume" or "search for pdf files"
• Create items: "create folder Work" or "create file notes.txt"
• Organize: "move notes.txt to Work", "rename old.txt to new.txt", or "delete temp.txt"

✉️ Email Assistant
• Draft & send emails: "send email to friend@gmail.com with subject Project Update"
• Attach files: "email bob@gmail.com and attach SREERISHI_RESUME.pdf"
• Interactive revisions: "make it more formal", "shorten it", or "add a polite closing"

🧾 Task History
• View recent actions: "show task history" or "view audit logs"

🛡️ Safety First
• All actions are restricted to your Documents folder.
• Important file changes and emails always ask for your review and confirmation before running.`;

const capabilitySummary = CAPABILITY_GUIDE;

function pickRandom(pool) {
  return pool[Math.floor(Math.random() * pool.length)];
}

function buildPersonalReply(text) {
  const lower = text.toLowerCase();
  if (/who\s+am\s+i|who\s+is\s+the\s+user|what('s|\s+is)\s+my\s+name|do\s+you\s+know\s+me/i.test(lower)) {
    return "You're the user of this system. I don't track your personal identity or private data, but I'm here to help manage your Documents folder and draft emails whenever you need!";
  }
  if (/eaten|had breakfast|had lunch|had dinner|had food/i.test(lower)) {
    return "I don't eat, but I'm always ready to help! How about you — need anything done?";
  }
  if (/how are you|how do you feel/i.test(lower)) {
    return "I don't have feelings, but I'm functioning well and ready to help you!";
  }
  if (/do you sleep|are you tired/i.test(lower)) {
    return "No sleep needed here — I'm available around the clock. What can I do for you?";
  }
  if (/are you (human|real|alive)/i.test(lower)) {
    return "I'm a local AI assistant running on your computer. I'm here to help manage your files and emails.";
  }
  if (/what('s| is) your name/i.test(lower)) {
    return "I'm Private OS Agent — your local file and email assistant.";
  }
  return "That's a bit outside my area, but I'm great at managing your Documents files and drafting emails. What do you need?";
}

function buildUnsupportedReply() {
  return "I'm focused on managing files in your Documents folder and helping with emails. I can't help with that particular topic, but feel free to ask me about files, folders, or email tasks!";
}

// ---------------------------------------------------------------------------
//  LLM-Enhanced Conversation Reply (with history context)
// ---------------------------------------------------------------------------
async function buildConversationReply(request, intent) {
  const conversationPrompt = `You are a friendly, concise desktop assistant called "Private OS Agent". You help with file operations inside the user's Documents folder and email drafting/sending.

RULES:
- Reply in 1-2 short sentences. Be warm but concise.
- NEVER introduce yourself repeatedly. NEVER dump your full capability list unless explicitly asked "what can you do".
- NEVER claim to have eaten, slept, or had personal experiences. You are an AI.
- NEVER claim you performed an action. You only plan actions; the system executes them.
- NEVER use markdown headings or bullet points for simple replies.
- For greetings, just greet back briefly and ask what they need.
- For "thank you", just say "you're welcome" or similar.
- For personal questions (meals, feelings), briefly acknowledge you're an AI and redirect.
- For unsupported topics, briefly explain your scope and suggest what you CAN do.
- Vary your wording naturally. Do not repeat the same phrase.

Return ONLY valid JSON: {"reply":"string"}`;

  try {
    const messages = [{ role: 'system', content: conversationPrompt }];
    const recent = getRecentHistory(4);
    for (const turn of recent) {
      messages.push({ role: turn.role, content: turn.content });
    }
    messages.push({ role: 'user', content: String(request || '').trim() });

    const response = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false, format: 'json', options: { temperature: 0.7 }, messages })
    });
    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
    const data = await response.json();
    const result = cleanJson(data.message?.content || '');
    if (!String(result.reply || '').trim()) throw new Error('Empty reply');
    return String(result.reply).trim();
  } catch (_) {
    // Deterministic fallbacks when Ollama is unavailable
    switch (intent) {
      case INTENTS.GREETING:    return pickRandom(greetingReplies);
      case INTENTS.GOODBYE:     return pickRandom(goodbyeReplies);
      case INTENTS.THANKS:      return pickRandom(thanksReplies);
      case INTENTS.LISTENING:   return pickRandom(listeningReplies);
      case INTENTS.PERSONAL:    return buildPersonalReply(request);
      case INTENTS.CAPABILITIES: return capabilitySummary;
      case INTENTS.UNSUPPORTED: return buildUnsupportedReply();
      default: return "I'm here to help with your Documents files and email tasks. What would you like to do?";
    }
  }
}

// ---------------------------------------------------------------------------
//  Ollama Availability Check
// ---------------------------------------------------------------------------
async function isOllamaAvailable() {
  try {
    const response = await fetch(OLLAMA_URL.replace('/api/chat', '/api/tags'), { method: 'GET', signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
//  JSON helpers
// ---------------------------------------------------------------------------
function cleanJson(text) {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last < first) throw new Error('Planner did not return valid JSON');
  return JSON.parse(text.slice(first, last + 1));
}

// ---------------------------------------------------------------------------
//  Email Normalization (unchanged from original)
// ---------------------------------------------------------------------------
function parseEmailParts(raw) {
  let text = String(raw || '').trim();

  text = text.replace(/\\+r\\+n/g, '\n').replace(/\\+n/g, '\n').replace(/\\+r/g, '\n').replace(/\\+t/g, ' ');
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  text = text.replace(/\b(dear)\s+(dear)\b/gi, '$1')
             .replace(/\b(sincerely)\s+(sincerely)\b/gi, '$1')
             .replace(/\b(best\s+regards)\s+(best\s+regards)\b/gi, '$1')
             .replace(/\b(thank\s+you)\s+(thank\s+you)\b/gi, '$1')
             .replace(/\b(dear\s+sir\s*\/\s*madam,?\s*)+(dear\s+sir\s*\/\s*madam,?)/i, '$2')
             .replace(/\b(dear\s+sir\s*,?\s*)+(dear\s+sir,?)/i, '$2');

  text = text.replace(/^((?:dear|hi|hello|respected|good\s+(?:morning|afternoon|day)|to\s+whom\s+it\s+may\s+concern)[^,\n.!?]*[,!]?)\s+(?=[A-Z])/i, '$1\n\n');

  text = text.replace(/([.!?])\s*(sincerely|best\s+regards|warm\s+regards|kind\s+regards|regards|yours\s+sincerely|yours\s+faithfully|thank\s+you),?\s*([A-Za-z0-9 _.-]+)$/i, '$1\n\n$2,\n$3');

  const lines = text.split('\n').map(l => l.trim());

  const isGreetingLine = (line) => {
    if (!line || line.length > 60) return false;
    return /^(dear\s+[^,\n.!?]+|hi\s+[^,\n.!?]+|hello\s+[^,\n.!?]+|respected\s+[^,\n.!?]+|good\s+(morning|afternoon|day)|to\s+whom\s+it\s+may\s+concern)[,!]?$/i.test(line);
  };

  const isSignoffLine = (line) => {
    if (!line || line.length > 50) return false;
    return /^(sincerely|best\s+regards|warm\s+regards|kind\s+regards|regards|yours\s+sincerely|yours\s+faithfully|with\s+thanks|thank\s+you)[,!]?$/i.test(line);
  };

  const greetings = [];
  let startIdx = 0;
  while (startIdx < lines.length) {
    const l = lines[startIdx];
    if (!l) { startIdx++; continue; }
    if (isGreetingLine(l)) { greetings.push(l); startIdx++; } else break;
  }

  let greeting = '';
  if (greetings.length > 0) {
    const specific = greetings.find(g => !/sir\s*\/\s*madam/i.test(g));
    greeting = specific || greetings[greetings.length - 1];
    if (!/[,!]$/.test(greeting)) greeting += ',';
  }

  const remainingLines = lines.slice(startIdx);
  let signoffIdx = -1;
  for (let j = remainingLines.length - 1; j >= 0; j--) {
    if (isSignoffLine(remainingLines[j])) { signoffIdx = j; break; }
  }

  let bodyLines = [];
  let signoff = '';
  let senderName = '';

  if (signoffIdx !== -1) {
    bodyLines = remainingLines.slice(0, signoffIdx);
    signoff = remainingLines[signoffIdx];
    if (!/[,!]$/.test(signoff)) signoff += ',';
    const afterSignoff = remainingLines.slice(signoffIdx + 1).filter(Boolean);
    senderName = afterSignoff.join('\n') || '';
  } else {
    bodyLines = remainingLines;
  }

  bodyLines = bodyLines.filter(line => !isGreetingLine(line) && !isSignoffLine(line));

  const paragraphs = [];
  let currentPara = [];
  for (const bLine of bodyLines) {
    if (!bLine) {
      if (currentPara.length > 0) { paragraphs.push(currentPara.join(' ')); currentPara = []; }
    } else { currentPara.push(bLine); }
  }
  if (currentPara.length > 0) paragraphs.push(currentPara.join(' '));

  return { greeting, paragraphs, signoff, senderName };
}

function assembleEmail({ greeting, paragraphs, signoff, senderName }) {
  const parts = [];
  if (greeting) parts.push(greeting);
  if (paragraphs && paragraphs.length > 0) parts.push(paragraphs.join('\n\n'));
  if (signoff) {
    const closing = senderName ? `${signoff}\n${senderName}` : signoff;
    parts.push(closing);
  } else if (senderName) { parts.push(senderName); }
  return parts.join('\n\n').trim();
}

function normalizeEmailText(value) {
  const parsed = parseEmailParts(value);
  return assembleEmail(parsed);
}

function normalizeEmailAction(action) {
  return {
    ...action,
    to: Array.from(new Set((Array.isArray(action.to) ? action.to : []).map((address) => String(address).trim()).filter(Boolean))),
    subject: String(action.subject || '').replace(/\\+n/g, ' ').replace(/\s+/g, ' ').trim(),
    body: normalizeEmailText(action.body),
    attachments: filterValidAttachments(action.attachments || [])
  };
}

function applyLocalRevisionFallback(currentDraft, instruction) {
  const request = String(instruction || '').toLowerCase();
  const originalBody = normalizeEmailText(currentDraft.body || '');
  const parsed = parseEmailParts(currentDraft.body);

  if (!parsed.greeting) parsed.greeting = 'Dear Sir/Madam,';
  if (!parsed.signoff) parsed.signoff = 'Sincerely,';
  if (!parsed.senderName) parsed.senderName = 'User';

  if (/return|come back|back tomorrow/.test(request)) {
    const sentence = 'I expect to return tomorrow and will resume my responsibilities then.';
    if (!parsed.paragraphs.some(p => /return|come back|back tomorrow/i.test(p))) parsed.paragraphs.push(sentence);
  }
  if (/approval|approve|permission/.test(request)) {
    const sentence = 'I kindly request your approval for this leave.';
    if (!parsed.paragraphs.some(p => /approval|approve|permission/i.test(p))) parsed.paragraphs.push(sentence);
  }
  if (/formal|professional|official|tone/.test(request)) {
    if (/^(hi|hello)\b/i.test(parsed.greeting)) parsed.greeting = 'Dear Sir/Madam,';
    parsed.signoff = 'Sincerely,';
    if (!parsed.paragraphs.some(p => /respectfully|consideration/i.test(p))) {
      parsed.paragraphs.push('I respectfully request your consideration of this leave.');
    } else if (!parsed.paragraphs.some(p => /additional information|further information/i.test(p))) {
      parsed.paragraphs.push('Please let me know if any additional information is required.');
    }
  }

  let revised = normalizeEmailAction({ ...currentDraft, body: assembleEmail(parsed) });
  if (revised.body === originalBody) {
    parsed.paragraphs.push('Thank you for your consideration.');
    revised = normalizeEmailAction({ ...currentDraft, body: assembleEmail(parsed) });
  }
  return revised;
}

// ---------------------------------------------------------------------------
//  Path & Attachment helpers (unchanged)
// ---------------------------------------------------------------------------
function extractStartsWith(request) {
  if (!request || typeof request !== 'string') return null;
  const match = /(?:starts?|start(?:ing)?|begins?|begin(?:ning)?)\s+(?:with\s+)?(?:the\s+)?(?:letter\s+)?["']?([a-zA-Z0-9_-]+)["']?/i.exec(request);
  return match ? match[1] : null;
}

function extractTargetFolder(text) {
  if (!text || typeof text !== 'string') return null;
  const clean = text.trim();

  // Explicit documents root
  if (/^(?:open|show|list|display|view|explore)\s+(?:the\s+)?(?:my\s+)?documents?(?:\s+folder|\s+directory)?$/i.test(clean)) {
    return '.';
  }

  // Inside/in/within/of/from folder (e.g. "show files in 00AA", "list in 0 IT")
  const mIn = /(?:inside|in|within|of|from)\s+(?:the\s+)?(?:folder\s+|directory\s+)?["']?([a-zA-Z0-9_ -]+?)["']?(?:\s+(?:folder|directory|alone|only|named|called|name\s+as|name)|\s*$|[.?!])/i.exec(clean);
  if (mIn) {
    const folder = mIn[1].trim();
    if (!/^(documents?|my documents?|all|this|here|it|me|them|us)$/i.test(folder)) return folder;
  }

  // "folder/directory named/called/name [name]" (e.g. "show folder name 00AA", "open folder 0 IT")
  const mFolderNamed = /(?:folder|directory)\s+(?:named\s+|called\s+|name\s+as\s+|name\s+)?["']?([a-zA-Z0-9_ -]+?)["']?(?:\s+(?:folder|directory)|\s*$|[.?!])/i.exec(clean);
  if (mFolderNamed) {
    const f = mFolderNamed[1].trim();
    if (!/^(documents?|my documents?|all|this|here|it|the|name|folder|directory|alone|only)$/i.test(f)) return f;
  }

  // Direct: "show/list/open [name]"
  const mDirect = /(?:show|list|display|view|explore|open)\s+(?:the\s+)?(?:contents?\s+of\s+)?(?:folder\s+|directory\s+)?["']?([a-zA-Z0-9_ -]+?)["']?(?:\s+(?:folder|directory)|\s*$|[.?!])/i.exec(clean);
  if (mDirect) {
    const f = mDirect[1].trim();
    if (!/^(documents?|my documents?|all|this|here|it|the|files?|folders?|items?|everything|alone|only)$/i.test(f)) return f;
  }

  return null;
}

function extractEntryTypeFilter(text) {
  if (!text || typeof text !== 'string') return 'all';
  if (/\b(folders?\s+(alone|only)|only\s+folders?|just\s+folders?|all\s+the\s+folders\s+alone|directories\s+(alone|only)|only\s+directories)\b/i.test(text)) return 'folder';
  if (/\b(files?\s+(alone|only)|only\s+files?|just\s+files?|all\s+the\s+files\s+alone)\b/i.test(text)) return 'file';
  return 'all';
}

function extractNewItemName(text) {
  if (!text || typeof text !== 'string') return null;
  const clean = text.trim();
  const mQuoted = /["']([^"']+)["']/.exec(clean);
  if (mQuoted) return mQuoted[1].trim();
  const mName = /(?:name(?:d)?\s+as|named|called|name)\s+["']?([a-zA-Z0-9_ -]+?)["']?(?:\s+(?:inside|in|within)|\s*$|[.?!])/i.exec(clean);
  if (mName) { const n = mName[1].trim(); if (!/^(folder|file|directory|it|none)$/i.test(n)) return n; }
  const mFolderIn = /(?:folder|file)\s+["']?([a-zA-Z0-9_ -]+?)["']?\s+(?:inside|in|within)/i.exec(clean);
  if (mFolderIn) { const n = mFolderIn[1].trim(); if (!/^(called|named|name|inside|in|within|the)$/i.test(n)) return n; }
  const mEnd = /(?:create|make)\s+(?:a\s+)?(?:folder|file|directory)\s+["']?([a-zA-Z0-9_ -]+?)["']?\s*$/i.exec(clean);
  if (mEnd) { const n = mEnd[1].trim(); if (!/^(called|named|name|inside|in|within|the)$/i.test(n)) return n; }
  return null;
}

function extractMoveParameters(text) {
  if (!text || typeof text !== 'string') return null;
  const clean = text.trim();
  const m = /(?:move|relocate)\s+(?:the\s+)?(?:folders?\s+|files?\s+|directory\s+)?(?:named\s+|called\s+|name\s+as\s+|name\s+)?(?:["']([^"']+)["']|([a-zA-Z0-9_.-]+))\s+(?:to\s*documents[\\/]|to|into|in)\s*(?:the\s+)?(?:folder\s+|directory\s+)?(?:["']([^"']+)["']|([a-zA-Z0-9_./\\ -]+))/i.exec(clean);
  if (m) {
    const src = (m[1] || m[2] || '').trim();
    let dest = normalizeDocumentsPath((m[3] || m[4] || '').trim());
    if (src && dest && src.toLowerCase() !== dest.toLowerCase()) {
      return { src, dest };
    }
  }
  return null;
}

function extractRenameParameters(text) {
  if (!text || typeof text !== 'string') return null;
  const clean = text.trim();
  const m = /(?:rename)\s+(?:the\s+)?(?:folders?\s+|files?\s+|directory\s+)?(?:named\s+|called\s+|name\s+as\s+|name\s+)?(?:["']([^"']+)["']|([a-zA-Z0-9_.-]+))\s+(?:to|as)\s*(?:the\s+)?(?:folder\s+|file\s+|directory\s+)?(?:["']([^"']+)["']|([a-zA-Z0-9_.-]+))/i.exec(clean);
  if (m) {
    const src = (m[1] || m[2] || '').trim();
    let dest = normalizeDocumentsPath((m[3] || m[4] || '').trim());
    if (src && dest && src.toLowerCase() !== dest.toLowerCase()) {
      return { src, dest };
    }
  }
  return null;
}


function normalizeDocumentsPath(value) {
  if (value === null || value === undefined) return '.';
  let str = String(value).trim();
  str = str.replace(/^[.\\/]+/, '');
  str = str.replace(/^documents[\\/]+/i, '');
  if (!str || str === '.' || /^documents$/i.test(str)) return '.';
  return str.replace(/^documents[\\/]+/i, '').trim() || '.';
}

function filterValidAttachments(attachments) {
  if (!attachments) return [];
  const list = Array.isArray(attachments) ? attachments : [attachments];
  const invalidPlaceholders = new Set(['none', 'attachments', 'relative documents path', 'null', 'undefined', '.', 'documents', '']);
  return list
    .map(normalizeDocumentsPath)
    .filter(item => typeof item === 'string' && item.trim() !== '' && item.trim() !== '.' && !invalidPlaceholders.has(item.toLowerCase()));
}

async function collectFiles(root, current = root, result = []) {
  let entries;
  try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) await collectFiles(root, full, result);
    else result.push({ absolute: full, relative: path.relative(root, full) });
  }
  return result;
}

async function correctAttachmentTypos(plan, documentsRoot) {
  if (!documentsRoot) return plan;
  const files = await collectFiles(documentsRoot);
  const actions = await Promise.all(plan.actions.map(async (action) => {
    if (action.type !== 'send_email' || !Array.isArray(action.attachments)) return action;
    const attachments = action.attachments.map((attachment) => {
      const requested = path.parse(String(attachment));
      const exact = files.find((file) => file.relative.toLowerCase() === String(attachment).toLowerCase());
      if (exact) return attachment;
      const candidates = files.filter((file) => {
        const candidate = path.parse(file.relative);
        return candidate.name.toLowerCase() === requested.name.toLowerCase()
          && ['.pdf', '.doc', '.docx', '.txt', '.xlsx', '.png', '.jpg', '.jpeg'].includes(candidate.ext.toLowerCase());
      });
      return candidates.length === 1 ? candidates[0].relative : attachment;
    });
    return { ...action, attachments };
  }));
  return { ...plan, actions };
}

function validatePlanActions(actions) {
  if (!Array.isArray(actions)) throw new Error('Plan has no action list');
  for (const action of actions) {
    if (!plannerTypes.has(action.type)) throw new Error('Planner proposed an unsupported action type');
    if (action.type === 'send_email') {
      if (!Array.isArray(action.to) || action.to.length === 0) throw new Error('Planner returned an email without a recipient');
      if (!String(action.subject || '').trim() || !String(action.body || '').trim()) throw new Error('Planner returned an incomplete email draft');
    }
    if (['move', 'rename'].includes(action.type)) {
      if (!action.path || !String(action.path).trim() || action.path === 'undefined') {
        throw new Error(`Planner returned a ${action.type} action without a source path`);
      }
      if (!action.destination || !String(action.destination).trim() || action.destination === 'undefined') {
        throw new Error(`Planner returned a ${action.type} action without a destination`);
      }
    }
  }
}

function isTaskHistoryRequest(request = '') {
  if (!request || typeof request !== 'string') return false;
  const clean = request.trim().toLowerCase();
  if (/\b(file|files|folder|folders|directory|dir)\b/i.test(clean) && !/\b(task|audit|capability)\b/i.test(clean)) return false;
  if (/^\s*(task\s*history|history|audit\s*log|audit\s*trail|activity\s*log)\s*$/i.test(clean)) return true;
  if (/\b(show|display|list|view|get|see|check|fetch|read|open)\b/i.test(clean) && /\b(history|audit|logs?)\b/i.test(clean)) return true;
  if (/\b(task\s+history|audit\s+log|audit\s+trail|activity\s+log|task\s+logs?)\b/i.test(clean)) return true;
  return false;
}

// ---------------------------------------------------------------------------
//  Plan Path Normalization (unchanged from original)
// ---------------------------------------------------------------------------
function normalizePlanPaths(plan, request = '') {
  const inferredStartsWith = extractStartsWith(request);
  const { query: inferredQuery, ext: inferredExt } = extractSearchIntent(request);
  const inferredFolder = extractTargetFolder(request);
  const inferredEntryType = extractEntryTypeFilter(request);
  const inferredItemName = extractNewItemName(request);
  const wantsOpenExplicitly = /\bopen\b/i.test(request);
  const isHistoryReq = isTaskHistoryRequest(request);
  const wantsHistory = isHistoryReq || /\b(history|audit|log)\b/i.test(request);

  let actions = Array.isArray(plan.actions) ? plan.actions : [];
  if (!wantsHistory) {
    const withoutHistory = actions.filter((a) => a.type !== 'show_task_history');
    if (withoutHistory.length > 0) actions = withoutHistory;
  } else if (isHistoryReq) {
    if (actions.length === 0 || !actions.some((a) => a.type === 'show_task_history')) {
      actions = [{ type: 'show_task_history' }];
    }
    plan = { ...plan, summary: 'Recent task history' };
  }

  const hasListAction = actions.some((a) => a.type === 'list_directory' || a.type === 'search_files');
  if (hasListAction) {
    const withoutRedundantOpen = actions.filter((a) => !(a.type === 'open' && (a.path === '.' || !a.path || /^documents?$/i.test(a.path))));
    if (withoutRedundantOpen.length > 0) actions = withoutRedundantOpen;
  }

  return {
    ...plan,
    actions: actions.map((action) => {
      if (action.type === 'open' && !wantsOpenExplicitly) {
        const fileBase = path.basename(action.path || '').replace(/\.[^.]+$/, '');
        const fileExt = path.extname(action.path || '').replace(/^\./, '');
        return {
          type: 'search_files',
          path: inferredFolder || '.',
          query: inferredQuery || (fileBase && fileBase !== '.' ? fileBase : ''),
          ...(inferredExt || fileExt ? { ext: inferredExt || fileExt } : {}),
          attachments: []
        };
      }

      let rawPath = action.path;
      if (action.type === 'list_directory' && inferredFolder) {
        rawPath = inferredFolder;
      } else if (['create_folder', 'create_file', 'delete'].includes(action.type)) {
        const itemName = inferredItemName || path.basename(action.path || '');
        if (inferredFolder && itemName) {
          const posixPath = String(action.path || '').replace(/\\/g, '/');
          if (!posixPath.startsWith(inferredFolder + '/')) rawPath = path.posix.join(inferredFolder, itemName);
        } else if (itemName) { rawPath = action.path || itemName; }
      }
      let normPath = normalizeDocumentsPath(rawPath);
      let normDest = action.destination ? normalizeDocumentsPath(action.destination) : action.destination;
      if (['move', 'rename'].includes(action.type)) {
        if (!normDest || normDest === '.' || normDest === 'undefined') {
          const moveParams = extractMoveParameters(request);
          const renameParams = extractRenameParameters(request);
          if (action.type === 'move' && moveParams) {
            normDest = moveParams.dest;
            if (normPath === '.' || !normPath || normPath === 'undefined') normPath = moveParams.src;
          } else if (action.type === 'rename' && renameParams) {
            normDest = renameParams.dest;
            if (normPath === '.' || !normPath || normPath === 'undefined') normPath = renameParams.src;
          }
        }
      }

      let entryType = action.entryType || 'all';
      if (inferredEntryType !== 'all') { entryType = inferredEntryType; }
      else {
        if (entryType === 'folder' && !/\bfolders?\b/i.test(request)) entryType = 'all';
        if (entryType === 'file' && !/\bfiles?\b/i.test(request)) entryType = 'all';
      }

      let startsWith = action.startsWith ? String(action.startsWith).trim().replace(/^["']|["']$/g, '') : undefined;
      if (startsWith && /^(null|undefined|none|alone|only|just|folder|folders|file|files|all|directory|directories)$/i.test(startsWith)) startsWith = undefined;

      if (inferredStartsWith) {
        if (action.type === 'list_directory' || (action.type === 'search_files' && (!action.query || action.query.toLowerCase() === inferredStartsWith.toLowerCase()))) {
          return {
            type: 'list_directory', path: normPath || '.', ...(entryType && entryType !== 'all' ? { entryType } : {}), startsWith: inferredStartsWith, attachments: []
          };
        }
      }

      let ext = action.ext ? String(action.ext).trim().replace(/^\./, '').toLowerCase() : undefined;
      if (ext && /^(null|undefined|none)$/i.test(ext)) ext = undefined;
      if (!ext && action.type === 'search_files' && inferredExt) ext = inferredExt;

      let query = action.query;
      if (query && /^(null|undefined|none)$/i.test(String(query).trim())) query = undefined;
      if (action.type === 'search_files') {
        const q = String(query || '').trim();
        if (!q || q.split(/\s+/).length > 2 || /\b(document|documents|folder|folders|pdf|pdfs|file|files|all|list|show|find|in|of)\b/i.test(q)) {
          query = inferredQuery || q.split(/\s+/)[0] || '';
        }
      }

      return {
        ...action, path: normPath || '.', destination: normDest,
        ...(entryType && entryType !== 'all' ? { entryType } : {}),
        ...(startsWith && action.type === 'list_directory' ? { startsWith } : {}),
        ...(query !== undefined ? { query } : {}),
        ...(ext ? { ext } : {}),
        attachments: filterValidAttachments(action.attachments)
      };
    })
  };
}

function extractSearchIntent(text) {
  const extMatch = /\b(pdf|docx?|xlsx?|txt|pptx?|csv|jpg|jpeg|png|gif|mp4|mp3|zip|rar)s?\b/i.exec(text);
  const ext = extMatch ? extMatch[1].toLowerCase() : null;
  const stopWords = new Set([
    'a', 'an', 'the', 'in', 'on', 'at', 'to', 'of', 'for', 'my', 'me', 'is', 'are', 'was', 'be',
    'with', 'by', 'this', 'that', 'from', 'all', 'any', 'file', 'files', 'folder', 'folders',
    'document', 'documents', 'show', 'list', 'find', 'search', 'get', 'view', 'display', 'open',
    'mentioned', 'related', 'named', 'called', 'containing', 'inside', 'within', 'located',
    'pdf', 'pdfs', 'docx', 'doc', 'docs', 'xlsx', 'xls', 'txt', 'pptx', 'ppt', 'csv', 'jpg', 'jpeg', 'png',
    'and', 'or', 'please', 'can', 'you', 'what', 'where', 'which', 'there', 'item', 'items'
  ]);
  const quoted = /["']([^"']+)["']/.exec(text)?.[1];
  if (quoted) return { query: quoted.trim(), ext };
  const words = text.replace(/[^a-zA-Z0-9 _-]/g, ' ').split(/\s+/).filter(Boolean);
  const keywords = words.filter(w => !stopWords.has(w.toLowerCase()) && w.length > 1);
  const query = keywords.join(' ');
  return { query, ext };
}

// ---------------------------------------------------------------------------
//  Deterministic Fallback Plan (unchanged from original)
// ---------------------------------------------------------------------------
function fallbackPlan(request) {
  const text = request.trim();
  const quoted = /["']([^"']+)["']/.exec(text)?.[1];
  const pathMatch = /(Documents[\\/][^,]+|[\w .-]+\.(?:txt|pdf|docx|xlsx|png|jpg|jpeg))/i.exec(text);
  const item = quoted || pathMatch?.[1]?.replace(/^Documents[\\/]/i, '') || '';
  const attachmentMatch = /\battach(?:ing)?\s+(?:file\s+)?(?:named\s+)?([a-zA-Z0-9_-]+)\s*\.?\s*(pdf|pds|doc|docx|txt|xlsx|png|jpg|jpeg)\b/i.exec(text);
  const requestedAttachment = attachmentMatch ? `${attachmentMatch[1]}.${attachmentMatch[2]}` : (pathMatch?.[1] || '');
  const lower = text.toLowerCase();
  if (/\b(show|display|list|view)\b.*\b(recent\s+)?(task|capability|audit|execution)\s+(history|log)|\btask\s+history\b/.test(lower)) {
    return { summary: 'Recent task history', actions: [{ type: 'show_task_history' }] };
  }

  const emailMatch = /\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/.exec(text);
  if (/\b(email|send email|mail)\b/.test(lower)) {
    const to = emailMatch ? [emailMatch[1]] : [];
    const isLeave = /\b(leave|condolence|condolence ceremony|absent|day off)\b/.test(lower);
    return {
      summary: isLeave ? 'Draft leave email' : 'Draft email',
      actions: [{
        type: 'send_email', to,
        subject: isLeave ? 'Leave Request for Today' : 'Message from Private OS Agent',
        body: isLeave
          ? 'Dear Sir/Madam,\n\nI am writing to request leave for today due to a personal matter. I would be grateful if you could approve my leave request.\n\nThank you for your understanding.\n\nBest regards,\nUser'
          : `Hello,\n\n${text}\n\nBest regards,\nUser`,
        attachments: requestedAttachment ? [requestedAttachment] : (item ? [item] : [])
      }]
    };
  }

  const targetFolder = extractTargetFolder(text);
  const entryType = extractEntryTypeFilter(text);
  const startsWith = extractStartsWith(text);

  // --- Open Action (opens in OS, does not list in chat) ---
  if (/\bopen\b/i.test(lower)) {
    if (/^\s*open\s+(?:the\s+)?(?:my\s+)?documents?\s*$/i.test(text)) {
      return { summary: 'Open Documents', actions: [{ type: 'open', path: '.' }] };
    }
    const openTarget = targetFolder || item || extractNewItemName(text);
    if (openTarget) {
      return { summary: `Open "${openTarget}"`, actions: [{ type: 'open', path: openTarget }] };
    }
    return { summary: 'Open Documents', actions: [{ type: 'open', path: '.' }] };
  }

  if (/\b(create|make)\b.*\b(folder|directory)\b/i.test(text)) {
    const itemName = extractNewItemName(text) || item;
    const folderPath = targetFolder ? path.posix.join(targetFolder, itemName) : itemName;
    return { summary: `Create folder: ${folderPath}`, actions: [{ type: 'create_folder', path: folderPath }] };
  }
  if (/\b(create|make)\b.*\b(file|\.txt)\b/i.test(text)) {
    const itemName = extractNewItemName(text) || item;
    const filePath = targetFolder ? path.posix.join(targetFolder, itemName) : itemName;
    return { summary: `Create file: ${filePath}`, actions: [{ type: 'create_file', path: filePath, content: '' }] };
  }

  if (/\b(list|show|display|get|view|explore)\b/i.test(text) || startsWith || entryType !== 'all' || targetFolder) {
    const { query: searchQuery, ext } = extractSearchIntent(text);
    const hasSpecificTarget = searchQuery && searchQuery.length > 1 && !targetFolder && !/^(files?|folders?|all|alone|only)$/i.test(searchQuery);
    if (hasSpecificTarget || ext) {
      const action = { type: 'search_files', path: targetFolder || '.', query: searchQuery };
      if (ext) action.ext = ext;
      return { summary: `Search for ${searchQuery || ext} in Documents`, actions: [action] };
    }
    const folderPath = targetFolder || '.';
    const summary = targetFolder
      ? `List contents of folder: ${targetFolder}`
      : (entryType === 'folder' ? 'List folders in Documents' : entryType === 'file' ? 'List files in Documents' : 'List Documents folder');
    return { summary, actions: [{ type: 'list_directory', path: folderPath, ...(entryType !== 'all' ? { entryType } : {}), ...(startsWith ? { startsWith } : {}) }] };
  }
  if (/\b(search|find)\b/.test(lower)) {
    const { query: searchQuery, ext } = extractSearchIntent(text);
    const action = { type: 'search_files', path: '.', query: searchQuery || item };
    if (ext) action.ext = ext;
    return { summary: 'Search files', actions: [action] };
  }
  if (/\b(move|relocate)\b/i.test(lower)) {
    const moveParams = extractMoveParameters(text);
    if (moveParams) {
      return { summary: `Move "${moveParams.src}" to "${moveParams.dest}"`, actions: [{ type: 'move', path: moveParams.src, destination: moveParams.dest }] };
    }
  }
  if (/\brename\b/i.test(lower)) {
    const renameParams = extractRenameParameters(text);
    if (renameParams) {
      return { summary: `Rename "${renameParams.src}" to "${renameParams.dest}"`, actions: [{ type: 'rename', path: renameParams.src, destination: renameParams.dest }] };
    }
  }
  if (/\bdelete\b|\bremove\b/.test(lower)) {
    const deletePath = targetFolder ? path.posix.join(targetFolder, item) : item;
    return { summary: 'Delete item', actions: [{ type: 'delete', path: deletePath }] };
  }
  return { summary: 'Conversation', reply: "I'm here to help with your Documents files and email tasks. What would you like to do?", actions: [] };
}

// ---------------------------------------------------------------------------
//  Main System Prompt for Task Planning (with conversation history)
// ---------------------------------------------------------------------------
const systemPrompt = `You are the planner for a local desktop assistant. You help with SAFE file operations inside the user's Documents folder and email tasks.

CRITICAL RULES:
- For greetings, thanks, personal questions, or simple conversation: return actions: [] and a brief, natural reply.
- NEVER create an action for casual messages like "hi", "how are you", "thanks", etc.
- NEVER introduce yourself repeatedly or dump your capability list unless asked.
- NEVER claim you performed an action. You propose; the system executes.
- Return ONLY valid JSON matching this schema:
{"summary":"string","reply":"optional conversational reply","actions":[{"type":"show_task_history|list_directory|search_files|create_folder|create_file|rename|move|delete|open|send_email","path":"relative Documents path","entryType":"all|folder|file","startsWith":"string","query":"string","ext":"string","destination":"relative Documents path","content":"string","to":["email"],"subject":"string","body":"string","attachments":["relative Documents path"]}]}

Action rules:
1. Every action type must be ONE of: list_directory, search_files, create_folder, create_file, rename, move, delete, open, send_email.
2. For send_email: generate a complete, professional email body with ONE greeting, clean paragraphs, and ONE sign-off.
3. For task history: use show_task_history with no path.
4. For file/folder actions: use relative Documents paths. Use "." for Documents root.
5. For search: set "query" to the core keyword only. Set "ext" for file type filtering.
6. When user says "open" for a file or folder, use "open" action (do NOT use list_directory). When user says "show" or "list", use "list_directory".
7. Propose no more than 3 actions. Return JSON ONLY with no commentary.`;

function isPlanConsistentWithIntent(plan, intent) {
  if (!plan?.actions || plan.actions.length === 0) return true;
  const types = plan.actions.map(a => a.type);

  const allowedMap = {
    [INTENTS.FILE_LIST]: new Set(['list_directory', 'search_files']),
    [INTENTS.FILE_SEARCH]: new Set(['search_files', 'list_directory']),
    [INTENTS.FILE_CREATE]: new Set(['create_folder', 'create_file']),
    [INTENTS.FILE_DELETE]: new Set(['delete']),
    [INTENTS.FILE_ORGANIZE]: new Set(['rename', 'move']),
    [INTENTS.FILE_OPEN]: new Set(['open']),
    [INTENTS.EMAIL]: new Set(['send_email']),
    [INTENTS.TASK_HISTORY]: new Set(['show_task_history']),
  };

  const allowed = allowedMap[intent];
  if (!allowed) return true;
  return types.every(t => allowed.has(t));
}

function isFollowUp(text) {
  const lower = String(text || '').toLowerCase().trim();
  if (/\b(it|that|this|those|them|which\s+one|the\s+former|the\s+latter|the\s+(?:first|second|last|latest))\b/i.test(lower)) return true;
  if (/^(open|delete|remove|email|send)\s+(it|that|this|the\s+file|the\s+folder|the\s+document|the\s+pdf)$/i.test(lower)) return true;
  return false;
}

// ---------------------------------------------------------------------------
//  buildPlan — Main Entry Point
// ---------------------------------------------------------------------------
async function buildPlan(request, documentsRoot) {
  const text = String(request || '').trim();
  if (!text) return { summary: 'No request supplied', actions: [], planner: 'none' };

  // Strip leading negation like "no list documents" -> "list documents"
  const noPrefixMatch = /^(?:no|nah|nope|wait|stop)[,\s]+(.+)$/i.exec(text);
  const cleanText = noPrefixMatch ? noPrefixMatch[1].trim() : text;

  const intent = classifyIntent(text);
  conversationContext.lastIntent = intent;

  // --- Pure conversation intents: never create actions ---
  const conversationIntents = new Set([
    INTENTS.GREETING, INTENTS.GOODBYE, INTENTS.THANKS, INTENTS.LISTENING,
    INTENTS.PERSONAL, INTENTS.CAPABILITIES, INTENTS.UNSUPPORTED, INTENTS.CASUAL,
  ]);

  if (conversationIntents.has(intent)) {
    let reply;
    if (isEmailCapabilityRequest(cleanText.toLowerCase())) {
      reply = "Yes! I can draft and send emails with attachments directly from your Documents folder. Just tell me who to send it to (e.g. 'send email to friend@gmail.com with subject Meeting'), and I'll create a draft for you to review and confirm before sending.";
    } else if (intent === INTENTS.CAPABILITIES) {
      reply = capabilitySummary;
    } else {
      reply = await buildConversationReply(cleanText, intent);
    }
    pushHistory('user', text);
    pushHistory('assistant', reply);
    return { summary: 'Conversation', reply, actions: [], planner: intent === INTENTS.CAPABILITIES ? 'deterministic:capabilities' : `conversation:${intent}` };
  }

  // --- Confirmation / Cancellation ---
  if (intent === INTENTS.CONFIRMATION) {
    pushHistory('user', text);
    return { summary: 'Confirmation', reply: null, actions: [], intent: INTENTS.CONFIRMATION, planner: 'deterministic:confirmation' };
  }
  if (intent === INTENTS.CANCELLATION) {
    conversationContext.pendingAction = null;
    pushHistory('user', text);
    const reply = 'Understood. I cancelled that action. What would you like to do instead?';
    pushHistory('assistant', reply);
    return { summary: 'Cancelled', reply, actions: [], intent: INTENTS.CANCELLATION, planner: 'deterministic:cancellation' };
  }

  // --- Task History ---
  if (intent === INTENTS.TASK_HISTORY || isTaskHistoryRequest(cleanText)) {
    pushHistory('user', text);
    return { summary: 'Recent task history', actions: [{ type: 'show_task_history' }], planner: 'deterministic:task_history' };
  }

  // --- File List (Deterministic, instantaneous, 100% reliable, zero hallucination) ---
  if (intent === INTENTS.FILE_LIST) {
    const fallback = fallbackPlan(cleanText);
    fallback.actions = fallback.actions.map((action) => action.type === 'send_email' ? normalizeEmailAction(action) : action);
    const corrected = await correctAttachmentTypos(fallback, documentsRoot);
    pushHistory('user', text);
    conversationContext.lastPlan = corrected;
    return { ...corrected, planner: 'deterministic:file_list' };
  }

  // --- File Open (Deterministic: open the folder or file in OS, do not list in chat) ---
  if (intent === INTENTS.FILE_OPEN) {
    const fallback = fallbackPlan(cleanText);
    pushHistory('user', text);
    conversationContext.lastPlan = fallback;
    return { ...fallback, planner: 'deterministic:file_open' };
  }

  // --- File Organize (Deterministic move/rename when parameters are clear) ---
  if (intent === INTENTS.FILE_ORGANIZE) {
    const moveParams = extractMoveParameters(cleanText);
    if (moveParams) {
      pushHistory('user', text);
      const plan = {
        summary: `Move "${moveParams.src}" to "${moveParams.dest}"`,
        actions: [{ type: 'move', path: moveParams.src, destination: moveParams.dest }],
        planner: 'deterministic:file_organize'
      };
      conversationContext.lastPlan = plan;
      return plan;
    }
    const renameParams = extractRenameParameters(cleanText);
    if (renameParams) {
      pushHistory('user', text);
      const plan = {
        summary: `Rename "${renameParams.src}" to "${renameParams.dest}"`,
        actions: [{ type: 'rename', path: renameParams.src, destination: renameParams.dest }],
        planner: 'deterministic:file_organize'
      };
      conversationContext.lastPlan = plan;
      return plan;
    }
  }

  // --- Follow-up using conversation context ---
  if (intent === INTENTS.FOLLOW_UP && conversationContext.lastResults) {
    const lower = cleanText.toLowerCase();
    const results = conversationContext.lastResults;
    if (/\b(resume|pdf)\b/i.test(lower)) {
      const match = results.find(r => /resume|\.pdf/i.test(r));
      if (match) {
        const reply = `Based on the previous listing, this looks like it: ${match}`;
        pushHistory('user', text);
        pushHistory('assistant', reply);
        return { summary: 'Follow-up answer', reply, actions: [], planner: 'deterministic:follow_up' };
      }
    }
  }

  // --- Task execution: use Ollama with selective history & anti-hallucination validation ---
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const messages = [{ role: 'system', content: systemPrompt }];
      // ONLY pass conversation history if the request is an actual follow-up
      if (isFollowUp(cleanText)) {
        const recent = getRecentHistory(4);
        for (const turn of recent) {
          messages.push({ role: turn.role, content: turn.content });
        }
      }
      messages.push({ role: 'user', content: cleanText });

      const response = await fetch(OLLAMA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: false, format: 'json', messages })
      });
      if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
      const data = await response.json();
      const plan = cleanJson(data.message?.content || '');
      validatePlanActions(plan.actions);

      // ANTI-HALLUCINATION GUARD:
      // If the generated actions contradict the classified intent, reject!
      if (!isPlanConsistentWithIntent(plan, intent)) {
        throw new Error(`Planner proposed actions inconsistent with ${intent} (got ${plan.actions.map(a => a.type).join(', ')})`);
      }

      const normalizedPlan = normalizePlanPaths({ summary: String(plan.summary || 'Proposed actions'), actions: plan.actions }, cleanText);
      normalizedPlan.actions = normalizedPlan.actions.map((action) => action.type === 'send_email' ? normalizeEmailAction(action) : action);
      if (!normalizedPlan.actions || normalizedPlan.actions.length === 0) {
        normalizedPlan.reply = plan.reply || plan.summary || "I'm here to help. What would you like me to do?";
      }
      const correctedPlan = await correctAttachmentTypos(normalizedPlan, documentsRoot);
      pushHistory('user', text);
      if (correctedPlan.reply) pushHistory('assistant', correctedPlan.reply);
      conversationContext.lastPlan = correctedPlan;
      return { ...correctedPlan, planner: `ollama:${model}` };
    } catch (error) {
      lastError = error;
    }
  }

  // --- Ollama failed or hallucinated: use deterministic fallback ---
  const fallback = fallbackPlan(cleanText);
  fallback.actions = fallback.actions.map((action) => action.type === 'send_email' ? normalizeEmailAction(action) : action);
  const correctedFallback = await correctAttachmentTypos(fallback, documentsRoot);
  pushHistory('user', text);
  if (correctedFallback.reply) pushHistory('assistant', correctedFallback.reply);
  conversationContext.lastPlan = correctedFallback;
  return { ...correctedFallback, planner: `fallback (${lastError?.message || 'planner failed'})` };
}

// ---------------------------------------------------------------------------
//  buildEmailRevision (unchanged logic, uses conversation history for context)
// ---------------------------------------------------------------------------
async function buildEmailRevision(currentDraft, revisionInstruction) {
  const cleanBody = normalizeEmailText(currentDraft.body || '');
  const revisionPrompt = `You are editing an existing email draft. The user wants a SMALL CHANGE. You MUST keep the original meaning, topic, and intent of the email intact.

=== CURRENT EMAIL DRAFT ===
To: ${JSON.stringify(currentDraft.to || [])}
Subject: "${currentDraft.subject || ''}"
Body:
"""
${cleanBody}
"""
Attachments: ${JSON.stringify(currentDraft.attachments || [])}
=== END OF DRAFT ===

User's revision request: "${revisionInstruction}"

CRITICAL RULES:
1. The TOPIC and MEANING of the email MUST stay the same. Do NOT change what the email is about.
2. Keep the same recipients in "to" unless the user explicitly says to change them.
3. Keep the same "subject" theme unless the user explicitly asks to change it.
4. Apply ONLY the specific change the user requested (e.g. shorter, more formal, add a detail, fix grammar).
5. The revised body must still be about the SAME SUBJECT as the original draft.
6. Keep "attachments" unchanged unless the user explicitly asks to change them.
7. Formatting:
   - Exactly ONE greeting line at the start (e.g. "Dear [Name]," or "Dear Sir/Madam,"). NEVER duplicate greetings.
   - Clean paragraphs separated by double newlines (\\n\\n). NEVER merge everything into one long paragraph.
   - Exactly ONE closing sign-off at the end (e.g. "Sincerely,\\nUser"). NEVER duplicate sign-offs.
   - Do NOT output literal escaped "\\\\n" text.

Return ONLY valid JSON:
{"to":["email"],"subject":"string","body":"string","attachments":["relative Documents path"]}`;

  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
    const strongerInstruction = attempt === 1
      ? revisionPrompt
      : `${revisionPrompt}\n\nThis is a retry. The previous answer did not apply the requested change. Rewrite the complete subject and body now. The requested change MUST be visible in the output, while preserving all other details.`;
    const response = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        messages: [
          { role: 'system', content: 'You are an email editor. You make precise, targeted edits to email drafts while preserving the original topic and meaning. Never change what the email is about.' },
          { role: 'user', content: strongerInstruction }
        ]
      })
    });
    if (!response.ok) throw new Error(`Ollama returned status ${response.status}`);
    const data = await response.json();
    const revised = normalizeEmailAction(cleanJson(data.message?.content || ''));
    if (!Array.isArray(revised.to) || !revised.to.length || !String(revised.subject || '').trim() || !String(revised.body || '').trim()) {
      throw new Error('Ollama returned an incomplete email draft');
    }
    const normalizedCurrent = normalizeEmailAction(currentDraft);
    const unchanged = revised.subject === normalizedCurrent.subject && revised.body === normalizedCurrent.body;
    if (unchanged && String(revisionInstruction || '').trim()) {
      throw new Error('Ollama returned an unchanged email draft');
    }
    return {
      type: 'send_email',
      to: revised.to,
      subject: revised.subject,
      body: revised.body,
      attachments: filterValidAttachments(revised.attachments || currentDraft.attachments || [])
    };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) return applyLocalRevisionFallback(currentDraft, revisionInstruction);
  throw new Error('Email revision failed');
}

module.exports = {
  buildPlan,
  buildEmailRevision,
  normalizeDocumentsPath,
  normalizeEmailText,
  isTaskHistoryRequest,
  isCapabilityRequest,
  classifyIntent,
  INTENTS,
  pushHistory,
  getRecentHistory,
  clearHistory,
  conversationContext,
  isOllamaAvailable,
  CAPABILITY_GUIDE,
};
