import { WindowControls } from "@/components/WindowControls";
import { IS_MAC, USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import type { SettingsTab } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  AiScanIcon,
  InformationCircleIcon,
  PuzzleIcon,
  Settings01Icon,
  SparklesIcon,
  UserMultiple02Icon,
  KeyboardIcon,
  Shield01Icon,
  Mic01Icon,
  GlobeIcon,
} from "@hugeicons/core-free-icons";
import { lazy, Suspense, useEffect } from "react";

const GeneralSection = lazy(() => import("./sections/GeneralSection").then((m) => ({ default: m.GeneralSection })));
const ShortcutsSection = lazy(() => import("./sections/ShortcutsSection").then((m) => ({ default: m.ShortcutsSection })));
const ModelsSection = lazy(() => import("./sections/ModelsSection").then((m) => ({ default: m.ModelsSection })));
const AgentsSection = lazy(() => import("./sections/AgentsSection").then((m) => ({ default: m.AgentsSection })));
const SnippetsSection = lazy(() => import("./sections/SnippetsSection").then((m) => ({ default: m.SnippetsSection })));
const McpSection = lazy(() => import("./sections/McpSection").then((m) => ({ default: m.McpSection })));
const SandboxSection = lazy(() => import("./sections/SandboxSection").then((m) => ({ default: m.SandboxSection })));
const SecuritySection = lazy(() => import("./sections/SecuritySection").then((m) => ({ default: m.SecuritySection })));
const VoiceSection = lazy(() => import("./sections/VoiceSection").then((m) => ({ default: m.VoiceSection })));
const ExternalSection = lazy(() => import("./sections/ExternalSection").then((m) => ({ default: m.ExternalSection })));
// "Assistant" panel — file kept as ExternalSection.tsx (renaming would churn
// the denylist/window-state keys); id changed external → assistant.
const AboutSection = lazy(() => import("./sections/AboutSection").then((m) => ({ default: m.AboutSection })));

type TabDef = { id: SettingsTab; label: string; icon: typeof Settings01Icon; component: React.LazyExoticComponent<() => React.JSX.Element> };

const TABS: TabDef[] =
  [
    { id: "general", label: "General", icon: Settings01Icon, component: GeneralSection },
    { id: "shortcuts", label: "Shortcuts", icon: KeyboardIcon, component: ShortcutsSection },
    { id: "models", label: "Models", icon: AiScanIcon, component: ModelsSection },
    { id: "agents", label: "Agents", icon: UserMultiple02Icon, component: AgentsSection },
    { id: "snippets", label: "Snippets", icon: SparklesIcon, component: SnippetsSection },
    { id: "mcp", label: "MCP Servers", icon: PuzzleIcon, component: McpSection },
    { id: "sandbox", label: "Sandbox", icon: Shield01Icon, component: SandboxSection },
    { id: "security", label: "Security", icon: Shield01Icon, component: SecuritySection },
    { id: "voice", label: "Voice", icon: Mic01Icon, component: VoiceSection },
    { id: "assistant", label: "Assistant", icon: GlobeIcon, component: ExternalSection },
    { id: "about", label: "About", icon: InformationCircleIcon, component: AboutSection },
  ];

const VALID_TABS: SettingsTab[] = [
  "general",
  "shortcuts",
  "models",
  "agents",
  "snippets",
  "mcp",
  "sandbox",
  "security",
  "voice",
  "assistant",
  "about",
];

function readInitialTab(): SettingsTab {
  if (typeof window === "undefined") return "general";
  const url = new URL(window.location.href);
  const t = url.searchParams.get("tab");
  if (!t) return "general";
  const cleanTab = t.split("&")[0];
  // Back-compat: legacy "ai" / "connections" → "models".
  if (cleanTab === "ai" || cleanTab === "connections") return "models";
  if ((VALID_TABS as string[]).includes(cleanTab)) return cleanTab as SettingsTab;
  return "general";
}

/**
 * Every settings panel opens as its OWN window (one per panel — the old
 * shared tab-strip Settings window is gone), so the app is permanently in
 * "isolated" mode: the header shows the panel title instead of a tab bar
 * and there is no in-window tab switching.
 */
export function SettingsApp() {
  const active = readInitialTab();
  const init = usePreferencesStore((s) => s.init);
  const ActiveSection = TABS.find(t => t.id === active)?.component;

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground select-none">
      <header
        data-tauri-drag-region
        className={`flex h-11 shrink-0 items-center border-b border-border/60 bg-card/60 ${IS_MAC ? "pr-3 pl-22" : "pr-0 pl-3"
          }`}
      >
        <div className="flex-1 px-3 text-[12.5px] font-semibold text-foreground tracking-tight" data-tauri-drag-region>
          {TABS.find((t) => t.id === active)?.label ?? "Settings"}
        </div>
        {USE_CUSTOM_WINDOW_CONTROLS && <WindowControls closeOnly />}
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-8 pt-6 pb-7 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="mx-auto w-full max-w-160">
          <Suspense fallback={<div className="py-12 text-center text-[11px] text-muted-foreground">Loading…</div>}>
            {ActiveSection && <ActiveSection />}
          </Suspense>
        </div>
      </main>
    </div>
  );
}
