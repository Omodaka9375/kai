import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "@fontsource/jetbrains-mono/cyrillic-400.css";
import "@fontsource/jetbrains-mono/cyrillic-700.css";
import "@xterm/xterm/css/xterm.css";
import "./styles/globals.css";

import { getCurrentWindow } from "@tauri-apps/api/window";
import ReactDOM from "react-dom/client";
import App from "./app/AppShell";
import { RootErrorBoundary } from "./lib/RootErrorBoundary";
import { initLaunchDir } from "./lib/launchDir";
import { installConsoleLogBridge } from "./lib/logging";
import { installFocusModalityGuard } from "./lib/focusModality";
import { USE_CUSTOM_WINDOW_CONTROLS } from "./lib/platform";

// First statement AFTER the static import graph evaluated (imports hoist and
// run before module body). The index.html boot trap watches for this flag —
// if it stays unset 10s in, the import graph itself hung/threw and the trap
// shows why on the page.
(window as unknown as Record<string, unknown>).__kaiBooted = true;

installConsoleLogBridge();
installFocusModalityGuard();

if (USE_CUSTOM_WINDOW_CONTROLS) {
  document.documentElement.dataset.chrome = "borderless";
}

// Seed before first paint so default tab mounts at target cwd (no flicker).
// Race with a timeout — a wedged IPC on a cold per-PID WebView2 profile must
// not stop ReactDOM.render from ever running (white window, no terminal).
await Promise.race([
  initLaunchDir(),
  new Promise<void>((resolve) => setTimeout(resolve, 2000)),
]);

const root = document.getElementById("root");
if (!(root instanceof HTMLElement)) {
  throw new Error("KAI app root is unavailable");
}
ReactDOM.createRoot(root).render(
  <RootErrorBoundary surface="main">
    <App />
  </RootErrorBoundary>,
);

// Window starts hidden (per tauri.conf.json) so users never see a transparent
// shadow-only frame before React paints. Use setTimeout — rAF is throttled
// while the window is hidden and would never fire.
const showWindow = () => {
  getCurrentWindow()
    .show()
    .catch((e) => console.error("window.show failed:", e));
};
setTimeout(showWindow, 50);
// Safety net: if the first show somehow fails to take effect, force again.
setTimeout(showWindow, 500);
