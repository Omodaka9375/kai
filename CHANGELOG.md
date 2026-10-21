# Changelog

All notable changes to the KAI terminal emulator project are documented in this file. KAI adheres to Semantic Versioning.

---
## [1.8.5]

- Security: hardened the agent against prompt injection from web pages and tool output (invisible-character stripping, hidden-DOM removal with visible redaction badges, forged fence/tool-call marker neutralization, memory-provenance tagging).
- AI: fixed the agent silently stopping after a tool call (loop detectors no longer false-positive on normal log-tailing/retries, and now say why they stop).
- AI: screenshots now always require your explicit approval - auto-approve never captures your screen - and "look at my terminal" no longer triggers one.
- Settings: context-size pills for local models; search honors the LAN-only network policy.

---
## [1.8.4]

- Media: Nano Banana 2 image editing — `generate_image` accepts `imagePath` (Google only): the image rides as an inlineData part and the prompt describes the edits (restyle, add/remove objects, composites).
- Media: Veo image-to-video — `generate_video` accepts `imagePath`: Veo animates the image as the opening frame; the prompt describes the motion.
- Assistant: Telegram photo edit/animate — attach a photo and ask ("make this watercolor" / "animate this, slow zoom"); the just-sent photo is the reference image, delivered straight back to the chat.
- AI: fixed the whole-window freeze when clicking a running subagent card — its streamed prompt re-rendered per token with no height cap.
- AI: verify timeouts are inconclusive — a slow-but-green suite no longer wakes the agent in an endless "fix these failures" loop that reloaded the conversation on every run end.
- AI: fixed `can&apos;t` rendering literally in the non-vision paste notice.
- Settings: local/LAN OpenAI-compatible endpoints are first-class — "Local / LAN" labeling, one-click presets (Ollama / llama.cpp / vLLM / LM Studio), LAN-shaped placeholders.
- Installer: Explorer context menu reads "Open with KAI".

---

## [1.8.3]

- AI: opening a file collapses an expanded AI window so the editor is never hidden behind it.
- AI: fast project switches can no longer leave the previous project's conversation on screen.
- Source Control: focusing the window no longer repaints the panel when nothing changed.
- Source Control: header shows a compact sync spinner.
- Extensions: MCP registry search commits on Enter — with a spinner, an uncommitted-input hint, and dimmed results while fetching.
- UI: approval pill reads Ask / Allow.

---

## [1.8.2]

- Security: agent audit trail - append-only.
- Security: LAN-only agent network policy.
- AI: bash_run no longer terminates test runners mid-run.
- Watch: dedup match-mode firings.
- Settings: Security panel reachable from the menu + covered by the window-state denylist.
- Assistant: searchable model picker with its own model override.
- EOL: LF enforced repo-wide (.gitattributes + editorconfig + VS Code).
- Settings: Assistant panel.
- Settings: Security panel "open audit folder" button.
- Security: approval audit events record the tool name.
- AI: pinned "always allow" commands now auto-approve in every mode.
- Security: audit trail panel shows the last 5 events — Open folder for the full history.
- Source Control: fixed the full-panel blink on refresh.
- AI: new `voice_settings` tool — the agent can change the TTS engine (OpenAI/local/off), voice, and model on request.
- AI: "Always allow" no longer over-blocks `~` and `/tmp/` paths.
- AI: the approval pill is two-state (Ask / Auto).
- AI: the `/goal` goal-loop feature removed.
- Terminal: drag-and-drop cross-platform fix.

---

## [1.8.1]

- Watch: fixed a whole-app freeze — a watch firing while the agent was busy re-queued itself into the live wake-up set forever; the scheduler now iterates a snapshot.
- Watch: conditions now evaluate in the packaged app (a stricter script policy had broken every conditional watch after 10 polls); broken conditions self-report the actual reason.
- Tabs: "Open chat" on the start screen now opens the AI panel and mini window together, matching the status-bar agent button.
- AI: write_file refuses to overwrite a file from a truncated read — silent content loss is no longer possible.
- UI: MCP tool calls render clean — `server__tool` labels read as "server: tool name", and MCP result payloads (structuredContent / JSON text parts) pretty-print instead of arriving as escaped one-liners.

---

## [1.8.0]

- Tabs: terminal tabs say “terminal”, not the project folder name (private stays “private”).
- Chat: replies no longer break into raw unstyled text — the </-triggered paragraph deletion in stripLeakedTokens is gone.
- Settings: clicking Assistant opens Assistant — the Rust panel-key validator missed the rename.
- About: uptime only — memory/session rows and the 10s poll removed.
- About: Report an issue sits next to Copy diagnostics on its own row.
- Updater: release notes render at 11px so the changelog fits the dialog.

## [1.7.9]

- Assistant: the External panel is now **Assistant** (menu, sidebar, window).
- Assistant: the Voice replies toggle refuses to turn on until a TTS engine is picked.
- Assistant: replies follow an execution-clarity protocol — past tense, no action+question mixing.
- Agents: selected persona is remembered per project (like the model); legacy global stays as fallback.
- Voice: TTS reads only the final text part — no more step-by-step narration.
- Chat: JSON tool output (MCP results) renders pretty-printed in tool cards.
- Media: missing-key errors tell the user to add a key in Settings → Models or use an MCP server.

## [1.7.8]

- Assistant: Telegram replies no longer silently dropped — event payloads serialize camelCase, pinned by a wire test.
- Assistant: MCP tools with dotted names (`net.ping`) no longer break every reply.
- Assistant: image/video generation is assistant-native on Telegram — delivered straight to the chat.
- Media: Google image gen fixed — Nano Banana 2 model, invalid `responseMimeType` removed.
- Media: Google video gen rewritten to the current Veo REST contract; durations clamped to 4-8s.
- Media: Kling and Seedance native integrations removed — Google Veo only, others via MCP.
- Settings: STT model picker and installer moved into the Speech-to-text section.

## [1.7.7]

- Assistant: /start binding reliable end to end — no dead-channel loops, no zombie poll loops, no per-tool-step chat spam.
- Assistant: IPC contract tests pin the Telegram command argument shapes.

## [1.7.6]

- Assistant: Telegram enable now actually starts the bot; the Owner row updates live in Settings.

## [1.7.5]

- Assistant: fixed saving the Telegram bot token (a wrong argument name failed the keychain write).
- Voice: Auto end mode now engages after changing the setting (stale closure fixed).

## [1.7.4]

- Voice: new Auto end mode — one click to record, silence detection stops it. Turn-based stays default.

## [1.7.3]

- Voice: TTS reads the reply that just finished, not the previous turn's.

## [1.7.2]

- Settings: the File menu now includes External, for Telegram assistant setup.

## [1.7.1]

- AI tools: write_file refuses to overwrite from a partial read — capped reads are tracked.
- AI: watch conditions work in the packaged app (CSP-safe parser).
- Windows/Linux: the window has square corners, matching each platform's native look.
- Assistant: chat with KAI from Telegram — text and voice notes, fenced to a scratch folder, /start binds the owner.
- Assistant: multiple named chats (/new, /sessions, /use), photo input, media delivery, and /watch pings.

## [1.7.0]

- Terminal: display_image works — images render inline in the terminal (JPEG, PNG, GIF, WebP).
- Terminal: new display_video shows a video poster frame inline (uses local ffmpeg).
- AI: Shadow mode — work on an isolated copy of your files with a branched chat, then Apply or Discard.
- AI: subagent cards are clickable — see the prompt while running and the full findings when done.
- AI: watches self-heal — broken conditions and dead shells self-report instead of failing silently.
- AI: removed built-in ComfyUI — local image/video generation belongs in MCP servers now.
- MCP: live status dots and the server version are shown in Settings.
- Settings: each panel opens as its own window; the shared tabbed window is gone.
- Voice: a yellow speaker button appears while the AI speaks — click it to stop.
- Source control: branch switching is instant and the header shows the right branch immediately.
- Sidebar: KAI always opens on the file tree, keeping startup fast.
- Docs: landing page redesigned in a minimal monochrome editorial style.
- Security: hardened the new media tools (safe command building, download limits).

---

## [1.6.9]

- Voice: local STT/TTS fixed on Windows.
- Voice: macOS build fixed; local engines stay Windows/Linux only.
- Voice: OpenAI TTS now speaks (key from keyring, test button, visible errors).
- Voice: picking a TTS mode is the auto-speak opt-in (checkbox removed).
- Voice: long replies are spoken in full.
- Voice: the selected Piper voice (Amy/Lessac) is respected.
- Source control: projects open on the file tree again, stale data cleared, syncing indicator shown.
- Shell: PowerShell backtick mangling fixed in agent commands.
- Status bar: breadcrumb shows the project folder when no terminal is open.

---

## [1.6.8]

- Sessions: switching projects now switches the AI session - the previous project's conversation no longer stays active or pinned in the picker; returning to a project restores its last-active session.
- AI: restored per-project models resolve at launch - the model catalog is seeded at startup and the selection re-announced once dynamic models register.
- AI: reasoning effort patch for compatible-endpoint options; added OpenRouter, DeepSeek, and Z.AI mappings.
- Sandbox: closed the OS-layer escapes.
- Watch: watches fire reliably.
- Voice: new Voice settings section with API and local STT/TTS - whisper.cpp and Piper download on demand; spoken replies are sanitized to prose only.

---

## [1.6.7]

- AI tools: fixed multi_edit looping on "file changed since your last read" - the read cache stored sizes in two units (disk bytes vs character count), so the tool's own previous write falsely tripped the stale guard on any file with non-ASCII content, pushing models to fall back to single edit calls. The guard now compares content hash only, and a stale bounce counts toward the retry cap that points the model at write_file.
- AI tools: multi_edit accepts line_hint to disambiguate repeated old_string values (it was silently dropped by the schema before, causing endless not-unique retries).
- AI tools: batch_edit no longer writes partially applied content to disk when a batch fails validation - validation happens entirely in memory before anything is written, so failures just report the error.
- Header: the project label shows the folder name only (the folder icon was removed).
- AI: removed the multi_edit prompt guidance block - the fixed tool behavior makes the extra instructions obsolete.
- AI tools: run_subagent now asks for user approval before spawning, following the auto-approve mode - auto-runs only in "all" mode, and the approval card gates the model spend, not file safety.
- Radio: the status-bar marquee now shows the live track (artist - title) while playing and scrolls the text only when it overflows.

---

## [1.6.6]

- Header: the current project folder name is shown next to the sidebar toggle.
- Radio: the SomaFM station picker stacks each station's genre under its name, matching the session-picker layout.
- Docs: redesigned the GitHub Pages landing page (animated agent demo, live theme switcher, keyboard-shortcut strip, OS install tabs) and added a keyboard-shortcuts table to the README.
- Shortcuts: the terminal now keeps its shell control keys (Ctrl+R/D/W/E/L/M/...) when it has focus on Windows/Linux - a focused terminal is no longer hijacked by app shortcuts that share the same chord.
- Shortcuts: added Save file (Cmd/Ctrl+S) so it works from anywhere, not just inside the editor.
- Shortcuts: the editor keeps Cmd/Ctrl+F and Cmd/Ctrl+H for its own find/replace when focused.
- Shortcuts: the terminal's delete-word-backward and Shift+Enter (multiline prompt) conveniences are now listed, customizable, and grouped under Terminal.
- Shortcuts: Split pane down now matches Split pane right for non-terminal tabs.
- Shortcuts: added tests for key matching, terminal-collision detection, and registry integrity (no duplicate ids or bindings).

---

## [1.6.5]

- Radio: fixed "Playback rejected (NotSupportedError)" on every station - the CSP media-src allowed SomaFM hosts but not the local icecast proxy URL (http://127.0.0.1) that the audio element actually loads; media-src now allows the proxy, localhost, and SomaFM.
- Build: restored `http://127.0.0.1:*` in the CSP connect-src - it was silently corrupted to a literal `http://*********:*` (dead entry, matches nothing) by an earlier commit.
- Terminal: fixed the blank first terminal when opening one from the StartPage on a cold start (close+reopen used to fix it) - pwsh's DSR cursor query lands in the dormant ring while the renderer slot is still waiting on the font gate, which disarmed the 1.5s CPR reply; first-output classification now runs on both delivery paths and the CPR reply falls back to a truthful 1;1 position when no term buffer exists yet.
- Tests: radio stop teardown no longer triggers an unhandled promise rejection outside Tauri.

---

## [1.6.4]

- Terminal: fixed the intermittent blank first pane — pwsh/PSReadLine blocks on a DSR cursor query (`\x1b[6n`) whose reply intermittently never lands; nudges are no longer disarmed by control-only output and a truthful synthetic CPR reply unblocks the shell (1.5s for the exact signature, 6s last resort).
- Git Graph: commit popover shows the full commit message body (Description section).
- Tabs: ai-diff tab closes on approve/reject (no more lingering tabs).
- Radio: no auto-resume on launch — playback only on explicit action; live ice6 stream URLs.
- Radio: CSP media-src allows SomaFM stream hosts.
- Radio: WebView2 refused live Icecast streams — added a Rust-side local proxy that re-frames the stream as clean chunked HTTP/1.1.
- Radio: Stop playback item in the station picker (keeps the selection).
- Radio: volume is now inline in the status bar — the speaker icon toggles mute directly and a thin slider reveals on hover (no more popover); default volume is 40%; stop moved to its own inline button.
- Build: esbuild postinstall approval via package.json.
- Build: removed placeholder pnpm-workspace.yaml that broke every pnpm command.

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
