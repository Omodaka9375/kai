import { Button } from "@/components/ui/button";
import { GithubIcon, Globe02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getName, getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { arch, platform } from "@tauri-apps/plugin-os";
import { useEffect, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";

const REPO_URL = "https://github.com/Omodaka9375/kai";
const WEBSITE = "https://omodaka9375.github.io/kai";

const PLATFORM_LABEL: Record<string, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
  ios: "iOS",
  android: "Android",
  freebsd: "FreeBSD",
};

export function AboutSection() {
  const [version, setVersion] = useState("");
  const [name, setName] = useState("Kai");
  const [build, setBuild] = useState("");

  useEffect(() => {
    void getVersion().then(setVersion);
    void getName().then(setName);
    try {
      const p = platform();
      const a = arch();
      const platformLabel = PLATFORM_LABEL[p] ?? p;
      setBuild(`${platformLabel} · ${a}`);
    } catch {
      setBuild("");
    }
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title="About" description="" />

      <div className="flex items-center gap-4 rounded-xl border border-border/60 bg-card/60 p-5">
        <img src="/logo.png" alt="" className="size-12" draggable={false} />
        <div className="flex min-w-0 flex-col">
          <span className="text-[15px] font-semibold tracking-tight">
            {name}
          </span>
          <span className="text-[11px] text-muted-foreground">
            Open-source AI-native terminal emulator
          </span>
          <span className="mt-1 font-mono text-[11px] text-muted-foreground">
            v{version || "—"}
          </span>
        </div>
      </div>

      <dl className="grid grid-cols-[110px_1fr] gap-y-2.5 text-[12px]">
        <dt className="text-muted-foreground">Build</dt>
        <dd className="font-mono text-[11.5px]">
          {build ? `${build} · v${version}` : `v${version}`}
        </dd>

        <dt className="text-muted-foreground">License</dt>
        <dd>Apache 2.0</dd>

        <dt className="text-muted-foreground">Website</dt>
        <dd>
          <button
            type="button"
            onClick={() => void openUrl(WEBSITE)}
            className="inline-flex items-center gap-1.5 rounded-md text-[12px] underline-offset-2 hover:text-foreground hover:underline"
          >
            <HugeiconsIcon icon={Globe02Icon} size={12} strokeWidth={1.75} />
            kai.app
          </button>
        </dd>
      </dl>

      <div className="rounded-xl border border-border/60 bg-card/60 p-5">
        <h3 className="mb-3 text-[13px] font-semibold tracking-tight">Features</h3>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[12px] text-muted-foreground">
          {[
            "Multi-tab terminal with WebGL",
            "Split panes & inline search",
            "Code editor (CodeMirror 6)",
            "Vim mode & 7 editor themes",
            "File explorer with fuzzy search",
            "Built-in web preview",
            "AI assistant (BYOK)",
            "10+ AI providers supported",
            "Local models (LM Studio, Ollama)",
            "MCP tool server support",
            "MCP Registry browser",
            "Skills system (#handle)",
            "Auto-approve mode",
            "Voice input (Whisper / browser)",
            "PDF & DOCX reading",
            "Web browse & search tools",
            "Multi-agent support",
            "Project memory (KAI.md)",
          ].map((f) => (
            <span key={f} className="flex items-start gap-1.5">
              <span className="mt-[3px] size-1 shrink-0 rounded-full bg-foreground/30" />
              {f}
            </span>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void openUrl(REPO_URL)}
            className="gap-1.5"
          >
            <HugeiconsIcon icon={GithubIcon} size={12} strokeWidth={1.75} />
            View on GitHub
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void openUrl(`${REPO_URL}/issues/new`)}
          >
            Report an issue
          </Button>
        </div>
      </div>
    </div>
  );
}
