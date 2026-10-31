# Private OS Agent — Evidence-Based Technical Report

**Repository reviewed:** `E:\AI OS`  
**Review date:** 2026-10-21  
**Evidence rule:** Statements below are based on the repository files. Items not found in the repository are explicitly marked.

## 1. Executive Summary

Private OS Agent is a Windows Electron desktop application that provides a small popup chatbot for file operations in the user's `Documents` folder and for drafting/sending email. A local Ollama model proposes structured actions. A separate permission manager validates the proposal. A signed, short-lived capability is issued only for an approved plan, and the executor performs the action after confirmation.

The project is a desktop AI automation tool, not a web application or mobile application. Its main privacy goal is to keep planning local: the application calls Ollama at `http://127.0.0.1:11434`. Email delivery is intentionally external: SMTP sends the approved message and attachment outside the computer.

Current status: Phase 1 is substantially functional. File actions, email drafting/revision, local planning, permission checks, HMAC capabilities, replay/expiry checks, audit history, and a chatbot-style renderer are present. The automated tests pass. There is no database, login system, HTTP API server, Docker configuration, or production installer in the repository.

## 2. Project Structure

```text
E:\AI OS
├── package.json                 Project metadata, scripts, dependencies
├── package-lock.json            Locked npm dependency tree
├── README.md                    Setup, architecture, safety boundaries
├── UPGRADES.md                  Feature roadmap
├── UI_UPGRADES.md               Chatbot UI specification
├── src
│   ├── main.js                  Electron main process and IPC handlers
│   ├── preload.js               Isolated renderer/main bridge
│   ├── planner.js               Ollama planner, fallback planner, email editing
│   ├── permission-manager.js    Independent policy checks
│   ├── capability-manager.js    HMAC capabilities and task lifecycle
│   ├── executor.js              File, search, open, delete, and email execution
│   ├── send-email-worker.js      Standalone Node/Nodemailer SMTP worker
│   └── renderer
│       ├── index.html            Chatbot document structure
│       ├── renderer.js           UI state, chat, revision, confirmation
│       └── styles.css            Dark responsive UI styling
└── test
    ├── permission-manager.test.js
    ├── capability-manager.test.js
    └── planner.test.js
```

`node_modules` and temporary/generated review files are excluded from this report. `.env.example` and `.gitignore` are referenced by `README.md` but are **not found in the repository listing**.

## 3. Technology Stack

| Technology | Version/evidence | Purpose | Location |
|---|---|---|---|
| JavaScript | Node/CommonJS source | Application logic | `src/*.js` |
| Electron | `^35.0.0` | Windows desktop shell, BrowserWindow, IPC, global shortcut | `package.json`, `src/main.js` |
| HTML/CSS | No separate version | Chat UI and styling | `src/renderer/index.html`, `styles.css` |
| Node.js | Runtime required; exact version not pinned | Main process and email worker | `src/main.js`, `send-email-worker.js` |
| Ollama | Local HTTP service at `127.0.0.1:11434` | Local planning and conversational/email generation | `src/planner.js` |
| Default model | `llama3.2:3b` unless `OLLAMA_MODEL` is set | Local language model | `planner.js`, README |
| `dotenv` | `^16.4.7` | Loads SMTP/model environment variables | `planner.js`, `executor.js`, worker |
| Nodemailer | `^6.10.0` | SMTP email delivery | `send-email-worker.js` |
| Node `crypto` | Built-in | UUIDs, SHA-256 plan hash, HMAC signatures | `capability-manager.js` |
| Node `fs/promises` | Built-in | Files, logs, capabilities, folders | `main.js`, `executor.js`, capability manager |
| Node `child_process` | Built-in | Runs standalone Node email worker | `executor.js` |
| Testing | Node `assert`; npm script | Unit/integration-style checks | `test/*.test.js` |
| Database | Not found | None; JSONL logs are used | `main.js`, `executor.js` |
| Authentication | Not found | No user login; local OS/app access is assumed | Repository-wide |
| Deployment | Not found | No installer, Dockerfile, or build pipeline | Repository-wide |

## 4. Complete System Architecture

```text
User
  ↓ Alt+Space popup / chat input
Electron renderer: index.html + renderer.js + styles.css
  ↓ contextBridge IPC
Electron main process: main.js
  ↓
planner.js ── HTTP localhost ── Ollama / llama3.2:3b
  ↓ structured plan
permission-manager.js
  ↓ allowed / rejected
capability-manager.js
  ├─ task ID, expiry, scope, plan hash, HMAC signature
  └─ capabilities.jsonl
  ↓ explicit UI confirmation
executor.js
  ├─ Documents filesystem / Windows shell
  └─ send-email-worker.js → Nodemailer → SMTP provider
  ↓
renderer execution result
  + audit.jsonl
```

The renderer never receives Node filesystem access directly because `contextIsolation: true` and `nodeIntegration: false` are set in `main.js`. Only the methods exposed in `preload.js` can be called by the UI. The planner proposes actions but does not execute them. The permission manager is a separate gate. The capability manager binds the exact plan to a signed, expiring, one-use authorization. The executor performs only the action types allowed by the policy.

## 5. Main Execution Flow

1. `src/main.js` is the Electron entry point. `app.whenReady()` creates a `BrowserWindow`, loads `src/renderer/index.html`, and registers `Alt+Space`.
2. The renderer collects a user message in `src/renderer/renderer.js` and calls `window.agent.plan()`.
3. `src/preload.js` maps that call to IPC channel `agent:plan`.
4. `main.js` starts a task using `CapabilityManager.startTask(request)`.
5. `planner.js:buildPlan()` first handles local conversational intents, then calls Ollama using JSON format, retries twice, and falls back to deterministic parsing when Ollama fails.
6. `normalizePlanPaths()` normalizes Documents paths; email actions are normalized and attachment typo correction can resolve a unique same-stem file under Documents.
7. `permission-manager.js:checkPlan()` validates action types, Documents containment, protected path names, email recipients, required subject/body, and sensitive attachments.
8. Conversation-only responses return without a capability. Rejected executable plans are logged as `REJECTED`.
9. Approved executable plans receive a capability from `CapabilityManager.issue()`. The plan hash and scope are signed with HMAC.
10. The renderer shows a plan/draft card. Read-only list/search/history actions may auto-execute; write, delete, open, and email actions require confirmation.
11. `agent:execute` re-runs permission checks, calls `CapabilityManager.consume()`, verifies signature, status, expiry, and exact plan hash, then calls `executor.js:executePlan()`.
12. File actions use `fs/promises`; opening uses Electron `shell.openPath`; deletion uses the shell recycle-bin API when available.
13. Email actions use `executor.js:sendEmail()`, which launches `send-email-worker.js`. The worker uses Nodemailer and SMTP.
14. Successful and failed executions are written to `audit.jsonl`; capability status is updated to `USED`, `EXPIRED`, or `REJECTED`.
15. Results are returned through IPC and rendered as an agent message in the chat.

## 6. Input Handling

### Text/chat input

Origin: the `<textarea id="promptInput">` in `src/renderer/index.html`.  
Transport: `window.agent.plan(text)` through `preload.js` and IPC.  
Validation: planner parsing, permission checks, path normalization, and action allowlisting.  
Invalid behavior: conversational fallback, blocked plan, or a user-facing error.

### Email input

The user supplies an address, purpose, optional attachment, and revision instructions as natural language. Ollama is expected to return `to`, `subject`, `body`, and `attachments`. `permission-manager.js` validates recipient format and non-empty subject/body. `planner.js` normalizes greetings, paragraphs, sign-offs, escaped newlines, recipients, and attachments.

### File paths

Paths are intended to be relative to Documents. `safeDocumentPath()` rejects absolute paths, traversal outside the root, and protected names such as `Windows`, `Program Files`, `AppData`, `.ssh`, and `.git`.

### File upload, URL, query, voice, image, and authentication inputs

Not found in the repository. Attachments are selected by natural-language path references; there is no browser upload API. There is no voice/image input, URL route, login form, or authentication token.

Example safe request:

```text
Create a folder called Project Notes in Documents
```

Representative plan:

```json
{"summary":"Create folder","actions":[{"type":"create_folder","path":"Project Notes"}]}
```

## 7. API and IPC Documentation

There is no HTTP API server or REST route. Communication uses Electron IPC.

| Channel | Caller | Purpose | Validation/behavior |
|---|---|---|---|
| `agent:plan` | `window.agent.plan(request)` | Plan a user request | Starts task, calls planner, checks permissions, issues capability |
| `agent:revise-email` | `window.agent.reviseEmail(draft, instruction)` | Generate complete revised email | Starts task, calls Ollama editor, checks revised plan, issues capability |
| `agent:approve-draft` | `window.agent.approveDraft(draft)` | Approve manually edited draft | Checks draft and issues a new capability |
| `agent:execute` | `window.agent.execute(plan, capability)` | Execute approved plan | Rechecks permission, verifies HMAC/expiry/replay/hash, executes |

Required headers, URL parameters, HTTP authentication, database operations, and CORS settings are not applicable. Renderer-to-main calls are restricted by the preload bridge.

## 8. Ollama and AI Workflow

Ollama is a local model runner. This project uses it as a planner and email/conversation generator, not as the executor. The configured endpoint is `http://127.0.0.1:11434/api/chat`; the model is `process.env.OLLAMA_MODEL || 'llama3.2:3b'`.

```text
User input
  ↓
Planner/conversation prompt in planner.js
  ↓
HTTP POST to local Ollama
  ↓
llama3.2:3b (or OLLAMA_MODEL)
  ↓ JSON content
  ↓ cleanJson(), validation, normalization
  ↓ permission manager
  ↓ UI plan/draft or conversation response
```

The planner sends the user request and a system prompt describing the JSON action schema, allowed action types, Documents path rules, and email-generation rules. Email revision sends the current recipient, subject, body, attachments, and revision instruction. Conversation replies use a separate prompt that restricts the assistant to the project's role.

`stream: false` is used; no streaming or conversation-history array is persisted in the backend. The renderer keeps visible chat history, but the planner receives the current request/draft rather than a durable multi-turn model context. Invalid JSON, missing action lists, unsupported actions, incomplete email fields, an unavailable service, or an unchanged revision are handled by retries and fallbacks.

Privacy benefit: user planning data is sent to localhost rather than a hosted LLM API. Limitation: email content, recipients, and attachments leave the computer when SMTP sends the message. Local inference also consumes CPU/RAM and `llama3.2:3b` may produce malformed or repetitive output.

## 9. Prompt Engineering Analysis

### Planner system prompt — `src/planner.js:systemPrompt`

Purpose: force JSON action plans, limit action types, define file path and email rules, and keep the model within the desktop-agent role. Inputs are the user request; expected output is a summary plus action array. Weaknesses include model susceptibility to ambiguous wording, typoed filenames, and capability questions that resemble file requests. Deterministic local classifiers and permission validation reduce those risks.

### Conversation prompt — `buildConversationReply()`

Purpose: generate natural greetings/capability answers and polite scope refusals. It asks for `{"reply":"string"}`, does not allow claims of completed actions, and uses a higher temperature (`0.8`) for variation. It is not a security boundary by itself; the application still decides whether an action exists.

### Email revision prompt — `buildEmailRevision()`

Purpose: regenerate a complete email while preserving recipients, topic, attachments, and prior changes. It requires one greeting, clean paragraphs, one sign-off, valid JSON, and no literal escaped newline text. It retries when the model returns incomplete or unchanged content, then uses a deterministic local revision fallback. A limitation is that local fallback wording is not model-generated when Ollama is unavailable.

### Fallback planner

`fallbackPlan()` uses regular expressions for task history, email, open, list, search, create, delete, and other common requests. It improves availability but has lower language understanding and may require future expansion.

## 10. Database and Data Flow

No database, tables, collections, migrations, seed data, or ORM are found. Persistent local data consists of JSON Lines files under Electron's `app.getPath('userData')`:

- `audit.jsonl`: audit events, plan creation, conversation replies, revisions, execution results/errors.
- `capabilities.jsonl`: task IDs, request, timestamps, status, scope, plan hash, reasons.
- `capability-secret.key`: random HMAC secret created with restrictive file mode.

Documents themselves remain in the user's Windows Documents directory. Email drafts are passed through memory and audit events; the full draft may be included in `email-revised` audit detail. No relational relationships or data deletion policy are implemented.

## 11. Authentication and Security

### Implemented controls

- Electron context isolation and disabled renderer Node integration.
- IPC surface limited to four explicit bridge methods.
- Documents-root containment and protected-name blocklist.
- Recipient syntax validation and sensitive attachment-name blocklist.
- Independent permission manager.
- HMAC-signed capability object with task ID, expiry, operation/resource scope, recipients, attachments, and exact plan hash.
- One-time consumption and replay rejection.
- Five-minute default capability lifetime.
- Audit and capability status records.
- Email confirmation UI before external transmission.

### Important weaknesses

1. `src/executor.js` sets `tls.rejectUnauthorized: false`. This disables SMTP certificate verification and is unsafe for production. It was introduced to work around Electron/antivirus certificate parsing problems; the correct production fix is a trusted certificate chain or controlled CA configuration, not disabled verification.
2. `src/executor.js` falls back to `fs.rm(..., recursive: true, force: true)` if the shell recycle-bin API is unavailable. That is permanent deletion rather than recycle-bin deletion.
3. `writeAudit()` silently ignores log-write failures, reducing forensic reliability.
4. SMTP credentials are loaded from environment variables; repository history must never include `.env`. `.env.example` is referenced but not present, so configuration documentation is incomplete.
5. There is no OS-level user authentication or multi-user authorization. The local desktop user is trusted.
6. Logs may contain user requests, recipients, attachment names, and email drafts. Sensitive file contents are not intentionally read, but email bodies and metadata can be sensitive.
7. Prompt injection resistance is limited to the planner prompt and deterministic permission checks. A malicious file name or email instruction can still influence model wording; execution remains constrained by the policy.
8. Exact plan hashing is strong against mutation, but user-edited email drafts must receive a new capability before execution.

No CORS, CSRF, rate limiting, password, session, or web authentication code is found because there is no HTTP server.

## 12. Error Handling

| Error area | Current behavior | Improvement |
|---|---|---|
| Invalid/missing plan | Permission manager rejects with reason | Add structured error codes |
| Ollama offline/malformed | Two attempts, then fallback planner/conversation | Show Ollama status and distinguish fallback mode |
| Missing model | Ollama request fails, fallback may be used | Check model availability before planning |
| Unsafe path | Permission manager blocks before execution | Explain allowed Documents root in UI |
| Missing file/folder | Executor throws or returns friendly search/open result | Validate existence before issuing capability |
| Missing attachment | Executor throws a readable message; fuzzy same-name matching exists | Show candidate choices before approval |
| SMTP/TLS/login | Worker returns Nodemailer error; UI displays dispatch failure | Map technical errors to friendly categories and preserve technical detail behind disclosure |
| Capability expiry/replay/hash | `consume()` rejects | UI should offer “Create a new plan” |
| Renderer/IPC exception | Catch blocks render text response | Add centralized error telemetry without secrets |

## 13. Testing and Verification

Run:

```powershell
npm test
```

Current tests pass:

- `permission-manager.test.js`: allowed Documents file action, list/search read-only behavior, traversal and absolute path rejection, valid/blocked attachments, path normalization.
- `capability-manager.test.js`: unique task IDs, active status, capability scope, one-use replay protection, plan binding, short expiry, rejected status, and task-history output.
- `planner.test.js`: email formatting normalization and task-history intent recognition.

Missing or recommended tests:

- Full `buildPlan()` tests with a mocked Ollama server.
- Conversation greeting/off-topic classification tests.
- Multiple sequential email revisions with mocked model responses.
- Attachment typo correction and ambiguous-match tests.
- SMTP worker tests with a fake SMTP server.
- End-to-end Electron IPC tests.
- Manual confirmation, cancellation, and expired capability tests in the UI.
- Security tests for symlinks, junctions, protected files, audit failures, and SMTP certificate validation.
- AI evaluation set for malformed JSON, prompt injection, ambiguous paths, and hallucinated files.

## 14. Installation and Execution Guide

Verified repository commands:

```powershell
cd "E:\AI OS"
npm install
ollama pull llama3.2:3b
npm start
```

Ollama may already be running as a background service. If `ollama serve` reports that port `11434` is already in use, do not start a second server; verify with `ollama list` or `Invoke-RestMethod http://127.0.0.1:11434/api/tags`.

Environment variables referenced by code/README:

```text
SMTP_HOST
SMTP_PORT
SMTP_USER
SMTP_PASS
SMTP_SECURE
SMTP_REQUIRE_TLS (documented, not directly read by executor.js)
MAIL_FROM
OLLAMA_MODEL
```

SMTP credentials are not reproduced here. Gmail requires an App Password or another permitted SMTP authentication method; never place a normal account password in the repository or chat. No database setup, backend/frontend split, Docker setup, or migration is required.

Verification examples:

```text
Hi
What can you do?
Display files and folders in Documents
Show recent task history
Create a folder called Project Notes in Documents
Email a safe test recipient about a test message
```

## 15. Deployment

The repository supports local development with Electron but contains no installer, packaging configuration, signing setup, CI pipeline, or production build command. A practical deployment would package Electron for Windows, bundle the application source, document Node/Ollama prerequisites, keep SMTP configuration outside the package, and preserve per-user `userData` logs securely.

Ollama must run locally on the same machine unless the architecture is deliberately changed. Port `11434` must be available locally. SMTP network access is required only for sending. Production prerequisites include certificate verification, secret storage, log rotation, backup/retention policy, Windows code signing, and tests for the exact installed model.

## 16. Strengths and Weaknesses

### Strengths

- Clear separation between planning, policy, capability, and execution.
- Local model endpoint supports the privacy objective.
- Documents-root boundary is easy to explain and audit.
- HMAC/expiry/plan-hash design closely matches capability-based security concepts.
- Email review and attachment display make external transmission visible.
- JSONL logs are simple to inspect and recover.
- Renderer is already a continuous chat interface with draft/action cards.
- Tests cover the most important capability properties.

### Weaknesses

- No database, account model, installer, or deployment automation.
- Model output remains probabilistic and fallback logic is necessarily less capable.
- SMTP certificate verification is explicitly disabled.
- Capability errors can be confusing when an edited draft changes the plan.
- Some audit writes are silently discarded.
- The full conversation is not sent as model context; long conversational continuity is limited.
- File existence and attachment resolution should be completed before capability issuance.

## 17. Improvement Recommendations

### Critical

1. Re-enable SMTP certificate verification and configure a trusted CA if antivirus interception is required. Affects `src/executor.js` and environment documentation. Benefit: prevents man-in-the-middle SMTP risk.
2. Remove the permanent-delete fallback or require an explicit high-risk setting. Affects `src/executor.js`. Benefit: preserves recoverability.
3. Add tests/mocks for Ollama and email worker. Benefit: prevents regressions in the most failure-prone integrations.

### High priority

4. Validate attachment existence and ambiguity before capability issuance.
5. Add friendly error categories with expandable technical diagnostics.
6. Add a real user-confirmation state to the audit log.
7. Add log rotation and redaction for email bodies and sensitive metadata.
8. Add model availability/status indicator.

### Medium priority

9. Add persisted conversation IDs and bounded history for better multi-turn context.
10. Add extension/date/size filters and selectable search results.
11. Add a settings UI for model and SMTP configuration without displaying secrets.
12. Add Windows packaging, signing, and start-on-login options.

### Optional/future

13. Add more agents (calendar, browser, notes) only behind separate policies.
14. Add encrypted local storage for sensitive audit fields.
15. Add formal threat modeling and an AI evaluation benchmark.

## 18. Viva Preparation

### A. One-minute explanation

Private OS Agent is a local-first Windows desktop assistant built with Electron and JavaScript. The user types a natural-language file or email request into a popup chatbot. Ollama runs locally and converts the request into a structured plan. A separate permission manager checks paths, recipients, attachments, and dangerous operations. If the plan is safe, the system creates a short-lived HMAC-signed capability tied to the exact plan. After the user confirms, the executor performs the file operation or sends the email, and the result is written to local audit logs. This design separates AI planning from authorization and execution.

### B. Five-minute explanation

The application starts in `src/main.js`, creates a hidden Electron window, and exposes it with `Alt+Space`. The renderer provides a chat interface. Requests cross the isolated preload bridge into the main process. `planner.js` calls a local Ollama HTTP endpoint and expects JSON actions. If Ollama is unavailable, deterministic fallback rules handle common tasks. The independent permission manager validates every proposed action and restricts filesystem access to Documents. For approved executable plans, the capability manager creates a unique task ID, five-minute expiry, scope, SHA-256 plan hash, and HMAC signature. The UI displays the draft or action card and waits for confirmation. The executor verifies the capability again before running. File actions use Node filesystem APIs and Electron shell APIs. Email uses a separate Node worker and Nodemailer because Electron's TLS stack caused certificate parsing problems in the development environment. Audit and capability JSONL files provide traceability. The design is privacy-oriented for planning, but SMTP delivery still sends approved email data externally.

### C. Viva questions and answers

1. **Why Electron?** It provides a Windows desktop popup, global shortcut, renderer UI, and controlled main/renderer separation.
2. **Why Ollama?** It runs the planner locally, avoiding a hosted LLM API for user prompts.
3. **Does Ollama execute files?** No. It proposes JSON actions; the executor is separate.
4. **What protects the Documents folder?** `safeDocumentPath()` resolves paths under the Documents root and rejects absolute/traversal/protected paths.
5. **What is the permission manager?** An independent policy gate that validates action types, paths, recipients, subjects, bodies, and attachments.
6. **What is a capability?** A short-lived signed authorization bound to a particular plan and scope.
7. **How is replay prevented?** A consumed capability changes to `USED`; a second consume is rejected.
8. **How is expiry checked?** `consume()` compares the current time with `expiresAt` and records `EXPIRED`.
9. **Why use a plan hash?** It detects modifications between approval and execution.
10. **What does HMAC provide?** Integrity/authenticity for the capability payload using a local secret.
11. **Where is the secret stored?** In `capability-secret.key` under Electron user data; actual values are not exposed.
12. **Is there a database?** No. JSONL audit and capability files are used.
13. **How does the UI communicate with main?** Through methods exposed by `contextBridge` in `preload.js`.
14. **Why is Node integration disabled?** To prevent renderer HTML/JS from directly accessing Node APIs.
15. **How are emails generated?** Ollama receives the request or current draft and returns a complete JSON email.
16. **How are revisions handled?** Each revision sends the current draft plus instruction back to Ollama and receives a complete replacement draft.
17. **What happens if Ollama fails?** The planner retries and uses deterministic fallback behavior for common requests; revision fallback is local and limited.
18. **Is conversation history sent to Ollama?** The visible renderer history is not persisted as a complete model context; the current request/draft is sent.
19. **How are attachments protected?** They must be relative to Documents and sensitive names/extensions are blocked.
20. **How are delete operations handled?** Electron shell recycle-bin APIs are preferred; the current code has a risky permanent-delete fallback.
21. **How is SMTP configured?** Environment variables supply host, port, security, user, password, and sender.
22. **Why a child Node email worker?** To use standalone Node/OpenSSL instead of Electron's BoringSSL behavior seen with inspected SMTP certificates.
23. **What is the largest security issue?** `rejectUnauthorized: false` disables SMTP certificate validation.
24. **What tests exist?** Permission, capability, expiry/replay/hash, task history, and email formatting tests.
25. **How is an invalid action handled?** It is rejected before capability issuance or execution.
26. **What are the IPC routes?** `agent:plan`, `agent:revise-email`, `agent:approve-draft`, and `agent:execute`.
27. **What is the role of JSONL logs?** They provide local, append-oriented audit and capability history.
28. **Can the system access C: drive?** It calculates the user Documents path on C: but rejects arbitrary paths outside Documents.
29. **What is not implemented?** Authentication, database persistence, voice input, web API, installer, and production deployment.
30. **How can scalability improve?** Separate services, persistent database, job queue, model service management, and stronger policy storage would be needed.

### D. Difficult follow-up questions

- **Is the system completely private?** No. Planning can stay local, but approved SMTP email and attachments leave the device.
- **Can a malicious model bypass permission checks?** It can propose bad JSON, but action allowlisting and path/recipient checks should block it. The policy must remain independent.
- **Why call it sandboxed if it is an Electron app?** The project implements an application-level Documents policy, not an OS kernel sandbox.
- **Why disable TLS verification?** It was a development workaround and is not acceptable as a production security posture; this must be fixed.
- **Can a capability be stolen?** A stolen capability is protected by HMAC, expiry, one-use status, and plan hash, but local process compromise remains outside this design.
- **Why no database?** Phase 1 favors a simple local prototype; JSONL is not sufficient for multi-user or high-volume production.

### E. Key terms

- **IPC:** Inter-process communication between Electron renderer and main process.
- **Ollama:** Local runtime for language models.
- **Planner:** Component translating natural language to structured actions.
- **Permission manager:** Independent policy checker.
- **Capability:** Signed, limited authorization to perform one exact plan.
- **HMAC:** Keyed hash used to detect tampering.
- **Plan hash:** Digest of the approved action plan.
- **Replay attack:** Reusing an already consumed authorization.
- **JSONL:** One JSON object per line, useful for append-only logs.
- **SMTP:** Protocol/service used to deliver email.
- **Context isolation:** Electron boundary preventing renderer Node access.

### F. What not to claim

Do not claim that the project has a database, user authentication, full OS sandboxing, cloud-free email delivery, guaranteed model correctness, production-grade TLS, a Windows installer, voice/image support, or complete conversation-memory persistence. Those claims are not supported by the repository.

## 19. AI Knowledge Transfer Summary

```text
PROJECT_IDENTITY:
- Name: Private OS Agent
- Purpose: Local-first, permission-aware file and email automation
- Domain: Desktop automation and local AI planning
- Users: A local Windows desktop user

TECH_STACK:
- Frontend: HTML/CSS/vanilla JavaScript in Electron renderer
- Backend: Electron main process/CommonJS JavaScript
- Database: None; JSONL logs
- AI: Ollama, default llama3.2:3b
- Deployment: Local Electron development; installer not found

ENTRY_POINTS:
- Frontend: src/renderer/index.html and renderer.js
- Backend: src/main.js
- Main API: Electron IPC channels, not HTTP
- Main AI function: planner.js buildPlan() and buildEmailRevision()

REQUEST_FLOW:
1. Renderer captures chat text.
2. Preload forwards it to main via agent:plan.
3. Planner calls Ollama or fallback rules.
4. Permission manager validates the proposed action.
5. Capability manager issues signed, expiring authorization.
6. User confirms; agent:execute verifies capability.
7. Executor performs file/email action and writes audit result.

OLLAMA:
- Role: Conversation, action planning, email generation/revision
- Model: OLLAMA_MODEL or llama3.2:3b
- Connection method: HTTP POST to 127.0.0.1:11434/api/chat
- Prompt location: src/planner.js
- Response handling: JSON extraction, validation, normalization, retries, fallback
- Failure behavior: fallback planning/conversation; local revision fallback

DATA:
- Input formats: Natural-language text, structured internal plan, email draft
- Stored data: audit.jsonl, capabilities.jsonl, capability-secret.key, user Documents files
- Output formats: JSON plans, chat messages, execution result arrays/strings

SECURITY:
- Authentication: Not implemented
- Authorization: Permission manager plus HMAC capability
- Main risks: Disabled SMTP certificate verification, permanent-delete fallback, sensitive audit details

KNOWN_LIMITATIONS:
- No database, HTTP API, login, installer, voice/image input, or full model conversation memory.
- SMTP certificate verification must be fixed before production use.

IMPORTANT_FILES:
- src/main.js: Electron lifecycle, IPC, capability/audit orchestration
- src/planner.js: Ollama prompts, fallback planning, email revisions
- src/permission-manager.js: path/email/attachment policy
- src/capability-manager.js: HMAC capabilities and task statuses
- src/executor.js: filesystem, search, open, delete, SMTP worker invocation
- src/send-email-worker.js: Nodemailer SMTP delivery
- src/preload.js: isolated bridge
- src/renderer/renderer.js: chatbot and confirmation UI
- test/*.test.js: automated verification

OPEN_QUESTIONS:
- What exact Node/Electron versions will production use?
- Will audit logs be encrypted/rotated?
- What trusted CA configuration will replace rejectUnauthorized:false?
- Is a signed Windows installer required for submission?
```

## 20. Final Traceability Checklist

- Major features: covered.
- Important source files/functions: referenced.
- Request lifecycle: covered from renderer to executor.
- Ollama role versus application role: separated.
- Input validation and permission checks: covered.
- IPC API surface: documented; no unsupported HTTP API claimed.
- Database: explicitly marked absent.
- Security weaknesses: included, especially SMTP TLS and deletion fallback.
- Setup commands: based on `README.md` and `package.json`.
- Secrets: not reproduced; environment values are described only by name.
- Unsupported claims: listed in viva section.
- Tests: current test files and `npm test` behavior documented.

**Conclusion:** This is a strong Phase 1 academic prototype demonstrating local LLM planning, policy-based authorization, capability security, and controlled desktop execution. Its most important work before production claims is fixing SMTP certificate verification, removing permanent deletion fallback, adding mocked Ollama/SMTP integration tests, and documenting packaging/configuration files that are currently missing.
