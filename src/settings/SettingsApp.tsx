import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WindowControls } from "@/components/WindowControls";
import { IS_MAC, USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import type { SettingsTab } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  AiScanIcon,
  InformationCircleIcon,
  Settings01Icon,
  UserMultiple02Icon,
  KeyboardIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { JSX, useEffect, useState } from "react";
import { AboutSection } from "./sections/AboutSection";
import { AgentsSection } from "./sections/AgentsSection";
import { GeneralSection } from "./sections/GeneralSection";
import { ModelsSection } from "./sections/ModelsSection";
import { ShortcutsSection } from "./sections/ShortcutsSection";

const TABS: { id: SettingsTab; label: string; icon: typeof Settings01Icon, component: () => JSX.Element }[] =
  [
    { id: "general", label: "General", icon: Settings01Icon, component: GeneralSection },
    { id: "shortcuts", label: "Shortcuts", icon: KeyboardIcon, component: ShortcutsSection },
    { id: "models", label: "Models", icon: AiScanIcon, component: ModelsSection },
    { id: "agents", label: "Agents", icon: UserMultiple02Icon, component: AgentsSection },
    { id: "about", label: "About", icon: InformationCircleIcon, component: AboutSection },
  ];

const VALID_TABS: SettingsTab[] = [
  "general",
  "shortcuts",
  "models",
  "agents",
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

function isInitialIsolated(): boolean {
  if (typeof window === "undefined") return false;
  const url = new URL(window.location.href);
  const t = url.searchParams.get("tab") || "";
  return url.searchParams.get("isolate") === "true" || t.includes("isolate=true");
}

export function SettingsApp() {
  const [active, setActive] = useState<SettingsTab>(readInitialTab);
  const [isolated, setIsolated] = useState(isInitialIsolated);
  const init = usePreferencesStore((s) => s.init);
  const ActiveSection = TABS.find(t => t.id === active)?.component;

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    const apply = (detail: string) => {
      const isIso = detail.includes("isolate=true");
      setIsolated(isIso);
      const cleanTab = detail.split("&")[0];
      if (cleanTab === "ai" || cleanTab === "connections") {
        setActive("models");
        return;
      }
      if ((VALID_TABS as string[]).includes(cleanTab)) {
        setActive(cleanTab as SettingsTab);
      }
    };
    const unlistenPromise = getCurrentWebviewWindow().listen<string>(
      "Kai:settings-tab",
      (e) => apply(e.payload),
    );
    return () => {
      void unlistenPromise.then((un) => un());
    };
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground select-none">
      <header
        data-tauri-drag-region
        className={`flex h-11 shrink-0 items-center border-b border-border/60 bg-card/60 ${IS_MAC ? "pr-3 pl-22" : "pr-0 pl-3"
          }`}
      >
        {isolated ? (
          <div className="flex-1 px-3 text-[12.5px] font-semibold text-foreground tracking-tight" data-tauri-drag-region>
            {TABS.find((t) => t.id === active)?.label ?? "Settings"}
          </div>
        ) : (
          <Tabs
            value={active}
            onValueChange={(v) => setActive(v as SettingsTab)}
            orientation="horizontal"
            className="flex-1 items-center"
            data-tauri-drag-region
          >
            <TabsList className="mx-auto h-7 bg-muted/40 px-2">
              {TABS.map((t) => (
                <TabsTrigger
                  key={t.id}
                  value={t.id}
                  className="h-6 gap-1.5 px-2.5 text-[11.5px]"
                >
                  <HugeiconsIcon icon={t.icon} size={12} strokeWidth={1.75} />
                  <span>{t.label}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}
        {USE_CUSTOM_WINDOW_CONTROLS && <WindowControls closeOnly />}
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-8 pt-6 pb-7 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="mx-auto w-full max-w-160">
          {ActiveSection && <ActiveSection />}
        </div>
      </main>
    </div>
  );
}
