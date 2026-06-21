# Changelog

All notable changes to the KAI terminal emulator project are documented in this file. KAI adheres to Semantic Versioning.

---
## [0.9.31]
### Added
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
