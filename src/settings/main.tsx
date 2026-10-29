import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "@fontsource/jetbrains-mono/cyrillic-400.css";
import "@fontsource/jetbrains-mono/cyrillic-700.css";
import "../styles/globals.css";

import { getCurrentWindow } from "@tauri-apps/api/window";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "@/modules/theme";
import { USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { installConsoleLogBridge } from "@/lib/logging";
import { installFocusModalityGuard } from "@/lib/focusModality";
import { setWindowRole } from "@/lib/windowRole";
import { SettingsApp } from "./SettingsApp";

installConsoleLogBridge();
installFocusModalityGuard();
// This webview is a control surface only — it must not own MCP server
// processes (the main window does). See lib/windowRole.ts.
setWindowRole("settings");

if (USE_CUSTOM_WINDOW_CONTROLS) {
  document.documentElement.dataset.chrome = "borderless";
}

const root = document.getElementById("settings-root");
// WebView2 can briefly deliver a script after a navigation/remount without
// the expected app document. React #299 is an invalid container, not an
// Assistant error — fail visibly and quietly instead of taking down the app.
if (root instanceof HTMLElement) {
  ReactDOM.createRoot(root).render(
    <ThemeProvider>
      <SettingsApp />
    </ThemeProvider>,
  );
} else {
  console.error("KAI settings root is unavailable; reload the settings window.");
}

const showWindow = () => {
  getCurrentWindow()
    .show()
    .catch((e) => console.error("settings show failed:", e));
};
setTimeout(showWindow, 50);
setTimeout(showWindow, 500);
