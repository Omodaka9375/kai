# Changelog

All notable changes to the KAI terminal emulator project are documented in this file. KAI adheres to Semantic Versioning.

---

## [1.6.3]

- Radio: fix statio picker fail
- Radio: the marquee is now centered in the status bar; the pill opens the station picker, and the speaker icon is a mute toggle with a volume slider.
- Header: removed the split-terminal button — splitting lives in the tab context menu and keyboard shortcuts.

---

## [1.6.2]

- AI: message timestamps — messages are stamped with `createdAt` at first persist; 
- AI: session list rows show compact relative ages (just now / 5m ago / yesterday / Oct 3) with the full local time on hover
- Session picker: bounded, scrollable menu fix
- Tabs: fixed new terminals spawning in the previous project after switching projects — the remembered terminal cwd outlived the project switch; a new terminal on a fresh project's StartPage now inherits the current project root.
- Radio: new opt-in SomaFM radio in the status bar (General settings → Mood) — a bounded now-playing marquee with a station picker (12 curated channels). Every operation is fail-safe: a dead stream or offline network degrades to a quiet unavailable state and never blocks or crashes the app.
- AI: `play_radio`, `stop_radio`, and `radio_list_stations` tools — the agent can pick a station by name or genre ("put on something ambient") and drive the same player as the status-bar widget.

---

## [1.6.1]

- Tabs: project open closes all tabs, kills all terminal sessions, and shows the StartPage. No terminal is auto-spawned on project open or launch.
- AI: fixed incorrect tool name in the Windows instructions; added multi-edit usage rules and reduced to-do update frequency in agent guidance.
- UI: slash commands show the `/` prefix in the command picker, chips, and submit path; `#` is reserved for snippets.
- Tools: multi_edit skips identical old/new edits instead of rejecting the batch; all-no-op batches error without touching the file; a stale-read guard bounces the call when the file changed since the model's last read.
- Tools: todo_write normalizes shape mistakes (duplicate ids, multiple in-progress items, empty titles) and reports repairs instead of failing the call.
- AI: the `<env>` block carries a verified environment inventory — real agent shell + version and installed/absent tool lists, probed once per launch on the Rust side (new `fs_env_inventory` command). Replaces the hardcoded `shell: powershell` assumption.
- AI: write tools mark the project for verification; when a run settles, KAI runs the project's verify command once (`package.json` verify script, `tsc --noEmit`, or `cargo check`) and a failed check wakes the agent with the exact errors as a new message. No per-write latency; no checks on half-edited states.
- Windows: Settings (and any section — General, Sandbox, MCP) opens again — the WebView2 Ceto voice fix was applied to the main window only; a second webview on the same user-data folder with mismatched browser arguments fails with ERROR_INVALID_STATE (0x8007139F), leaving an invisible window that every later click only focused. Both webview builders now share one `WINDOWS_BROWSER_ARGS` constant, and a hidden leftover settings window is destroyed and recreated on open instead of focused.
- AI: a session with a malformed tool part (empty tool name and empty call id, emitted by the SDK when a tool call fails to parse) is recoverable again — the poison part converted to an empty `tool_call_id` and every provider rejected the whole request, permanently: the part lives in persisted history, so Retry re-sent it every time. Malformed tool parts are now dropped before conversion, and the post-conversion sanitizer removes any call/result pair with an invalid or orphaned id.

---

## [1.6.0]

- AI: `look_at_screen` delivers screenshots as image parts; unsupported providers fall back to OCR text.
- AI: `generate_image` results are stripped from model-bound history.
- Tabs: project open switches the workspace and closes the previous project's tabs, with confirmation when editors are dirty.
- Voice: disabled the WebView2 Ceto speech service that 403s in WebView2 Runtime 153+ (WebView2Feedback #5724).
- Editor: word wrap on by default.
- Settings: dialog always opens centered; excluded from window-state save/restore.
- Explorer: hidden files visible by default.
- Office files: read support for DOCX (rich preview) and XLSX/XLSM/XLSB/XLS/ODS (grid preview) in the editor; `read_file` and attachments parse spreadsheets to TSV text.
- Images: new `convert_image` tool — PNG/JPEG/WebP/BMP/GIF conversion, JPEG quality, aspect-preserving downscale, alpha flattened to white.
- Images: `convert_image` operations pipeline — resize, crop, rotate, flip, blur, sharpen, brighten, contrast, hue rotate, grayscale, invert.

---

## [1.5.9]

- Tabs: project open (hamburger > Recent, "Open with KAI") spawns a terminal tab in the project.
- Terminal: blank pane after "+ > New Terminal can no longer wedge — stale hasSlot flag rolls back; render watchdog retries.
- Tabs: close button shown on the last tab.
- UI: "Format Document" menu entry on one row.
- Tabs: "Close others" in the tab context menu.
- Editor: CodeMirror's built-in search bar no longer appears on Ctrl+F; query re-synced before every navigation.
- SCM: git panel refreshes on editor saves and finished terminal commands (OSC 133), debounced.

---

## [1.5.8]

- Tabs: StartPage replaces the launch auto-spawn; closing the last tab is a legal state.
- Tabs: project open keeps every open terminal alive; only local ↔ WSL env switch resets.
- AI: cloud stalls retry automatically (fresh connection), capped at 2 consecutive attempts.
- Voice: mic usable while the agent runs — mid-run recordings land in the steering queue.
- SCM: Open-PR button gated to feature branches; PR base derived from the remote's default branch.
- Windows: paste no longer triggers a stuck native permission prompt — CLIPBOARD_READ allowed in the webview.
- UI: auto-approved tools use the standard dot indicator.
- AI: independent run_subagent calls batch in one step and run concurrently.
- Voice: ⌘/Ctrl+M toggles voice input from anywhere.
- AI: /compact elides tail tool outputs over 500 chars; context ring stays under 100%.

---

## [1.5.7]

- AI: local models that stall at high context recover automatically — endpoint-aware watchdog budgets (10/4 min local, 5/2 cloud), auto-compact, in-session retry.
- Voice: hands-free mode — stopping voice capture submits the transcription under auto-approve.
- Voice: listening/transcribing status moved into the input placeholder.
- AI: slash commands show their outcome under the input bar.
- AI: `/goal` discoverable in the `#` picker and works from both `/` and `#`.
- AI: PowerShell quote-mangling recovery hints cover child-interpreter truncation errors.
- AI: multi-line commit messages go through `write_file` → `git commit -F` on the first try.
- SCM: Publish button enabled on unpublished branches; ahead counted against the default remote's HEAD.

---

## [1.5.6]

- Fixed: updater popup showed no release notes since 1.5.3 — both note parsers accept flat bullets.
- Fixed: voice error banner pushed Dismiss off-screen on long errors.
- AI: `bash_run` timeout ceiling 300s → 1000s; build/cargo/tsc auto-timeout 600s.

---

## [1.5.5]

- AI: `/compact` resets context in place; LM Studio default context budget 32k → 128k.
- AI: agents can register MCP servers (`mcp_add_server` / `mcp_list_servers`).
- SCM: UI-created branches can be published (push -u) and a PR page opened for GitHub/GitLab/Bitbucket.
- AI: PDF/DOCX attachments extract real text (pdfjs/mammoth) via the + button.
- AI: PowerShell quoting guidance in prompt and tool schema; recovery hint on parse errors.
- Fixed: MCP Extensions panel showed literal `Loading…` while the registry loaded.

---

## [1.5.4]

- AI: `look_at_screen` — agent vision on your displays; OCR fallback for text-only models; every capture needs approval.
- AI: local vision models receive the image, detected from the runtime model name.
- AI: Settings → Models Vision override (Auto/On/Off) for local endpoints.
- AI: fixed mid-stream React #185 render-loop crash during multi-tool auto-approve.
- AI: `look_at_screen` cross-platform — macOS permission string, Linux bundle deps, CI build lists.
- Terminal: fixed blank pane on project reopen — renderer bind rolls back and retries.
- Voice: removed bundled local Whisper engine — OpenAI API (whisper-1) with browser Speech API fallback.

---

## [1.5.3]

- Editor: right-click menus no longer stack.
- AI: fixed zombie "agent running" state from stale approval cards; image attachments survive the redirect.
- Git: panel refresh fetches from the remote; pull reports what arrived.
- AI: project memory loads the newest tail of MEMORY.md with a truncation notice.
- AI: fixed mid-stream React #185 crash — approvals defer one macrotask each.

---

## [1.5.2]

- AI: `display_image` elides base64 from tool cards.
- AI: `display_image` and injected commands fall back to the most recent terminal tab.
- AI: base64 tool-call payloads elided from model context after the call.
- AI: same payloads elided from session persistence (512KB store cap).

---

## [1.5.1]

- AI: image attachments no longer vanish on text-only models — swap at request time; transcript keeps the thumbnail.
- AI: fixed attachment extraction (`data:` URLs, absolute temp paths, extension detection); Rust-side OCR cached per image.
- AI: previously-attached images render as placeholder chips after restart.
- AI: amber hint when attaching an image to a model without vision.

---

## [1.5.0]

- Editor: "Format Document" / "Format Selection" with language detection by extension.
- Editor: prettier in-process for JS/TS/JSON/HTML/CSS/Markdown/YAML/GraphQL; `black` for Python when on PATH.
- Editor: selection formatting restores the selection; disabled rows for unsupported extensions.

---

## [1.4.2]

- Voice: selectable local Whisper models (tiny/base/small, English or multilingual); CPU-friendly catalog; timeout scales with recording length; all-cores inference.

---

## [1.4.1]

- Fixed: multi-instance support.

---

## [1.4.0]

- SCM: branch list, switch/create/delete.
- SCM: merge-conflict banner with per-file line locations.
- AI: "Ask KAI to resolve" on the conflict banner.
- AI: session merge (fork into another); "shadow session" relabeled "detached copy".
- AI: watch wake-ups queued while the agent is mid-turn.
- Fixed: stale/missing project memory; memory writing to the detached copy.
- Fixed: blank terminals on project open (ConPTY teardown drain).

---

## [1.3.9]

- Fixed: React #185 render-loop error.

---

## [1.3.8]

- Fixed: in-app updates on Windows — kill-on-close Job Object no longer kills the NSIS installer.
- Fixed: DSML middleware stream stall watchdog.

---

## [1.3.7]

- OpenRouter model list persisted and seeded at startup; failed syncs retry. GLM 5.3 / Flash / FlashX added.
- Error card decodes raw provider errors with a Retry button; frontend errors logged to file.
- About page shows real process uptime.
- Sandbox: dropped the detection-only Docker/devcontainer row.

---

## [1.3.6]

- Added: agent sandbox — policy (`off` / `readOnly` / `workspaceOnly`), OS confinement (bubblewrap / Seatbelt / `kai-sandbox` WSL distro), shadow sessions (conflict-safe merges, 2 GiB cap).
- Added: sandbox badge in the AI session header.
- Fixed: watch results wake the agent when idle.
- Fixed: sandbox gating false-positives on everyday commands.
- Fixed: shadow merge never writes the shadow's `.git` over the real repository.
- Fixed: gitignored build outputs no longer bloat shadow copies.

---

## [1.3.5]

- Checkpoints moved to `~/.kai/`; steering no longer swallowed mid-run; agent shell no longer AV-flagged; context ring matches compaction thresholds; ResizeObserver leak and estimateTokens storm fixed; health counters in About; editable save_memory approvals.

---

## [1.3.4]

- Fixed: Windows double-terminal trigger guard.
- Fixed: image/video rendering in editor; OCR extraction is explicit.

---

## [1.3.3]

- Case-insensitive workspace identity; session-migration backup; startup sweep of stale per-instance artifacts; window title shows the project name; markdown/UI polish.

---

## [1.3.2]

- Multi-instance support — per-process WebView2 profiles, logs, tmp files; per-project sessions and window geometry.

---

## [1.3.1]

- Added: git stashes — list, apply, pop, drop, stash-all.
- Fixed: tool output hides internal fence markers; markdown headings/rules/tables render; fetch/pull/push reliability; `.kai/` gitignored.

---

## [1.3.0]

- Added: privilege-elevated command execution (sudo/runas/UAC); private terminal; agent security hardening.
- Fixed: stop button halts the agent; runaway agents auto-stop; local tokens/sec estimate; compaction notice shown once; sticky focus outlines; commit-signing approvals honored under auto-approve; dead shell recovery; issue-prefill URL length.

---

## [1.2.9]

- Added: one-click issue reporting with logs and crash snapshots; copy-diagnostics button (redacted).
- Changed: image/video generation no longer blocks the chat; ComfyUI video duration defaults 5s.
- Fixed: window title shows `KAI — <project>`.

---

## [1.2.8]

- Fixed: README/markdown preview images render; no console flash opening General settings on Windows; explorer drag-drop inserts relative paths.

---

## [1.2.7]

- Added: local Whisper voice transcription with Silero VAD; optional GPG commit signing; explorer multi-select; drag-drop to terminal.
- Changed: removed AI inline autocomplete.
- Fixed: terminal no longer blanks on heavy startup; badge count tracks the active panel; menu naming.

---

## [1.2.6]

- Fixed: git push/pull error pill capped to short actionable summaries.
- Fixed: watch notifications rendered as markdown via Streamdown.
- Fixed: PowerShell CLIXML decoded in watch output.

---

## [1.2.5]

- Fixed: README images inlined as `data:` URLs in markdown preview; CSP `img-src` widened.
- Fixed: list items not classified as ASCII art.
- Fixed: streaming renders throttled ~12fps (was O(n²) per token).
- Fixed: sessions with an ignored tool approval recover on load.

---

## [1.2.4]

- Fixed: updater dialog scrolls within a capped height; release notes render as markdown.

---

## [1.2.3]

- Fixed: PTY exit deadlock; SSRF bypass via IPv4-mapped IPv6; orphaned shell children killed on timeout; OCR output stem; UNC path canonicalization; MCP stdio quoting on Windows; session races; empty text-block bubbles; session dropdown hydration; updater notes source; stop line suppression; snippet picker scroll; Groq reasoning_effort.

---

## [1.2.2]

- Added: MCP child stderr piped, logged, and forwarded — spawn and exit details logged.
- Fixed: Escape in editor/terminal no longer stops the agent; Git Graph opens the pinned project's history; Stopped status shows a precise finish reason; same-file edits serialized by a per-path mutation lock; MCP stderr truncation no longer panics on multi-byte boundaries.

---

## [1.2.1]

- Added: plain-text table copy; provider errors unwrapped to HTTP status and body; inline session rename; branch pill links to GitHub.
- Fixed: terminal `cd` no longer resets the workspace root (pinned to launch dir); agent continues after compaction with an explicit TASK NOT COMPLETE directive; orphaned thinking markers stripped; ASCII art detection widened; pull no longer double-fetches and forces a merge commit; status pill wraps.

---

## [1.2.0]

- Added: universal file extraction (archives, audio metadata, image dimensions + OCR); text-only model fallback for attachments; updater popup reads CHANGELOG.md.
- Fixed: OCR degrades cleanly without tesseract; session title strips snippet markup; clippy cleanups.

---

## [1.1.9]

- Fixed: internal `_effect`/warning fields stripped from tool results before the model sees them (caused premature stops).
- Added: thinking toggle wired for OpenAI-compatible local models.

---

## [1.1.8]

- Added: nonce-delimited prompt-injection fences around tool output; typed tool outcome statuses (EffectStatus); watch system with condition DSL; four-tier output guard (injection, role, meta, camouflage); trajectory model decoupling persistence from UIMessage; tool irreversibility registry; per-model thinking toggle in the status-bar picker; background shell owner scoping.
- Fixed: normal tool denial no longer aborts the run; dead terminal on project open retried.

---

## [1.1.7]

- Fixed: DSML tool-call leakage on DeepSeek V4 (structural tag matching); `</thinking>` variants handled in the renderer; "Run edited" no longer re-runs the original; `batch_edit` CRLF support; CI clippy `as_chunks`.

---

## [1.1.5]

- Added: auto-fill commit message for single-file changes.
- Fixed: terminal typing sluggish under spawn lock; DSML variants and entity decoding; multi-edit retries per-edit on batch failure; edited commands injected into the PTY directly; SCM ghosted files after commit; Pull handles diverged branches (non-ff merge); native window title; CI clippy cfg gates.
- Changed: SCM status pill restyled.

---

## [1.1.4]

- Added: editable shell-command approval cards.
- Fixed: DeepSeek V4 DSML tool calls on OpenRouter via stream middleware.

---

## [1.1.3]

- Added: per-model thinking modes with provider mappings.
- Fixed: UI freeze from O(n) regex per token; fork uses live messages; Windows voice permissions; stop releases pending approvals; long-context degrader drops old reasoning traces; sessions filtered by workspace root.

---

## [1.1.2]

- Added: `.kai/rules/` ancestor discovery with path-scoped frontmatter; automatic edit checkpoints and `checkpoint_undo`; auto-memory (`save_memory` tool); multi-file atomic `batch_edit`; OSC 1337 `display_image` and parser; agent hooks (`.kai/hooks/`); smart file context auto-attach.
- Fixed: poison-tolerant grep workers; thread spawns return Err; dead code and silent catches logged.

---

## [1.1.1]

- Fixed: tool-call leak after auto-approve toggle; PowerShell `-EncodedCommand` for inline node; multi-edit CRLF corruption.

---

## [1.1.0]

- Fixed: model persistence across workspace switches; title bar shows the project name; attachments counted in token estimates; ESC closes the mini-window only while busy; double-escaped regex; tab drag jitter; nested code fences.

---

## [1.0.9]

- Fixed: denied tool calls no longer retried by the agent; Escape `defaultPrevented` check; PTY/renderer/MCP memory leaks (WebGL dispose, nudge timers, channel handlers, background drop threads).

---

## [1.0.8]

- Added: project folder name in the title bar.
- Fixed: unknown model IDs in saved sessions fall back instead of crashing; missing registry models added; sessions filtered per workspace; stop button active during approvals; native folder picker.

---

## [1.0.6]

- Fixed: store load deserializes only the session list; messages lazy per session; 512KB truncation guard on save.

---

## [1.0.5]

- Fixed: AI panel and mini-window close together; single toggle owns both.

---

## [1.0.4]

- Fixed: agent button opens and closes both windows; TPS pill Infinity guard; dynamic model pricing registration; redundant close button removed.
- Changed: TPS is a separate pill; Privacy/Browse removed from the new-tab menu.

---

## [1.0.3]

- Fixed: agent button is a proper open/close toggle.

---

## [1.0.2]

- Fixed: palette themes auto-derive sidebar/chart/radius variables; theme clearing only removes what was set; redundant applies and self-echoes skipped.

---

## [1.0.0]

- Added: auto-sync OpenRouter model list; latest model additions (GPT-5.6, Claude Opus/Sonnet/Fable 5, Gemini 3.6 Flash, Kimi K3, MiniMax M3, Qwen 3.7 family, and more); sequential approval queue (one interactive, rest queued); leaked tool-call detection with correction nudge; secret-path deny-list on read and write with canonical-path re-check; poison-tolerant state locks.
- Fixed: Stop button cancels running shell commands (`abortSignal`); dangling `<thinking>` regex no longer truncates responses (negative lookahead); `->` operators no longer stripped from code blocks.

---

## [1.0.1]

- Fixed: text no longer truncated after `>` in responses; OpenRouter dynamic models register their real context limits; six model context limits corrected; duplicate GLM 5.2 entries removed; custom instructions textarea bounds; ASCII/Unicode diagrams fenced.

---

## [0.9.5]

- Added: tab split view (all tab kinds) and draggable tabs; subagent step limit exposed in settings (24 default).
- Fixed: `cd` into a subdirectory keeps the chat session; plan-mode system message concatenation; `<thinking>` tags rendered as reasoning pills; editor selection visibility; folder-delete confirmation via ref; prompt redraw on no-output processes.

---

## [0.9.39]

- Fixed: tool-call inputs sanitized to objects before send; orphaned tool_use without tool_result stripped; stuck shell commands force-closed after 3s on cancel; denied-tool-call retry rule in the prompt; chat text wraps.

---

## [0.9.38]

- Fixed: all approval cards clickable during fast edits; Windows folder delete/rename with backslash paths; table download disabled in the webview; chat auto-scrolls on user messages.
- Changed: agent identity decoupled from the persona name.

---

## [0.9.37]

- Fixed: agent stopped before injecting steering messages (orphaned tool_use blocks).

---

## [0.9.36]

- Added: dedicated MCP Settings panel; Snippets settings panel; lazy-loaded settings sections.
- Fixed: MCP store hydration on settings reopen.
- Docs: Claude Code CLI guide in README.

---

## [0.9.35]

- Fixed: `GIT_ASKPASS`/`SSH_ASKPASS` no longer blanked — credential helpers work; terminal CR fallback.

---

## [0.9.34]

- Added: per-project model memory; Save / Save All in the File menu; themed AI input context menu.
- Fixed: Windows startup prompt (ConPTY settle + resize nudge); summarization loop; Anthropic empty-image payloads; Opus context limits; input bar expansion; unstage icon.

---

## [0.9.33]

- Fixed: unsafe transmute replaced with `Arc<AtomicBool>`; per-session CWD sentinel token; PTY final output join deadline 500ms; TodoStrip effect dependency.
- Added: shell resource caps (32 sessions, 16 background).
- Improved: push `expect`, WebGL logging, shared `djb2` hash module.

---

## [0.9.32]

- Added: regex text search in the file-tree explorer with files/content toggle, case sensitivity, inline previews, click-to-line navigation; merge-conflict detection disables Commit and Generate; isolated settings modals.
- Fixed: commit-message generation static imports.

---

## [0.9.31]

- Added: File dropdown menu (New/Open/Recent project, settings shortcuts); native directory picker command per platform.
- Fixed: shortcuts button in the header; DWM shadow disabled on the settings window; clippy `needless_borrows`.

---

## [0.9.30]

- Added: File dropdown menu — New Project, Open Project, Recent (10), settings section shortcuts; platform-agnostic native `pick_project_folder` command.
- Fixed: settings window DWM shadow (thin border).

---

## [0.9.29]

- Added: workspace-scoped AI sessions; deferred hydration until the workspace root resolves; background project claiming for legacy chats; LaTeX arrow token translation.
- Fixed: boot-time session races.

---

## [0.9.28]

- Added: mic and attachment buttons moved to the input bar; local loopback bypasses in the preview proxy; enforced proxy percent-encoding.
- Fixed: mini-window margins standardized; mic-before-add button order.

---

## [0.9.27]

- Added: assistant copy button; project memory guide in README.
- Fixed: expanded chat margins symmetric; header clamp; input-bar padding; fork button alignment.

---

## [0.9.26]

- Fixed: tool-call stripping resilient to unclosed tags.
- Added: README revamp — features, personas, LM Studio and MCP setup guides.

---

## [0.9.25]

- Added: "Open in Live Preview" for .html files (http-server on 5500 + preview tab); auto-close of preview tabs on server stop; inline user image previews.
- Fixed: server port flag for the address-bar stop button.

---

## [0.9.24]

- Fixed: `blob:` in CSP `frame-src` unblocks the PDF viewer.

---

## [0.9.23]

- Fixed: `npx` commands get `--yes`; long commands wrap in tool cards.

---

## [0.9.22]

- Added: Game-of-Life thinking spinner; Escape interrupts in-flight runs and background shells.

---

## [0.9.21]

- Fixed: links open natively via the opener plugin; redundant safety dialog removed.

---

## [0.9.20]

- Added: editable built-in personas with reset; "Assistant" general-purpose agent.
- Fixed: agents view Zustand infinite loop (blank panel).

---

## [0.9.19]

- Added: clipboard image pasting into the AI input; inline upload previews; MCP registry `streamable-http` → `sse` mapping.

---

## [0.9.18]

- Fixed: local model dropdown race ("No models found" before resolution).

---

## [0.9.17]

- Fixed: input-bar height locked to 42px (flush split panel); leaked JSON tool calls and thought markers sanitized.

---

## [0.9.16]

- Added: auto-healing edit guards (hash checks replaced with match-and-apply); stop button embedded in the todo strip; todos auto-complete and dismiss.

---

## [0.9.15]

- Added: `convert_to_pdf` tool (md/txt/docx → PDF) backed by `fs_write_file_bytes`.

---

## [0.9.14]

- Added: Z.ai (GLM) as a first-class provider; Qwen 3.7 Max / Plus models.

---

## [0.9.13]

- Added: custom selection-aware context menu (copy/paste, split layouts, Ask Kai); spellcheck toggles.