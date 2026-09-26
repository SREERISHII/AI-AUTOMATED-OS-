# Private OS Agent — Phase 1

A local-first desktop popup for safe file and email automation. It uses Ollama on your computer for planning, checks every requested action against a permission policy, shows a clear confirmation screen, and only then executes approved actions.

## What this first version does

- Press `Alt+Space` to show or hide the popup.
- Ask to create, rename, move, delete, or open files/folders under your Windows **Documents** folder.
- Ask to draft and send an email, including approved files as attachments.
- Uses Ollama at `http://127.0.0.1:11434`; no LLM API key is needed.
- Blocks system locations and paths outside Documents by default.
- Requires confirmation for every write, delete, open, or email-send action.

## Setup

1. Install [Ollama](https://ollama.com/download) for Windows.
2. In a terminal, download a local model:

   ```powershell
   ollama pull llama3.2:3b
   ```

3. Copy `.env.example` to `.env` and fill the SMTP values if you want sending enabled. Until then, email plans can still be reviewed but not sent. Gmail can use either port 465 with `SMTP_SECURE=true`, or STARTTLS on port 587 with `SMTP_SECURE=false` and `SMTP_REQUIRE_TLS=true`.
4. Install and run the desktop app:

   ```powershell
   npm install
   npm start
   ```

## Examples

- `Create a folder called Project Notes in Documents`
- `Create a file todo.txt in Documents with Buy printer ink`
- `Rename Documents/todo.txt to tasks.txt`
- `Move Documents/invoiceaug.pdf to Documents/Invoices`
- `Email acb@gmail.com the invoiceaug.pdf in Documents and say the August invoice is attached`

## Important safety boundaries

This is deliberately **not** a general unrestricted OS agent. The file agent is limited to Documents in Phase 1, never follows requests to access `C:\\Windows`, program files, browser data, credentials, or arbitrary disk locations. Deleting files requires confirmation and uses the Windows Recycle Bin where available.

Email messages and attachments are external sharing: the app always displays the recipient, subject, body, and attachments before sending. SMTP is an email delivery service; message contents leave your computer when you approve sending. Ollama itself can remain local.

## Architecture

`Popup → local Ollama planner → permission manager → file/email agents → final confirmation → executor → audit log`

The planner only produces proposed actions. It never gets direct filesystem or email access. The permission manager independently validates paths, recipients, attachments, and action types before the executor runs anything.

## Project File Structure & Notes

| File Path | Summary / Purpose |
| :--- | :--- |
| **`.env.example`** | Environment configuration template listing required/optional SMTP variables (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`, `MAIL_FROM`, `OLLAMA_MODEL`). |
| **`.gitignore`** | Specifies files/folders excluded from Git control (e.g. `.env`, `node_modules/`, `dist/`, build logs). |
| **`package.json`** | Project manifest containing scripts (`start`, `dev`, `test`), metadata, and dependencies (`electron`, `nodemailer`, `dotenv`). |
| **`package-lock.json`** | Lockfile defining precise dependency tree versions for reproducible installs. |
| **`README.md`** | Comprehensive project overview, installation guide, architecture diagram, security boundaries, and file reference notes. |
| **`UPGRADES.md`** | Complete specification and roadmap for future upgrades (chatbot UI, LLM email generation, revision workflow, file search, error handling). |
| **`UI_UPGRADES.md`** | Detailed specifications for converting the popup interface into a continuous chatbot conversation view with cards, bubbles, and interactive controls. |
| **`src/main.js`** | Electron main process entry point. Creates window, registers global hotkey (`Alt+Space`), records audit logs (`audit.jsonl`), and handles IPC channels (`agent:plan`, `agent:execute`). |
| **`src/planner.js`** | Planning module. Sends prompt requests to local Ollama (`http://127.0.0.1:11434`) to build JSON action plans, with fallback regex parser for offline/quick execution. |
| **`src/permission-manager.js`** | Security gatekeeper. Restricts path operations strictly to the user's `Documents` folder, blocks forbidden paths (`C:\Windows`, `.env`, SSH keys), and checks email address formats. |
| **`src/executor.js`** | Action execution engine. Safely creates folders/files, moves/renames, opens items, sends files to Windows Recycle Bin, and invokes the email worker for email delivery. |
| **`src/send-email-worker.js`** | Standalone Node.js worker script executed via child process. Uses Node's OpenSSL engine for Nodemailer delivery to prevent TLS handshake failures caused by Electron's BoringSSL. |
| **`src/preload.js`** | Electron context bridge preloader. Exposes isolated `window.agent.plan()` and `window.agent.execute()` methods safely to the renderer process. |
| **`src/renderer/index.html`** | HTML user interface for the agent popup modal, prompt box, plan review screen, and status alerts. |
| **`src/renderer/renderer.js`** | Frontend DOM script handling prompt submission, plan formatting, security permission badges, user confirmations, and execution output rendering. |
| **`src/renderer/styles.css`** | CSS stylesheet implementing modern dark theme aesthetics, glassmorphism card styling, responsive layouts, badges, and button interactions. |
| **`test/permission-manager.test.js`** | Automated unit test suite verifying path restriction rules, blocklist enforcement, path normalization, and email payload validation. |

