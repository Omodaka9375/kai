import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState, useEffect } from "react";
import { Streamdown } from "streamdown";
import { useUpdater } from "./useUpdater";
import { invoke } from "@tauri-apps/api/core";
import { parseChangelogSection, parseReleaseNotes } from "./parseChangelog";

type DistroKey = "arch" | "debian" | "fedora";

function distroCommand(key: DistroKey, version: string): string {
  switch (key) {
    case "arch":
      return "yay -S Kai-bin";
    case "debian":
      return `sudo apt install ./Kai_${version}_amd64.deb`;
    case "fedora":
      return `sudo dnf install ./Kai-${version}-1.x86_64.rpm`;
  }
}

const DISTROS: { key: DistroKey; label: string }[] = [
  { key: "arch", label: "Arch" },
  { key: "debian", label: "Debian / Ubuntu" },
  { key: "fedora", label: "Fedora / RHEL" },
];

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function UpdaterDialog() {
  const { status, install, dismiss } = useUpdater();
  const [copied, setCopied] = useState(false);
  const [distro, setDistro] = useState<DistroKey>("arch");
  const manualVersion =
    status.kind === "manual-available" ? status.info.version : "";
  const activeCommand = distroCommand(distro, manualVersion);
  const [changelog, setChangelog] = useState<{
    loading: boolean;
    sections: { title: string; body: string[] }[] | null;
  }>({ loading: true, sections: null });

  const open =
    status.kind === "available" ||
    status.kind === "manual-available" ||
    status.kind === "downloading" ||
    status.kind === "ready";

  // Fetch release notes for the version on offer.
  //
  // The updater plugin's `Update.body` actually carries the release notes
  // directly from the updater JSON `notes` field, so `available` is preferred.
  // `manual-available` (Linux) gets the GitHub release `body`. Rendering only
  // happens while the note text matches — no work is done `ready`/`downloading`
  // states after install starts.
  useEffect(() => {
    if (status.kind === "available") {
      const body = status.update?.body?.trim();
      if (body) {
        const sections = parseReleaseNotes(body);
        if (sections.length > 0) {
          setChangelog({ loading: false, sections });
          return;
        }
      }
      // Fall back to the bundled CHANGELOG.md if notes are missing/empty.
      invoke<string>("fs_read_changelog")
        .then((text) =>
          setChangelog({
            loading: false,
            sections: parseChangelogSection(text, status.update?.version ?? ""),
          }),
        )
        .catch(() => setChangelog({ loading: false, sections: null }));
    } else if (status.kind === "manual-available") {
      const body = status.info.body?.trim();
      if (body) {
        setChangelog({ loading: false, sections: parseReleaseNotes(body) });
      } else {
        invoke<string>("fs_read_changelog")
          .then((text) =>
            setChangelog({
              loading: false,
              sections: parseChangelogSection(text, status.info.version),
            }),
          )
          .catch(() => setChangelog({ loading: false, sections: null }));
      }
    }
  }, [status]);

  if (!open) return null;

  const update = status.kind === "available" ? status.update : null;
  const manual = status.kind === "manual-available" ? status.info : null;
  const downloading = status.kind === "downloading";
  const ready = status.kind === "ready";

  const copyCommand = async () => {
    if (!navigator?.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(activeCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };
  const progress =
    downloading && status.contentLength
      ? Math.min(100, (status.downloaded / status.contentLength) * 100)
      : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (
          !o &&
          (status.kind === "available" || status.kind === "manual-available")
        )
          dismiss();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>
            {ready
              ? "Update ready"
              : downloading
                ? "Downloading update…"
                : manual
                  ? `Kai v${manual.version} is available`
                  : `Kai v${update?.version} is available`}
          </DialogTitle>
          <DialogDescription>
            {ready
              ? "Restart Kai to finish installing."
              : downloading
                ? progress !== null
                  ? `${progress.toFixed(0)}% — ${formatBytes(status.downloaded)}`
                  : formatBytes(status.downloaded)
                : manual
                  ? `You're on v${manual.currentVersion}. Pick your distro and run the command, or grab the package from GitHub.`
                  : "A new version is ready to install."}
          </DialogDescription>
        </DialogHeader>

        {downloading && progress !== null && (
          <Progress value={progress} className="mt-2" />
        )}
        {downloading && progress === null && (
          <Progress value={undefined} className="mt-2 animate-pulse" />
        )}

        {!downloading && changelog.sections && (
          <div className="mt-1 max-h-[200px] overflow-y-auto rounded-md border border-border/60 bg-muted/40 px-3 py-2">
            <Streamdown
              className="prose prose-sm dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
              linkSafety={{ enabled: false }}
              skipHtml
            >
              {changelog.sections
                .map(
                  (sec) =>
                    `### ${sec.title}\n${sec.body
                      .map((b) => `- ${b}`)
                      .join("\n")}`,
                )
                .join("\n\n")}
            </Streamdown>
          </div>
        )}

        {manual && (
          <div className="mt-2 flex flex-col gap-2">
            <div className="flex gap-1 rounded-md bg-muted/40 p-1">
              {DISTROS.map((d) => (
                <button
                  key={d.key}
                  type="button"
                  onClick={() => setDistro(d.key)}
                  className={`flex-1 rounded px-2 py-1 text-[11px] transition-colors ${
                    distro === d.key
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/40 px-3 py-2 font-mono text-[12px]">
              <span className="flex-1 select-all">$ {activeCommand}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => void copyCommand()}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        )}

        <DialogFooter>
          {status.kind === "available" && (
            <>
              <Button variant="ghost" size="sm" onClick={dismiss}>
                Later
              </Button>
              <Button size="sm" onClick={() => void install()}>
                Install &amp; restart
              </Button>
            </>
          )}
          {manual && (
            <>
              <Button variant="ghost" size="sm" onClick={dismiss}>
                Later
              </Button>
              <Button
                size="sm"
                onClick={() => void openUrl(manual.releaseUrl)}
              >
                Download package
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
