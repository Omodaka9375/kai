# Changelog

All notable changes to the KAI terminal emulator project are documented in this file. KAI adheres to Semantic Versioning.

---

## [0.9.28] - 2026-06-20
### Added
*   **Unified Input Bar Controls**: Moved the voice microphone (`Mic01Icon`) and file attachment (`Add01Icon`) buttons from the bottom status bar directly to the left of the user query input text area inside the `AiInputBar`.
*   **Custom Local Loopback Bypasses**: Integrated local network bypasses for `127.0.0.1` and `0.0.0.0` loopbacks in `isLocalUrl` (`PreviewPane.tsx`) and link handlers (`App.tsx`), preventing local server traffic from being routed externally.
*   **Enforced Proxy Percent-Encoding**: Enforced standard percent-encoding on target URLs appended to the preview proxy template to eliminate parameter collisions on the proxy server.
### Fixed
*   **Floating Window Padding Consistency**: Standardized unexpanded `AiMiniWindow` margins to `8px` (`right-2`) and aligned expanded sidebar margins to resolve visual gaps and coordinate spacings beautifully across all window states.
*   **Button Order Flow**: Switched the layout flow of the new input buttons to show the Mic/Voice input control first followed by the Attachment/Add control.

## [0.9.27] - 2026-06-20
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
