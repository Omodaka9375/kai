<div align="center">
  <img src="public/logo.png" width="96" height="96" alt="Kai" />

  <p>Minimal, private AI-native terminal emulator</p>

  <p>
    <a href="https://github.com/Omodaka9375/Kai-ai/releases/latest"><img src="https://img.shields.io/github/v/release/Omodaka9375/Kai-ai?style=flat-square&label=download" alt="download" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square" alt="license" /></a>
    <a href="#build-from-source"><img src="https://img.shields.io/badge/platform-Windows%20·%20macOS%20·%20Linux-333?style=flat-square" alt="platform" /></a>
  </p>
</div>

---

Kai is a fast, cross-platform terminal built on **Tauri 2 + Rust** and **React 19**. Terminal, code editor, file explorer, web preview, and AI agent — in one app, under 10 MB, zero telemetry.

<p align="center">
  <img src="docs/terminal.png" width="48%" alt="Terminal" />
  <img src="docs/split-panes.png" width="48%" alt="AI agent" />
</p>

## Features

**Terminal** — xterm.js + WebGL, multi-tab, split panes, shell integration (bash/zsh/PowerShell/cmd), inline search, smart error detection with one-click AI fix.

**Editor** — CodeMirror 6 with 44 languages, find & replace, inline AI autocomplete, edit diffs with approval flow, 9 editor themes, Vim mode, image & PDF preview.

**AI Agent** — bring your own key. Supports OpenAI, Anthropic, Google, Groq, xAI, Cerebras, DeepSeek, Mistral, OpenRouter, and any OpenAI-compatible endpoint. Local models via LM Studio or Ollama.

**MCP** — connect external tool servers via Model Context Protocol. Browse and install from the official registry.

**More** — file explorer with Catppuccin icons, built-in web preview, REST API tester, 8 UI themes, voice input, PDF/DOCX reading, YouTube transcript summarization, `Kai.md` project memory, context summarization, auto-approve modes.

## Install

Grab the latest installer from [**Releases**](https://github.com/Omodaka9375/Kai-ai/releases/latest) — available for Windows (.exe), macOS (.dmg), and Linux (.deb / .rpm / .AppImage).

Auto-update is built in.

## Quick Start

1. Open **Settings → Models**
2. Add an API key for any provider — or point to a local model
3. Press `Ctrl+I` to open the AI agent

Keys are stored in the OS keychain. No account required.

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
