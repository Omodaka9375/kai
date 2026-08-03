# Changelog

All notable changes to the KAI terminal emulator project are documented in this file. KAI adheres to Semantic Versioning.

---

## [1.0.5]

### Fixed
- **Close AI panel left AiMiniWindow open**: The conversation toggle icon in the status bar closed the input panel but the chat window stayed visible. Now both close together — `handleToggle` calls `closeMini()` alongside `togglePanel()`.
- **Minimize button on AiMiniWindow competed with status bar toggle**: Removed the minimize-screen button from the mini-window header. The single conversation toggle in the status bar is now the only way to open/close both the panel and mini-window.

---

## [1.0.4]

### Fixed
- **Open agent button didn't open the mini-window**: The "Open agent" button in the status bar only toggled `panelOpen`, but `AiMiniWindow` is controlled by a separate `mini.open` state. The button now opens/closes both the input panel and the chat window together.
- **TPS pill showed "Infinity"**: When the first output token arrived in the same millisecond tick as the stream start timestamp, division by zero produced `Infinity`. Added an `elapsedMs > 0` guard.
- **Session tracker missing cost estimates for dynamic models**: OpenRouter models fetched at runtime had no `MODEL_PRICING` entries, so `estimateCost` returned `null`. Added `registerDynamicPricing` — pricing data is now collected from the API response alongside context limits.
- **X close button on AiMiniWindow redundant**: The close button competed with the status bar toggle. Removed — the mini-window is now controlled exclusively via the "Open agent" / conversation toggle button.

### Changed
- **Tokens/sec moved to separate pill**: The live TPS counter is now a standalone neutral-colored pill to the left of the model name rather than tucked inside the model dropdown trigger.
- **Privacy and Browse removed from new tab menu**: Both options were non-functional or internal-use only. Removed from the `+` dropdown and cleaned up the prop chain.

---

## [1.0.3]

### Fixed
- **Open agent button only opened — never closed**: `AiOpenButton` called `openPanel()` which only sets `panelOpen: true`. Changed to `togglePanel` so it functions as a proper open/close toggle.

---

## [1.0.2]

### Fixed
- **Theme sidebar/chart surfaces didn't match selected palette**: Palette themes only defined main surface variables. Added `deriveAuxiliaryVars()` to auto-generate `--sidebar-*`, `--chart-*`, and `--radius` from each palette's existing colors.
- **Theme clearing looped over all 8 palettes**: `applyUiTheme` now tracks the last-applied keys and only removes exactly what was set.
- **Theme useEffect ran redundant applies**: Added a `lastAppliedRef` guard to skip no-op (id, mode) cycles.
- **Settings window re-applied its own theme change**: `onPreferencesChange` callbacks now compare incoming values with current state to skip self-originated events.

---

## [1.0.1]

### Fixed
- **Text truncated after `>` in agent responses**: A broken regex in `stripLeakedTokens` for stripping `<|im_start|>/<|im_end|>` tokens had an unintended regex alternation that matched _any_ `>` character and stripped everything after it. Fixed the escape sequence so only actual LLM tokens are removed.
- **Dynamic OpenRouter models defaulted to 128K context**: Any model fetched from OpenRouter that wasn't in the hardcoded `MODEL_CONTEXT_LIMITS` fell through to the 128K default — including `deepseek-v4-flash-0731` (which has 1M context). Added a `registerDynamicContextLimits` system that populates context limits from the API response's `context_length` field.
- **Incorrect model context limits**: Verified every API model against official docs and OpenRouter model pages. Corrected 6 models: GPT-4.1-mini 128K→1M, Llama 4 Scout/Maverick 128K→1M, Inkling 524K→1M, GLM 5.1 200K→205K, Kimi K2.5 256K→262K.
- **Bogus GLM 5.2 (1M) model entries**: Z.ai and OpenRouter both use `glm-5.2` as the model ID — the `glm-5.2[1m]` suffix was invalid and caused "model not found" errors. Removed the duplicate entries; 1M context is built into GLM 5.2.
- **Custom Instructions textarea breaks with large text**: The `field-sizing-content` CSS on the Textarea component caused the field to grow unbounded when pasting large prompts, pushing content off-screen. Replaced with fixed height + `overflow-y-auto` scrolling. Added dirty detection (Save only appears on changes), animated "Saved" feedback, and a character counter.
- **ASCII/Unicode diagrams render as single line**: Streamdown/markdown collapses single newlines into paragraphs, turning multi-line box-drawing diagrams into illegible one-liners. Added `wrapAsciiArt()` — detects contiguous blocks of box-drawing characters (U+2500–U+25FF) or ASCII-art line patterns and wraps them in code fences before rendering.
- **Theme sidebar/chart surfaces don't match selected palette**: Palette themes (Emerald, Amber, etc.) only defined main surface variables — sidebar, chart, and border-radius stuck to the Kai default gray. Added `deriveAuxiliaryVars()` that auto-generates `--sidebar-*`, `--chart-*`, and `--radius` from each palette's existing colors.
- **Theme clearing looped over all 8 palettes**: `applyUiTheme` destructively cleared every CSS variable from every theme on each application. Now tracks the last-applied keys and only removes exactly what was set.
- **Theme useEffect ran redundant applies**: System dark-mode toggle or cross-window event echoes triggered `applyUiTheme` even when the (id, mode) pair hadn't changed. Added a `lastAppliedRef` guard to skip no-op cycles.
- **Settings window re-applied its own theme change**: The cross-window `PREFS_CHANGED_EVENT` listener in `ThemeProvider` applied changes even when the current window was the originator. Added a value comparison guard in `onPreferencesChange`.

### Changed
- **Deterministic session state replaces model-based summarization**: Context summarization (`summarize.ts`) called `generateText` with the user's model, which could fail if the model had a small context window (recursive problem). Replaced with `buildSessionState` — a zero-cost `<session_state>` block built from `fileTracker`, `todoStore`, and lightweight regex error extraction. No API call, no model dependency, no failure modes.
- **Removed unreliable auto-nudge logic**: The `shouldAutoNudge` heuristic often fired on legitimate model completions, injecting unwanted "Continue" messages. Removed entirely along with `hasLeakedToolCall` usage and the nudge counter.
- **Removed summarization spinner and notice**: Since `buildSessionState` is synchronous, the "Compressing context…" spinner and "Context summarized" notice are no longer needed. Removed along with `summarize.ts` file.
- **Progressive context compaction thresholds**: Lowered stall-read dropping from 50% to 40%, added tool-result truncation at 60%, and lowered summarization trigger from 90% to 75% of effective context limit. All phases now use the unified `contextLimit - 18K` effective limit.
- **Token-based gate replaces message-count gate**: The old `MIN_MESSAGES_FOR_SUMMARY = 12` guard prevented summarization on short conversations with huge tool results (e.g. reading a 200KB file in 3 messages). Now uses a 16K token-estimate floor.

### Added
- **Free model detection & tag**: OpenRouter models with zero pricing or `:free` suffix are now tagged with a green `FREE` badge in the model picker dropdown. Detection runs during the dynamic model fetch.
- **Live output tokens/sec in status bar**: The model name in the bottom bar now shows a live `123 tok/s` counter during streaming, computed from cumulative output tokens ÷ elapsed time since first token.
- **Context pressure API for tools**: Added `getRemainingContextTokens()` to `ToolContext`, allowing tools to auto-truncate responses when context is tight.
- **"None" agent persona option**: Added a `__none__` sentinel to the agent picker. When selected, `getAgentPersona` returns `null` and the `## ACTIVE AGENT` block is omitted from the system prompt — the model sees only the base system prompt + custom instructions.

### Removed
- **Close AI panel keyboard shortcut pill**: The `Ctrl+I` shortcut pill in the status bar is gone. The conversation icon now toggles the AI panel open/closed.

---

## [1.0.0]

### Added
- **Auto-sync OpenRouter model list**: KAI now periodically fetches the full OpenRouter model catalog and merges it with the hardcoded model list, so models like `deepseek-v4-flash-0731` and other newly released variants never need a manual update.
- **Latest model additions**: Added GPT-5.6 family (Sol, Terra, Luna), Claude Opus 5 / Sonnet 5 / Fable 5, Gemini 3.6 Flash, Kimi K3, MiniMax M3, Qwen 3.7 Flash/Max/Plus, Gemini 3.5 Flash Lite, Laguna S 2.1, Inkling, LongCat 2.0, Grok Build 0.1.
- **Sequential approval queue**: When an agent step emits multiple approval-required tool calls, only the first is interactive — the rest render as compact "queued" chips and unlock one at a time as the user responds.
- **Leaked tool-call detection**: Small/local models that emit raw tool-call markup as plain text are now detected and the model is automatically corrected with a nudge to use native function calling.
- **Comprehensive AI safety layer**: Added a deny-list refusing obvious secret paths (`.env`, `.ssh/`, credentials) on both read and write paths, with canonical-path re-check to catch symlink traversal.
- **Poison-tolerant state locks**: Replaced all bare `.unwrap()`/`.expect("poisoned")` calls on shared `Mutex`/`RwLock` with poison-recovering wrappers so one panicking thread doesn't take down every PTY/shell/git command.

### Fixed
- **STOP button now cancels running shell commands**: `bash_run` and `bash_background` respect `abortSignal` — pressing Stop or Esc kills in-flight shell processes.
- **Over-aggressive thinking-tag regex truncated responses**: The `<thinking>` dangling-tag regex consumed everything from the tag to end-of-string in legitimate responses. Fixed with a negative lookahead for a closing `</thinking>` before stripping.
- **Code block content truncated around `->` operators**: Fixed regex patterns that incorrectly matched `->`/`->>` as partial tool-call tokens and stripped them from code blocks.
- **New folders not appearing in file tree**: Agent-created directories now trigger a file tree refresh so they appear immediately without manual reload.
- **Wide pastes breaking AI input layout**: The AI input textarea now properly constrains its width, preventing horizontal overflow when pasting long lines.
- **Race conditions and unbounded loops in AI pipeline**: Fixed several edge cases that could cause infinite loops or stale state in the agent's message processing.
- **Agent SSRF hole in HTTP proxy**: Closed a DNS-rebinding vector by pinning reqwest's resolver to the IPs classified during host validation, and added per-hop redirect re-checking.
- **Removed annoying error toast popup**: The "Ask Kai to fix" toast that appeared on every error is gone — errors are now shown inline in the chat.

### Removed
- **Non-functional Agent Orchestrator prototype**: The Agent Orchestrator panel and its backend were removed — they were unreachable and contained dead code paths.
- **`tsforge` gate tool and `enableGateRollback`**: Removed an unused LLM security analysis tool and its rollback mechanism.

### Changed
- **Shortcut wiring extracted from App.tsx**: Keyboard shortcut definitions and registration moved to dedicated modules, keeping `App.tsx` as a thin coordinator.
- **Simplified edit tools**: The edit tool implementations were streamlined for better reliability and fewer edge cases.

---

## [0.9.5]
### Added
- **Tab split view**: Right-click any tab to open it as a side-by-side split panel. All tab kinds supported (terminal, editor, preview, git diff, API tester, markdown preview). Terminal tabs additionally offer "Split pane right / down" to split within the tab itself.
- **Draggable tabs**: Tab bar tabs can now be dragged left and right to reorder them.
- **Subagent step limit setting**: Subagent max steps doubled from 12 → 24 and exposed as a configurable field in Agent Settings (range 1–200).

### Fixed
- **Chat session reset on `cd`**: Navigating into a subdirectory of the current project no longer triggers a new chat session. The session switcher now treats any path that starts with the session's project root as the same project.
- **Plan Mode "System message must be at the beginning" error**: The plan mode prompt was appended as a second `system` role message, which most non-Anthropic providers reject. It is now concatenated into the single system message.
- **`<thinking>` tags leaking into chat**: Models that emit raw `<thinking>…</thinking>` in their text stream (DeepSeek, Qwen, etc.) now have those blocks extracted and rendered as collapsible reasoning pills, matching the behaviour of native `reasoning` parts. Dangling open tags and pipe-delimited variants are also stripped.
- **Editor text selection invisible**: Selection highlight in the CodeMirror editor was using `var(--foreground)` at 18% opacity, which blended into the background on dark themes. Raised to 28% (focused) / 14% (unfocused) and split into separate selectors so the two states are visually distinct.
- **Folder delete via right-click did nothing**: The two-click confirmation used `useState`, which caused a React re-render that replaced the menu item's DOM node and fired a synthetic `mouseleave`, resetting the confirmation state before the second click could land. Confirmation state is now tracked in a `useRef` so no re-render occurs on first click; `e.preventDefault()` is only called on the first click, allowing the second click to close the menu naturally after deleting.
- **Terminal prompt overwrites last line after stopping a server**: When a process exits without a trailing newline (e.g. Ctrl+C on a dev server), PowerShell's prompt function now checks `[Console]::CursorLeft` and emits a newline + inverted-video `%` marker before drawing the prompt, matching the zsh `PROMPT_CR` convention.

## [0.9.39]
### Fixed
*   **"Input should be an object" API Error**: Added a post-conversion `sanitizeModelMessages` pass that coerces `null`/`undefined`/non-object `tool-call` inputs to `{}` before sending to the provider, preventing Anthropic's `tool_use.input: Input should be an object` rejection.
*   **Orphaned tool_use Without tool_result**: The same sanitizer now strips any `tool-call` parts that have no matching `tool-result` anywhere in the conversation, catching edge cases that `stripIncompleteToolCalls` and `ignoreIncompleteToolCalls` miss after session restore or mid-stream stops.
*   **Stuck Shell Commands Unrecoverable**: When `cancelAllShellSessions` fires (Esc / Stop), it now force-closes the shell session after a 3-second grace period and clears the session cache, so a stuck command doesn't permanently block the agent — the next run gets a fresh shell.
*   **Denied Edit Causes Retry Loop**: Added a `DENIED TOOL CALLS` rule to the system prompt instructing the model to never retry a denied/rejected tool call and to ask the user what to do instead.
*   **Pasted Text Not Wrapping in Chat**: Added `overflow-wrap-anywhere` to both the user message `<p>` and the `MessageContent` container so long formatted text, URLs, and code snippets wrap correctly inside the AI mini window.

## [0.9.38]
### Fixed
*   **Approval Cards Unresponsive During Fast Edits**: When multiple edit approvals spawned in quick succession, only the last card was clickable. Removed `onRespond` from the `AiToolApproval` memo comparator — the inline closure caused rapid function-identity churn during streaming that prevented earlier cards from responding to clicks.
*   **Folder Delete & Rename Broken on Windows**: The `dirname()` helper in the file explorer only searched for `/` separators, causing folder delete and rename operations to fail on Windows backslash paths. Now splits on both `/` and `\`.
*   **Table Download Button Non-Functional**: The download button on markdown tables (from Streamdown) used blob-URL anchor clicks, which don't trigger real downloads inside Tauri's webview. Disabled the table download control; copy and fullscreen still work.
*   **Agent Chat Not Auto-Scrolling on User Message**: When the user sent a new message while scrolled up, the AI mini window didn't scroll to show the new message or the agent's response. Added a `contextRef`-based scroll-to-bottom trigger on new user messages.
### Changed
*   **Agent Identity Decoupled from Persona**: Changed the system prompt from "You are Kai" to "You are an AI agent embedded in a developer terminal emulator called Kai", so custom agent personas aren't overridden by a hardcoded identity.

## [0.9.37]
### Fixed
*   **Stop agent before injecting steering message**: Prevents orphaned tool_use blocks from reaching the API
when the user redirects the agent mid-run.
## [0.9.36]
### Added
*   **Dedicated MCP Settings Panel**: The "MCP Servers" entry in the File menu now opens its own isolated Settings window showing only the MCP server management section — add, edit, toggle, and remove servers without navigating through the full settings UI.
*   **Dedicated Snippets Settings Panel**: Added a new "Snippets" entry to the File menu that opens a focused Settings window for creating and managing reusable prompt snippets (`#handle` tokens).
*   **Lazy-Loaded Settings Sections**: All settings sections are now loaded on demand via `React.lazy`, so opening any isolated settings panel only fetches the code for that specific section — dramatically faster window open times, especially in dev mode.
### Fixed
*   **MCP Store Hydration Staleness**: Fixed MCP server configs not reflecting the latest saved state when the settings window reopened, ensuring fresh data is always loaded from disk.
### Docs
*   **Claude Code CLI Guide**: Added a README section explaining how to use a Claude subscription via the Claude Code CLI directly inside KAI's terminal.

## [0.9.35]
### Fixed
*   **Git Credential Helpers Restored**: Stopped blanking `GIT_ASKPASS` and `SSH_ASKPASS` environment variables in git subprocess calls. Non-interactive credential helpers (Git Credential Manager, ssh-agent) now work correctly for push, pull, and fetch operations.
*   **Terminal CR Fallback**: Improved carriage return handling in terminal session initialization to prevent edge-case prompt rendering issues.

## [0.9.34]
### Added
*   **Per-Project Model Memory**: KAI now remembers the last AI model selected in each project. When you reopen a workspace, it automatically restores the model you were using — no more reselecting every time you switch projects.
*   **Save & Save All in File Menu**: Added Save (active dirty editor) and Save All (all unsaved editors, `Ctrl+Shift+S` / `⌘⇧S`) actions to the File dropdown menu.
*   **Themed AI Input Context Menu**: Right-clicking the AI input textarea now shows a custom themed context menu (Undo, Redo, Cut, Copy, Paste, Select All) matching the app's visual style, replacing the unstyled native browser menu.
### Fixed
*   **Shell Prompt Not Appearing on Startup (Windows)**: Fixed an intermittent issue where PowerShell (and other shells) would show only a blinking cursor on launch with no prompt. Added a ConPTY settle delay between sequential PTY spawns to prevent output pipe stalls, and a fallback resize nudge that triggers a prompt redraw if no output is received within 3 seconds.
*   **AI Summarization Loop**: Fixed a bug where the "Context summarized" notice would trigger on every subsequent agent step instead of just once. The Chat instance now adopts the trimmed message history after summarization, preventing redundant re-summarization.
*   **Image Paste Crash on Anthropic**: Fixed `image.source.base64: image cannot be empty` errors when sending messages with images to Claude. Stripped image placeholders from persisted sessions are now silently dropped instead of being sent as broken empty payloads.
*   **Claude Opus Context Limits**: Corrected the context window for Claude Opus 4.6, 4.7, and 4.8 from 200K to the actual 1 million token limit.
*   **AI Input Bar Overflow**: The AI input textarea now properly expands up to 2 lines and scrolls beyond, instead of pushing the entire workspace layout upward.
*   **Source Control Unstage Icon**: Fixed the unstage button icon and guarded recent projects persistence behind preferences hydration.

## [0.9.33]
### Fixed
*   **Unsafe Lifetime in Shell Sessions**: Eliminated an unsound `unsafe` block that transmuted a raw pointer to `'static` for the cancel flag in agent shell sessions. Now uses a safe `Arc<AtomicBool>` clone moved into the worker thread.
*   **CWD Sentinel Collision**: Replaced the static `__KAI_CWD__` sentinel with a per-session random token (timestamp + pid + counter) so command output can never accidentally or maliciously corrupt the agent shell's working directory tracking.
*   **PTY Final Output Loss (Windows)**: Increased the reader-thread join deadline from 50ms to 500ms with an unconditional `join()` fallback, preventing the last chunk of terminal output from being silently dropped on ConPTY child exit.
*   **TodoStrip useEffect Dependency**: Changed the auto-collapse effect dependency from a boolean expression (`todos.length > 5`) to the numeric length value, fixing a subtle React hook correctness issue.
### Added
*   **Shell Resource Caps**: Added limits of 32 concurrent agent shell sessions and 16 background processes. Exited background processes are auto-reaped before the cap is checked, and clear error messages are returned when limits are hit.
### Improved
*   **Git Push Safety**: Replaced a bare `unwrap()` in the git push path with an annotated `expect()` for clearer panic context if the upstream invariant is ever violated.
*   **WebGL Error Traceability**: Added `console.debug` logging to 7 previously silent `catch {}` blocks in the terminal renderer pool, covering WebGL context loss, addon disposal, and OSC handler teardown.
*   **DRY Hash Utility**: Extracted the duplicated `djb2` hash function from `tools/fs.ts` and `tools/edit.ts` into a shared `ai/lib/hash.ts` module.

## [0.9.32]
### Added
*   **Global Text Search in File Tree**: Integrated a fully functional, regex-powered text search inside your workspace files (`fs_grep`) inside the File Explorer search panel.
    *   **Files vs Content Toggles**: Easily switch between searching for matching file names and searching for matching lines of text inside files.
    *   **Case Sensitivity**: Toggles exact casing matches using the native `"Aa"` button (mimicking VS Code).
    *   **Inline Context Previews**: Displays file hits as `filename.ext:line` with matching line snippets rendered inside a beautifully styled inline code block below the filename.
    *   **Smooth Navigation**: Clicking any text match opens the file and instantly scrolls the editor centered directly to that specific line number.
*   **Source Control Merge Conflict Safety**: Automatically detects unresolved merge conflicts inside the active working tree.
    *   **Conflicts Alert Banner**: Displays a prominent red warning banner at the top of the SCM list notifying you of active conflicts.
    *   **Committed Safeguards**: Disables both the **Commit** button and the **Generate Commit Message** buttons whenever unresolved conflicts are present on disk.
*   **Isolated Settings Modals**: The File menu setting shortcuts now launch a focused settings window that hides the main TabsList navigation bar entirely, acting as a clean, consistent, dedicated modal.
### Fixed
*   **SCM Message Generation Crashes**: Restructured the `generateCommitMessage` handler to statically import dependencies, resolving runtime webview dynamic import failures.

## [0.9.31]
*   **Top Bar Button Swapping**: Swapped the Keyboard Shortcuts help button directly into KAI's top-right header action row, replacing the redundant Settings button there.
*   **DWM Shadow Clashes Resolved**: Disabled standard Windows Desktop Window Manager (DWM) shadows on the settings tauri window builder to resolve the thin square border clashing with custom HTML rounded corners.
### Fixed
*   **Needless Borrows Warnings**: Resolved modern Clippy compiler warning failures (`needless_borrows_for_generic_args`) on platform-specific string array slice inputs inside Tauri's Rust lib builder.

## [0.9.30]
### Added
*   **File Dropdown Menu**: Added a custom, project-focused File Dropdown Menu in the top-left of KAI's header.
    *   **New Project**: Prompts the developer to pick a parent directory, inputs the project name, creates the subfolder on disk, and automatically opens KAI inside the new workspace.
    *   **Open Project**: Invokes a native system directory picker to open KAI focused on any project directory on your machine.
    *   **Recent**: Maintains a dynamic log of the 10 most recently opened projects/folders in `localStorage`, showing folder names and full paths.
    *   **Settings Section Shortcuts**: Connects drop-down actions to directly launch KAI's Settings window opened to the Models, Agents, Shortcuts, Appearance (General), and About tabs.
*   **Native Directory Dialog Picker**: Introduced a platform-agnostic `pick_project_folder` command in `lib.rs` (using PowerShell on Windows, AppleScript POSIX choice on macOS, and Zenity/kdialog on Linux) to trigger native directory browsers with zero external crate dependencies.
### Fixed
*   **Settings Window Shadow (Windows)**: Disabled DWM (Desktop Window Manager) window shadow (`.shadow(false)`) on the settings `WebviewWindowBuilder` in `src-tauri/src/lib.rs` to prevent Windows from drawing an ugly, thin 1px square border behind the rounded settings window.

## [0.9.29]
### Added
*   **Workspace-Scoped AI Sessions**: Partitioned and scoped chat sessions on the active project directory (`workspaceRoot`). Session switches and list dropdowns in `AiMiniWindow` automatically filter based on the current workspace context.
*   **Late Workspace Hydration**: Resolved boot-time session initialization race conditions by deferring chat state hydration until the local workspace root is fully resolved, and passing it dynamically on boot.
*   **Auto-Claiming Legacy Chats**: Implemented a background project-claiming system. Any workspace-less or legacy sessions opened in a project are automatically converted and associated with that specific workspace path.
*   **LaTeX Math Arrow Parsing**: Enhanced token sanitization (`stripLeakedTokens`) in `AiChat.tsx` to automatically parse and translate LaTeX arrow strings (e.g., `\rightarrow`, `\to`, etc.) into clean Unicode equivalents (`→`, `←`, etc.).

## [0.9.28]
### Added
*   **Unified Input Bar Controls**: Moved the voice microphone (`Mic01Icon`) and file attachment (`Add01Icon`) buttons from the bottom status bar directly to the left of the user query input text area inside the `AiInputBar`.
*   **Custom Local Loopback Bypasses**: Integrated local network bypasses for `127.0.0.1` and `0.0.0.0` loopbacks in `isLocalUrl` (`PreviewPane.tsx`) and link handlers (`App.tsx`), preventing local server traffic from being routed externally.
*   **Enforced Proxy Percent-Encoding**: Enforced standard percent-encoding on target URLs appended to the preview proxy template to eliminate parameter collisions on the proxy server.
### Fixed
*   **Floating Window Padding Consistency**: Standardized unexpanded `AiMiniWindow` margins to `8px` (`right-2`) and aligned expanded sidebar margins to resolve visual gaps and coordinate spacings beautifully across all window states.
*   **Button Order Flow**: Switched the layout flow of the new input buttons to show the Mic/Voice input control first followed by the Attachment/Add control.

## [0.9.27]
### Added
*   **Assistant Copy Response Button**: Added a beautifully styled copy button to assistant messages that appears on hover and provides inline clipboard success states.
*   **Project Memory Guide**: Included an instructional guide section for local `Kai.md` persistent memory configuration inside the main `README.md`.
### Fixed
*   **Symmetrical Expanded Chat Margins**: Positioned the expanded `AiMiniWindow` left and right edges symmetrically (8px) and bound the bottom edge dynamically to the active input bar height.
*   **Header Separation Bounds**: Clamped the maximum height of the unexpanded floating `AiMiniWindow` to prevent overlaps with KAI's header/top bar.
*   **Input Bar Margins**: Isolated the sidebar-collapsed left padding from bleeding into the docked `AiInputBar`, allowing it to span flush with window margins.
*   **Fork Button Alignment**: Redesigned and aligned the conversation fork button directly to the left of user message bubbles with pristine border/background transition effects on hover.

## [0.9.26]
### Fixed
*   **Resilient Tool Call Stripping**: Made the tool-call sanitization regexes resilient to unclosed or partial tags at the end of the text stream to prevent leaked formatting.
### Added
*   **Documentation Revamp**: Updated `README.md` with new feature listings, detailed built-in agent personas, and setup guides for local models (LM Studio) and Model Context Protocol (MCP) servers.

## [0.9.25]
### Added
*   **Open in Live Preview**: Added a right-click context menu option for `.html` / `.htm` files inside the file explorer. Spawns an automated `npx --yes http-server` on port `5500` serving the folder, and automatically launches a connected Web Preview tab pointing directly to the file.
*   **Auto-Closing Preview Tabs**: Integrated a reactive tab-closing trigger. Clicking the "Stop server" button in the address bar now automatically terminates the server and closes your active preview tab.
*   **Inline User Image Previews**: Users' uploaded or pasted clipboard images now render as responsive image cards directly inside user message bubbles in the chat log.
### Fixed
*   **Live Server Port Mapping**: Changed the server port parameter from `-p 5500` to `--port 5500` inside the launch script, enabling KAI's address bar to match and display the red "Stop server" button successfully.

## [0.9.24]
### Fixed
*   **Security & PDF Previews**: Added `blob:` to the `frame-src` directive in the application Content Security Policy (CSP). This successfully unblocks the PDF viewer iframe, allowing generated and converted PDF documents to load natively.

---

## [0.9.23]
### Fixed
*   **Programmatic Shell Resilience**: Automatically append the `--yes` (`-y`) confirmation flag to any `npx` commands run by the AI agent to prevent interactive package-install prompts from freezing the background shell session.
*   **CLI Card Layouts**: Applied `whitespace-pre-wrap` styling to long terminal/shell commands in tool execution detail containers to ensure they wrap beautifully within the width of the panel.

---

## [0.9.22]
### Added
*   **Conway's Game of Life Thinking Spinner**: Replaced the generic loading indicator in the chat stream with an interactive, toroidal 1D Game of Life cellular automaton that animates on a single monospace line while the model is thinking.
*   **Esc-Key Streaming Interrupt**: Integrated a global keyboard listener on the `Escape` key inside the agent window. Pressing `Esc` now instantly cancels in-flight agent streaming runs and halts running background shell processes, saving API tokens.

---

## [0.9.21]
### Fixed
*   **Native Link Opening**: Disabled the redundant, clipped, and non-functional third-party link safety dialog box. Links clicked inside the chat or Markdown preview panes now natively open instantly inside your default system browser via the Tauri opener plugin.

---

## [0.9.20]
### Added
*   **Editable Built-in Personas**: Enabled full customization of built-in agent prompts (like *Coder* or *Architect*) through local database overrides, complete with a "Reset to default" restore action.
*   **General Assistant Agent**: Added a new built-in non-coding `"Assistant"` agent persona, optimized specifically for writing, copyediting, brainstorming, and general text tasks.
### Fixed
*   **Zustand Infinite Loop**: Replaced a reference-unstable state selector in the custom Agents view with a reactive `useMemo` block, resolving a critical React thread lock that caused the panel to freeze blank.

---

## [0.9.19]
### Added
*   **Multimodal Clipboard Image Pasting**: Users can now copy any image (such as standard screenshots or crops) and paste them directly into the AI input bar with `Ctrl+V`, which attaches them instantly as native visual media chips.
*   **User Upload Previews**: Attached and pasted images are now fully rendered as inline image cards inside your user chat bubbles.
*   **MCP Registry Installations**: Corrected registry package parsing to map `streamable-http` remote connections to `"sse"` transport type, unblocking click-to-install actions for official MCP servers.

---

## [0.9.18]
### Fixed
*   **Local Model Fetching**: Corrected a race condition inside the settings dropdown trigger that caused the panel to open prematurely and report "No models found" before the network query had resolved.

---

## [0.9.17]
### Fixed
*   **Interface Sizing Alignment**: Aligned the horizontal top border of the AI input bar with the sidebar rail by locking the empty input area height to exactly `42px`, resulting in a continuous, flush split-panel layout.
*   **Thinking Token Sanitization**: Added a comprehensive regex parser to clean up leaked raw JSON tool calls, thought markers, and streaming delimiters (such as `<|"|>`) from rendering inside your chat messages.

---

## [0.9.16]
### Added
*   **Auto-Healing Edit Guards**: Replaced strict lockfile-style hash checks on file modifications. The edit tool now automatically heals and syncs its state, applying replacements directly to the fresh on-disk content as long as the targeted old strings match.
*   **Tucked-In Stop Button**: Cleaned up the large red absolute floating action button by embedding a smaller, subtle, and context-aware gray Stop button directly inside the active `TodoStrip` progress row.
*   **Automated Todo Completion**: The todo list now automatically runs a cleanup action, closing and removing itself from the agent window once all listed tasks are checked off.

---

## [0.9.15]
### Added
*   **Direct PDF Writer (`convert_to_pdf`)**: Introduced a native agent tool to convert `.md`, `.txt`, and `.docx` files directly into styled, paginated, and beautifully typeset PDF documents, backed by a new binary file-writing Tauri Rust command (`fs_write_file_bytes`).

---

## [0.9.14]
### Added
*   **Direct Z.ai (GLM) Integration**: Integrated Z.ai (Zhipu AI) as a first-class, dedicated cloud provider with keys stored securely in your OS keychain.
*   **Model Upgrades**: Upgraded the curated OpenRouter model selection list to replace deprecated Qwen models with the flagship `Qwen 3.7 Max` and `Qwen 3.7 Plus`.

---

## [0.9.13]
### Added
*   **Custom Context Menu**: Implemented a modern, selection-aware context menu on right-click inside the terminal and text editor views, featuring quick actions for copy/paste, split layouts, and Ask Kai.
*   **Selection Filters**: Added boundary selection filters and native spellcheck toggles.
