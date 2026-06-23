import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  Add01Icon,
  Cancel01Icon,
  ClipboardIcon,
  CodeIcon,
  Copy01Icon,
  HashtagIcon,
  Key01Icon,
  Mic01Icon,
  RedoIcon,
  Scissor01Icon,
  TerminalIcon,
  TextSelectIcon,
  UndoIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { IS_MAC } from "@/lib/platform";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ACCEPTED_FILES, useComposer, type FileAttachment } from "../lib/composer";
import { useWorkspaceFiles } from "../hooks/useWorkspaceFiles";
import { SLASH_COMMANDS } from "../lib/slashCommands";
import type { Snippet } from "../lib/snippets";
import { useChatStore } from "../store/chatStore";
import { useSnippetsStore } from "../store/snippetsStore";
import { AutoApproveToggle } from "./AutoApproveToggle";
import { FilePickerContent } from "./FilePicker";
import { SnippetPickerContent, type PickerItem } from "./SnippetPicker";

type SnippetTrigger = {
  start: number;
  end: number;
  query: string;
};

type FileTrigger = {
  start: number;
  end: number;
  query: string;
};

function detectSnippetTrigger(
  value: string,
  caret: number,
): SnippetTrigger | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i];
    if (ch === "#") {
      const prev = i === 0 ? " " : value[i - 1];
      if (!/\s/.test(prev)) return null;
      const slice = value.slice(i + 1, caret);
      if (!/^[a-z0-9-]*$/i.test(slice)) return null;
      return { start: i, end: caret, query: slice.toLowerCase() };
    }
    if (/\s/.test(ch)) return null;
    if (!/[a-z0-9-]/i.test(ch)) return null;
  }
  return null;
}

function detectFileTrigger(
  value: string,
  caret: number,
): FileTrigger | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i];
    if (ch === "@") {
      const prev = i === 0 ? " " : value[i - 1];
      if (!/\s/.test(prev)) return null;
      const slice = value.slice(i + 1, caret);
      return { start: i, end: caret, query: slice };
    }
    if (/\s/.test(ch)) return null;
  }
  return null;
}

export function AiInputBar() {
  const c = useComposer();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const snippets = useSnippetsStore((s) => s.snippets);
  const workspaceRoot = useChatStore((s) => s.live.getWorkspaceRoot());

  const [trigger, setTrigger] = useState<SnippetTrigger | null>(null);
  const [fileTrigger, setFileTrigger] = useState<FileTrigger | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const workspaceFiles = useWorkspaceFiles(workspaceRoot, fileTrigger !== null);

  const [fileQuery, setFileQuery] = useState("");
  useEffect(() => {
    if (!fileTrigger) {
      setFileQuery("");
      return;
    }
    const q = fileTrigger.query;
    const t = window.setTimeout(() => setFileQuery(q), 50);
    return () => window.clearTimeout(t);
  }, [fileTrigger]);

  useEffect(() => {
    autoresize(c.textareaRef.current);
  }, [c.value, c.textareaRef]);

  const updateTrigger = () => {
    const el = c.textareaRef.current;
    if (!el) {
      setTrigger(null);
      setFileTrigger(null);
      return;
    }
    const caret = el.selectionStart ?? 0;
    setTrigger(detectSnippetTrigger(c.value, caret));
    setFileTrigger(detectFileTrigger(c.value, caret));
  };

  useEffect(updateTrigger, [c.value, c.textareaRef]);

  const filteredItems = useMemo<PickerItem[]>(() => {
    if (!trigger) return [];
    const q = trigger.query;
    const cmdItems: PickerItem[] = Object.values(SLASH_COMMANDS)
      .filter(
        (c) => !q || c.name.includes(q) || c.label.toLowerCase().includes(q),
      )
      .map((command) => ({ kind: "command", command }));
    const snipItems: PickerItem[] = snippets
      .filter(
        (s) =>
          !q ||
          s.handle.includes(q) ||
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q),
      )
      .map((snippet) => ({ kind: "snippet", snippet }));
    return [...cmdItems, ...snipItems];
  }, [trigger, snippets]);

  const FILE_PICKER_CAP = 30;
  const filteredFiles = useMemo<string[]>(() => {
    if (!fileTrigger) return [];
    const q = fileQuery.toLowerCase();
    if (!q) return workspaceFiles.files.slice(0, FILE_PICKER_CAP);
    const out: string[] = [];
    for (const f of workspaceFiles.files) {
      if (f.toLowerCase().includes(q)) {
        out.push(f);
        if (out.length >= FILE_PICKER_CAP) break;
      }
    }
    return out;
  }, [fileTrigger, fileQuery, workspaceFiles.files]);

  const fileTriggerOpen = fileTrigger !== null;
  const snippetTriggerOpen = trigger !== null;
  useEffect(() => {
    setActiveIndex(0);
  }, [snippetTriggerOpen, fileTriggerOpen, fileQuery]);

  const pickerOpen = trigger !== null || fileTrigger !== null;

  const onPickItem = (item: PickerItem) => {
    if (!trigger) return;
    const before = c.value.slice(0, trigger.start);
    const afterRaw = c.value.slice(trigger.end);
    if (item.kind === "snippet") {
      c.addSnippet(item.snippet);
    } else {
      c.addCommand(item.command);
    }
    const after = afterRaw.replace(/^\s+/, "");
    c.setValue(`${before}${after}`);
    setTrigger(null);
    setActiveIndex(0);
    requestAnimationFrame(() => {
      const el = c.textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  };

  const onPickFile = async (filePath: string) => {
    if (!fileTrigger || !workspaceRoot) return;
    const before = c.value.slice(0, fileTrigger.start);
    const after = c.value.slice(fileTrigger.end);
    c.setValue(`${before}${after}`);
    setFileTrigger(null);
    setActiveIndex(0);
    const fullPath = workspaceRoot.endsWith("/")
      ? `${workspaceRoot}${filePath}`
      : `${workspaceRoot}/${filePath}`;
    await c.attachFileByPath(fullPath);
    requestAnimationFrame(() => {
      const el = c.textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  };

  const pickActive = () => {
    if (fileTrigger) {
      const file = filteredFiles[activeIndex];
      if (file) void onPickFile(file);
      return;
    }
    const it = filteredItems[activeIndex];
    if (it) onPickItem(it);
  };

  const voiceLabel = c.voice.recording
    ? "Listening…"
    : c.voice.transcribing
      ? "Transcribing…"
      : null;

  const hasChips = c.files.length > 0 || c.pickedSnippets.length > 0 || c.pickedCommands.length > 0;

  return (
    <div
      className={cn(
        "shrink-0 border-t border-border/60 bg-card/40 px-3 flex flex-col justify-center",
        hasChips ? "py-2 min-h-[42px]" : "min-h-[42px] py-0"
      )}
    >
      <div
        className={cn(
          "flex flex-col gap-1.5 rounded-lg px-1 py-1",
          "transition-colors focus-within:border-border",
        )}
      >
        <ChipsRow
          files={c.files}
          onRemoveFile={c.removeFile}
          snippets={c.pickedSnippets}
          onRemoveSnippet={(id) => {
            const snip = c.pickedSnippets.find((s) => s.id === id);
            c.removeSnippet(id);
            if (!snip) return;
            const re = new RegExp(`(^|\\s)#${snip.handle}\\b ?`);
            c.setValue((v) => v.replace(re, (_m, lead: string) => lead));
          }}
          commands={c.pickedCommands}
          onRemoveCommand={(name) => c.removeCommand(name)}
        />

        <Popover open={pickerOpen}>
          <PopoverAnchor asChild>
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ACCEPTED_FILES}
                className="hidden"
                onChange={(e) => {
                  void c.addFiles(e.target.files);
                  e.target.value = "";
                }}
              />

              {c.voice.supported && (
                <button
                  type="button"
                  title={
                    c.voice.recording
                      ? "Stop & transcribe"
                      : c.voice.transcribing
                        ? "Transcribing…"
                        : "Voice input"
                  }
                  onClick={() =>
                    c.voice.recording ? c.voice.stop() : void c.voice.start()
                  }
                  disabled={c.isBusy || c.voice.transcribing}
                  className={cn(
                    "shrink-0 size-6 flex items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-50",
                    c.voice.recording && "bg-destructive/15 text-destructive hover:bg-destructive/20 hover:text-destructive animate-pulse"
                  )}
                >
                  {c.voice.recording ? (
                    <span className="size-1.5 rounded-full bg-destructive" />
                  ) : c.voice.transcribing ? (
                    <Spinner className="size-3" />
                  ) : (
                    <HugeiconsIcon icon={Mic01Icon} size={14} strokeWidth={1.75} />
                  )}
                </button>
              )}

              <button
                type="button"
                title="Attach file or image"
                disabled={c.isBusy}
                onClick={() => fileInputRef.current?.click()}
                className="shrink-0 size-6 flex items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-50"
              >
                <HugeiconsIcon icon={Add01Icon} size={14} strokeWidth={2} />
              </button>

              <textarea
                ref={c.textareaRef}
                value={c.value}
                onChange={(e) => c.setValue(e.target.value)}
                onKeyUp={updateTrigger}
                onClick={updateTrigger}
                onSelect={updateTrigger}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtxMenu({ x: e.clientX, y: e.clientY });
                }}
                onPaste={(e) => {
                  const items = e.clipboardData?.items;
                  if (!items) return;
                  const pastedFiles: File[] = [];
                  for (let i = 0; i < items.length; i++) {
                    const item = items[i];
                    if (item.type.startsWith("image/")) {
                      const file = item.getAsFile();
                      if (file) pastedFiles.push(file);
                    }
                  }
                  if (pastedFiles.length > 0) {
                    e.preventDefault();
                    void c.addFiles(pastedFiles as any);
                  }
                }}
                onKeyDown={(e) => {
                  if (pickerOpen) {
                    const items = fileTrigger ? filteredFiles : filteredItems;
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setActiveIndex((i) =>
                        Math.min(i + 1, Math.max(0, items.length - 1)),
                      );
                      return;
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setActiveIndex((i) => Math.max(0, i - 1));
                      return;
                    }
                    if (e.key === "Tab" || e.key === "Enter") {
                      if (items.length > 0) {
                        e.preventDefault();
                        pickActive();
                        return;
                      }
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      if (fileTrigger) {
                        const before = c.value.slice(0, fileTrigger.start);
                        const after = c.value.slice(fileTrigger.end);
                        c.setValue(`${before}${after}`);
                        setFileTrigger(null);
                      } else {
                        setTrigger(null);
                      }
                      return;
                    }
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    c.submit();
                  }
                }}
                placeholder={c.isBusy ? "Redirect agent…" : "Ask anything # for snippets, @ for files"}
                rows={1}
                disabled={false}
                className={cn(
                  "flex-1 resize-none bg-transparent text-[13px] leading-relaxed outline-none",
                  "placeholder:text-muted-foreground/60",
                )}
              />
              <AutoApproveToggle />
            </div>
          </PopoverAnchor>
          {fileTrigger ? (
            <FilePickerContent
              files={filteredFiles}
              activeIndex={activeIndex}
              indexing={workspaceFiles.indexing}
              truncated={workspaceFiles.truncated}
              hasWorkspace={workspaceRoot !== null}
              onPick={(f) => void onPickFile(f)}
              onHover={setActiveIndex}
            />
          ) : (
            <SnippetPickerContent
              items={filteredItems}
              activeIndex={activeIndex}
              onPick={onPickItem}
              onHover={setActiveIndex}
            />
          )}
        </Popover>

        <AnimatePresence initial={false}>
          {voiceLabel && (
            <motion.div
              key={voiceLabel}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.12 }}
              className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground"
            >
              {c.voice.recording ? (
                <span className="size-1.5 animate-pulse rounded-full bg-destructive" />
              ) : (
                <Spinner className="size-3" />
              )}
              <span className="truncate">{voiceLabel}</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {ctxMenu && (
        <InputContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          textareaRef={c.textareaRef}
          hasSelection={
            c.textareaRef.current
              ? c.textareaRef.current.selectionStart !== c.textareaRef.current.selectionEnd
              : false
          }
          onDismiss={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

// ── Themed right-click menu for the AI input textarea ─────────────────

const MOD = IS_MAC ? "⌘" : "Ctrl+";

type CtxItem = {
  label: string;
  icon: typeof Copy01Icon;
  kbd: string;
  action: (el: HTMLTextAreaElement) => void;
  enabled?: (el: HTMLTextAreaElement) => boolean;
};

const CTX_ITEMS: CtxItem[] = [
  {
    label: "Undo",
    icon: UndoIcon,
    kbd: `${MOD}Z`,
    action: () => document.execCommand("undo"),
  },
  {
    label: "Redo",
    icon: RedoIcon,
    kbd: IS_MAC ? "⇧⌘Z" : "Ctrl+Y",
    action: () => document.execCommand("redo"),
  },
  {
    label: "Cut",
    icon: Scissor01Icon,
    kbd: `${MOD}X`,
    action: () => document.execCommand("cut"),
    enabled: (el) => el.selectionStart !== el.selectionEnd,
  },
  {
    label: "Copy",
    icon: Copy01Icon,
    kbd: `${MOD}C`,
    action: () => document.execCommand("copy"),
    enabled: (el) => el.selectionStart !== el.selectionEnd,
  },
  {
    label: "Paste",
    icon: ClipboardIcon,
    kbd: `${MOD}V`,
    action: (el) => {
      void navigator.clipboard.readText().then((text) => {
        if (!text) return;
        const start = el.selectionStart;
        const end = el.selectionEnd;
        // Use execCommand so undo history is preserved.
        el.focus();
        document.execCommand("insertText", false, text);
        // If execCommand didn't work (some browsers), fall back.
        if (el.selectionStart === start && el.selectionEnd === end) {
          const before = el.value.slice(0, start);
          const after = el.value.slice(end);
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype,
            "value",
          )?.set;
          nativeInputValueSetter?.call(el, before + text + after);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.setSelectionRange(start + text.length, start + text.length);
        }
      });
    },
  },
  {
    label: "Select All",
    icon: TextSelectIcon,
    kbd: `${MOD}A`,
    action: (el) => el.setSelectionRange(0, el.value.length),
    enabled: (el) => el.value.length > 0,
  },
];

function InputContextMenu({
  x,
  y,
  textareaRef,
  hasSelection: _hasSelection,
  onDismiss,
}: {
  x: number;
  y: number;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  hasSelection: boolean;
  onDismiss: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node))
        onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onDismiss]);

  const w = 170;
  const h = CTX_ITEMS.length * 28 + 12; // rough estimate for clamping
  const left = Math.max(4, Math.min(x, window.innerWidth - w - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - h - 4));

  const el = textareaRef.current;

  return (
    <motion.div
      ref={menuRef}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.1, ease: "easeOut" }}
      style={{ top, left, width: w }}
      className="fixed z-50 flex flex-col gap-0.5 rounded-lg border border-border/70 bg-card/95 p-1 shadow-xl backdrop-blur-md"
    >
      {CTX_ITEMS.map((item) => {
        const disabled = el ? item.enabled?.(el) === false : true;
        return (
          <button
            key={item.label}
            type="button"
            disabled={disabled}
            onClick={(e) => {
              e.stopPropagation();
              if (el) {
                el.focus();
                item.action(el);
              }
              onDismiss();
            }}
            className={cn(
              "flex h-7 w-full cursor-pointer items-center justify-between rounded-md px-2 text-[11.5px] text-foreground hover:bg-accent",
              disabled && "pointer-events-none opacity-40",
            )}
          >
            <span className="flex items-center gap-2">
              <HugeiconsIcon
                icon={item.icon}
                size={12}
                strokeWidth={1.8}
                className="text-muted-foreground"
              />
              <span>{item.label}</span>
            </span>
            <KbdGroup>
              <Kbd className="h-4 min-w-4 px-1 text-[9px]">{item.kbd}</Kbd>
            </KbdGroup>
          </button>
        );
      })}
    </motion.div>
  );
}

function ChipsRow({
  files,
  onRemoveFile,
  snippets,
  onRemoveSnippet,
  commands,
  onRemoveCommand,
}: {
  files: FileAttachment[];
  onRemoveFile: (id: string) => void;
  snippets: Snippet[];
  onRemoveSnippet: (id: string) => void;
  commands: { name: string; label: string; icon: typeof HashtagIcon }[];
  onRemoveCommand: (name: string) => void;
}) {
  if (files.length === 0 && snippets.length === 0 && commands.length === 0)
    return null;
  return (
    <div className="flex flex-wrap gap-1">
      <AnimatePresence initial={false}>
        {commands.map((cmd) => (
          <motion.div
            key={`cmd-${cmd.name}`}
            layout
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.92 }}
            transition={{ duration: 0.12 }}
            className="group flex items-center gap-1 rounded-md border border-border/60 bg-card px-1.5 py-0.5 text-[11px]"
            title={cmd.label}
          >
            <HugeiconsIcon
              icon={cmd.icon}
              size={11}
              strokeWidth={1.75}
              className="text-muted-foreground"
            />
            <span className="font-medium">#{cmd.name}</span>
            <button
              type="button"
              onClick={() => onRemoveCommand(cmd.name)}
              className="ml-0.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
              aria-label="Remove command"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
            </button>
          </motion.div>
        ))}
        {snippets.map((s) => (
          <motion.div
            key={`snip-${s.id}`}
            layout
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.92 }}
            transition={{ duration: 0.12 }}
            className="group flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary"
            title={s.description || s.name}
          >
            <HugeiconsIcon
              icon={HashtagIcon}
              size={11}
              strokeWidth={2}
              className="opacity-80"
            />
            <span className="font-medium">{s.handle}</span>
            <button
              type="button"
              onClick={() => onRemoveSnippet(s.id)}
              className="ml-0.5 opacity-0 transition-opacity group-hover:opacity-100"
              aria-label="Remove snippet"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
            </button>
          </motion.div>
        ))}
        {files.map((f) => (
          <motion.div
            key={f.id}
            layout
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.92 }}
            transition={{ duration: 0.12 }}
            className="group flex items-center gap-1 rounded-md border border-border/60 bg-card px-1.5 py-0.5 text-[11px]"
          >
            {f.kind === "image" && f.url ? (
              <img src={f.url} alt="" className="size-4 rounded object-cover" />
            ) : f.kind === "selection" ? (
              <HugeiconsIcon
                icon={f.source === "editor" ? CodeIcon : TerminalIcon}
                size={11}
                strokeWidth={1.75}
                className="text-muted-foreground"
              />
            ) : (
              <span className="font-mono text-[10px] text-muted-foreground">
                {extOf(f.name)}
              </span>
            )}
            <span className="max-w-35 truncate">
              {f.name}
              {f.kind === "selection" && f.text ? (
                <span className="ml-1 text-muted-foreground">
                  · {selLineCount(f.text)}L
                </span>
              ) : null}
            </span>
            <button
              type="button"
              onClick={() => onRemoveFile(f.id)}
              className="ml-0.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
              aria-label="Remove"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function selLineCount(text: string): number {
  if (!text) return 0;
  const trimmed = text.replace(/\n+$/, "");
  if (!trimmed) return 0;
  return trimmed.split("\n").length;
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "FILE" : name.slice(i + 1).toUpperCase();
}

function autoresize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  // ~2 visible lines (2 × line-height 1.625 × 13px ≈ 42px), scroll beyond
  const maxH = 42;
  const next = Math.min(el.scrollHeight, maxH);
  el.style.height = `${next}px`;
  el.style.overflowY = el.scrollHeight > maxH ? "auto" : "hidden";
}

export type AiInputBarProps = { tabId: number };

export function AiInputBarConnect({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="shrink-0 border-t border-border/60 bg-card/40 px-3 py-2">
      <div className="flex h-10 items-center justify-between gap-3 rounded-lg px-3 text-xs">
        <span className="text-muted-foreground">
          Connect any AI provider (or use local models) - your key stays in your
          OS keychain.
        </span>
        <Button size="xs" onClick={onAdd}>
          <HugeiconsIcon icon={Key01Icon} />
          Connect provider
        </Button>
      </div>
    </div>
  );
}
