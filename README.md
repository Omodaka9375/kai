<div align="center">
  <img src="public/logo.png" width="96" height="96" alt="Kai" />

  <p>Minimal, private AI-native terminal</p>

  <p>
    <a href="https://github.com/Omodaka9375/kai/releases/latest"><img src="https://img.shields.io/github/v/release/Omodaka9375/kai?style=flat-square&label=download" alt="download" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square" alt="license" /></a>
    <a href="#build-from-source"><img src="https://img.shields.io/badge/platform-Windows%20·%20macOS%20·%20Linux-333?style=flat-square" alt="platform" /></a>
  </p>
</div>

---

Kai is a fast, cross-platform terminal built on **Tauri 2 + Rust** and **React 19**. Terminal, code editor, file explorer, web preview, and AI agent — in one app, lightweight, zero telemetry.

<p align="center">
  <picture>
    <source srcset="docs/terminal.webp" type="image/webp" />
    <img src="docs/terminal.png" width="48%" alt="Kai terminal" />
  </picture>
  <picture>
    <source srcset="docs/ai-workflow.webp" type="image/webp" />
    <img src="docs/ai-workflow.png" width="48%" alt="Kai AI agent editing code" />
  </picture>
</p>

## Contents

- [Features](#features) · [Agent Personas](#agent-personas) · [Install](#install) · [Quick Start](#quick-start) · [Keyboard Shortcuts](#keyboard-shortcuts) · [Configuration Guides](#configuration-guides) · [Build from Source](#build-from-source) · [Tech Stack](#tech-stack)

> New: [Personal Assistant over Telegram](#5-personal-assistant-on-telegram) — chat with KAI from your phone.

## Features

### Terminal

- xterm.js + WebGL rendering, multi-tab with split panes
- Shell integration for bash, zsh, PowerShell, and cmd
- Inline search, smart error detection, autocomplete
- Escape-key streaming interrupt, and a toroidal Conway's Game of Life thinking spinner

### Editor

- CodeMirror 6 with 44 languages and find & replace
- Side-by-side AI edit diffs with per-hunk approve/reject
- 9 editor themes, Vim mode (`:w` / `:q` Ex commands, visual/insert/normal)
- Image & PDF preview, plus **Open in Live Preview** — right-click an HTML file to serve and preview it in-app

### AI Agent

- **Bring your own key** — 12 providers: OpenAI, Anthropic, Google, Groq, xAI, Cerebras, DeepSeek, Mistral, OpenRouter, and direct Z.ai (GLM), plus any OpenAI-compatible endpoint
- Local models via LM Studio or Ollama — vision models receive images automatically (runtime-name detection + a manual Vision override in Settings)
- Paste screenshots straight into chat with `Ctrl+V`; attach PDF/DOCX via the + button (text extracted, works on every model)
- `/compact` — reset the context in place in the same chat when a session runs long; no new chat needed
- Screen access — `look_at_screen` shows your displays to the agent (multi-monitor aware, every capture needs your approval)
- Universal file extraction — zip, audio, image, and video read locally as text
- Interactive todo toggling with auto-closing completion lists
- Per-model thinking control — a toggle on each reasoning model cycles effort off/low/medium/high
- Multi-step goals with automation, plan mode (queue edits for review as one diff), and sub-agents (explore / code-review / security / research)
- Conversation forking and merging — branch any message into a parallel thread, then merge it back or into another thread
- Watch monitoring — the agent polls any shell command on an interval and reports back when it matches (`watch_create`), with optional Telegram pings when you're away

### Image & Video Generation

- Generate directly from chat, with inline rendering, lightbox, and download
- **Image:** OpenAI GPT Image 2 · Google Nano Banana 2 · xAI Grok Imagine
- **Video:** Google Veo 3.1 (Kling, Seedance & others available via their official MCP servers)

### Git

- Stage, commit, push, and review diffs from the source-control panel
- Manage branches (list, switch, create, delete) without leaving the panel — new branches publish with one click (`push -u` sets up tracking)
- Open the GitHub/GitLab/Bitbucket pull-request page for the current branch, straight from the panel
- Resolve merge conflicts with conflict counts and per-file line locations, plus one-click "Ask KAI to resolve"
- Optional GPG commit signing (auto-sign or approval modes)

### Extensibility & Tooling

- **MCP** — connect external tool servers and install from the official registry, or hand the agent a setup URL: `mcp_add_server` registers it so it shows up live in the MCP Servers UI
- File explorer and built-in web preview (with one-tap Stop)
- REST API tester and 8 UI themes
- Voice input — OpenAI whisper-1 transcription with a no-key browser SpeechRecognition fallback
- PDF/DOCX reading, image OCR (tesseract), ZIP/JAR listing, and audio metadata
- Direct PDF export (`convert_to_pdf`) from Markdown/Word
- `Kai.md` project memory, context summarization, and auto-approve modes — plus save/red persistent memory tools the agent can use mid-session
- Skills & snippets
- Per-project **sandbox** (read-only or workspace-only) and a **detached-copy** workflow — work in an isolated copy, then merge or discard

### Personal Assistant

- **Telegram bridge** — chat with KAI from your phone via your own bot (Settings → External): text and voice notes, answered by the same models, tools, and MCP servers you use on the desktop
- Voice notes are transcribed and answered with spoken replies (your configured STT/TTS engines; ffmpeg bridges Telegram's audio format)
- **Owner-locked** — the first `/start` binds your Telegram account; every other account is silently ignored
- Multiple named chats from Telegram — `/new`, `/sessions`, `/use`, `/del`
- Send photos the model can see, or files it can work on (saved to a scratch folder)
- Generated images and videos are delivered straight to your chat
- `watch_create` with `notify_telegram` pings your phone when a long-running job finishes
- **Fenced by design** — file and shell tools are limited to a scratch folder (`~/.kai/assistant`), never your projects or home directory; the desktop app must be running (tray is fine) for the bot to answer

## Agent Personas

KAI ships highly specialized built-in agent personas for different kinds of work. Switch between them in the chat pane, customize their prompts, and reset to factory defaults at any time.

- **Coder** 💻 — general-purpose development: resolves, refactors, and runs tests
- **Architect** 📐 — tradeoffs, scalability, and multi-option blueprints
- **Code Reviewer** 🔍 — logic, edge cases, race conditions, and performance cliffs
- **Security** 🛡️ — threat modeling, input validation, and secure crypto defaults
- **Designer** 🎨 — UI/UX critique, density, typography, spacing, and modern motion
- **Researcher** 🛰️ — web search, page browsing, and structured citations
- **Assistant** ✍️ — brainstorming, copyediting, summaries, and text tasks

## Install

Grab the latest installer from [**Releases**](https://github.com/Omodaka9375/kai/releases/latest) — available for Windows (.exe), macOS (.dmg), and Linux (.deb / .rpm / .AppImage).

Auto-update is built in.

## Quick Start

1. Open **Settings → Models**
2. Add an API key for any provider — or point to a local model
3. Press `Ctrl+I` to open the AI agent

Keys are stored in the OS keychain. No account required.

## Keyboard Shortcuts

Shortcuts use **⌘** on macOS and **Ctrl** on Windows/Linux.

| Action | Shortcut |
| --- | --- |
| Toggle AI agent | `⌘ I` |
| Ask AI about selection | `⌘ L` |
| Toggle voice input | `⌘ M` |
| New tab · private terminal | `⌘ T` · `⌘ R` |
| New editor · preview tab | `⌘ E` · `⌘ P` |
| Close tab / pane | `⌘ W` |
| Split pane right · down | `⌘ D` · `⌘ ⇧ D` |
| Next · previous pane | `⌘ ]` · `⌘ [` |
| Search files | `⌘ ⇧ F` |
| Find · find & replace | `⌘ F` · `⌘ H` |
| Toggle file explorer | `⌘ B` |
| Toggle source panel | `⌘ G` |
| Show shortcuts · settings | `⌘ K` · `⌘ ,` |
| Zoom in · out · reset | `⌘ =` · `⌘ -` · `⌘ 0` |

## Configuration Guides

### 1. Offline Setup with LM Studio

KAI has full support for local, offline-only development. To use a local GGUF model:

1. Open **LM Studio** and go to the **Developer** tab.
2. Start the local HTTP server and note the base URL (usually `http://localhost:1234/v1`).
3. In KAI, open **Settings → Models** and enter the base URL and active **Model ID** (e.g. `qwen3.3-coder-instruct`). Click **Save**.
4. Select **LM Studio (Local)** in chat for fully private intelligence.

### 2. One-Click MCP installations

Extend your AI agent's capabilities with custom tools via the Model Context Protocol:

1. Open the left sidebar and switch to the **Extensions** (puzzle icon) tab.
2. Browse or search for official MCP servers (e.g. `Filesystem`, `PostgreSQL`, or `GitHub`).
3. Click **Install** — KAI downloads and connects the server in the background, making its tools immediately available to the active agent.

### 3. Project Memory with Kai.md

Define custom guidelines, development standards, architectural context, and preferred workflows on a per-project basis. Create a file named `Kai.md` at the project root and KAI automatically injects its contents (up to 32KB) into the agent's instruction prompt on every message.

- **Case sensitivity** — the filename must be exactly `Kai.md` on case-sensitive filesystems (Linux). On Windows/macOS, `KAI.md` / `kai.md` are also recognized.
- **Zero-write safe** — KAI only reads this file; it never writes to it.
- **What to include** — tech stack, formatting guidelines, database schemas, directory mappings, or preferred test commands.

### 4. Anthropic models on a Claude subscription (in the terminal)

KAI's built-in AI agent is BYOK — Anthropic models selected in **Settings → Models** use your Anthropic **API key** and bill at standard API rates. If you have a **Claude Pro/Max subscription** and want to use it instead, run Anthropic's official **Claude Code** CLI in a KAI terminal pane. KAI is a full terminal, so the CLI behaves exactly as it would anywhere else and authenticates against your subscription.

1. Install Claude Code — `npm install -g @anthropic-ai/claude-code` (or the native installer) — then verify with `claude --version`.
2. `cd` into your project, run `claude`, and log in with your **Claude account (Pro/Max)** — not an API key. Switch later with `/login`, and confirm with `/status`.
3. Make sure `ANTHROPIC_API_KEY` is **not** set in the shell — if it is, Claude Code may bill the API instead of your subscription. Check with `echo $ANTHROPIC_API_KEY`.
4. Give Claude Code its own terminal tab. KAI keeps background PTYs alive across tab switches, so the session keeps running while you work in the editor.

> **Why the terminal**: per Anthropic's terms, Claude subscription auth is only for its official clients (Claude Code, claude.ai). Running the official CLI in a terminal is the supported way to use your subscription; KAI's own AI agent remains API-key based and unaffected.

### 5. Personal Assistant on Telegram

KAI can run a personal-assistant bot on your Telegram account — the same agent, tools, and MCP servers, reachable from your phone.

1. In Telegram, message **@BotFather** → `/newbot` → follow the prompts and copy the token.
2. In KAI, open **Settings → External**, paste the token, press **Test** (it shows your bot's `@username`), then toggle **Telegram** on.
3. From Telegram, send `/start` to your bot. The **first account** to do so is bound as its owner — the bot ignores everyone else, permanently.
4. Chat by text or voice notes. `/new [name]` starts a fresh conversation, `/sessions` lists them, `/use <id>` switches, `/del <id>` deletes. `/help` lists all commands.

Notes:

- **Safety**: file and shell tools are fenced to a scratch folder (`~/.kai/assistant`) — your projects and home directory are off-limits. Web search/browse and MCP tools work normally.
- **Voice**: voice notes are transcribed with your configured STT engine and answered with TTS (Settings → Voice). [ffmpeg](https://ffmpeg.org) must be on PATH for Telegram's audio format.
- **Media**: send photos and the model sees them; ask it to generate images or videos and they arrive in the chat.
- **Watches**: `watch_create` with `notify_telegram: true` pings your phone when the watch fires.
- The desktop app must be running (tray is fine) for the bot to answer.

## Build from Source

```bash
# Prerequisites: Rust (stable), Node 20+, pnpm, Tauri v2 deps
pnpm install
pnpm tauri dev          # development
pnpm tauri build        # production
```

## Tech Stack

Tauri 2 · Rust · React 19 · TypeScript · xterm.js · CodeMirror 6 · Vercel AI SDK · Tailwind v4 · shadcn/ui

## Contributing

Issues and PRs welcome.

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
