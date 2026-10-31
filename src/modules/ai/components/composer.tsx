import { invoke } from "@tauri-apps/api/core";
import type { UIMessagePart } from "ai";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

/** Loose part type for steering-message payloads (text + image file parts). */
type LoosePart = UIMessagePart<Record<string, never>, Record<string, never>>;

import { useWhisperRecording } from "../hooks/useWhisperRecording";
import {
  EMPTY_DOCUMENT_TEXT,
  pdfTextFromBytes,
  spreadsheetToText,
} from "../lib/documentParser";
import type { SpreadsheetData } from "../lib/native";
import { expandSnippetTokens, type Snippet } from "../lib/snippets";
import { tryRunSlashCommand, type SlashCommandMeta } from "../lib/slashCommands";
import { buildQuoteBlock } from "../lib/chatText";
import {
  getOrCreateChat,
  stopSession,
  setSessionSteeringMessage,
  getSessionSteeringMessage,
  useChatStore,
} from "../store/chatStore";
import { useSnippetsStore } from "../store/snippetsStore";
import {
  getSessionPreferences,
  hydrateSessionPreferences,
  setSessionPreferences,
} from "../store/sessionPreferences";
import { currentWorkspaceEnv, useProjectRuntime } from "@/modules/workspace";

export type FileAttachment = {
  id: string;
  name: string;
  kind: "image" | "text" | "selection";
  mediaType: string;
  url?: string;
  text?: string;
  size: number;
  /** For kind === "selection": which surface it came from. */
  source?: "terminal" | "editor";
};

type MessagePart =
  | { type: "text"; text: string }
  | { type: "file"; mediaType: string; url: string; filename?: string };

export const MAX_TEXT_INLINE = 200_000;
export const ACCEPTED_FILES =
  "image/*,.pdf,.txt,.md,.json,.yaml,.yml,.toml,.sh,.zsh,.bash,.py,.js,.jsx,.ts,.tsx,.rs,.go,.java,.c,.cpp,.h,.hpp,.html,.css,.csv,.log,.env,.config,.conf,.ini,Dockerfile,.dockerfile,.xlsx,.xlsm,.xlsb,.xls,.ods,.docx";

type Voice = ReturnType<typeof useWhisperRecording>;

export type PendingQuote = {
  /** Who said the quoted text ("You" or an agent/participant name). */
  author: string;
  /** The quoted text (full, untruncated). */
  text: string;
};

type ComposerCtx = {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  setValue: React.Dispatch<React.SetStateAction<string>>;
  files: FileAttachment[];
  addFiles: (list: FileList | null) => Promise<void>;
  /** Attach pasted text as a chip - used for large/formatted pastes that would swamp the input. */
  attachPastedText: (text: string) => void;
  /** Attach a file by absolute path - used by the file explorer's "Attach to Agent". */
  attachFileByPath: (path: string) => Promise<void>;
  removeFile: (id: string) => void;
  /** Reply-quote bar: set by Quote actions (transcript selections), sent as
   *  a <quote author="..."> block ahead of the message body, cleared on
   *  submit or dismiss. */
  pendingQuote: PendingQuote | null;
  setPendingQuote: (q: PendingQuote | null) => void;
  pickedSnippets: Snippet[];
  addSnippet: (s: Snippet) => void;
  removeSnippet: (id: string) => void;
  pickedCommands: SlashCommandMeta[];
  addCommand: (c: SlashCommandMeta) => void;
  removeCommand: (name: string) => void;
  isBusy: boolean;
  /** Alt+Enter / background start leaves the current surface untouched. */
  submit: (options?: { text?: string; background?: boolean }) => void;
  stop: () => void;
  voice: Voice;
  canSend: boolean;
  /** Transient slash-command outcome (e.g. "/compact" result), shown under the input. */
  notice: string | null;
  /** True while voice capture is active or transcribing — the input
   *  placeholder switches to "Listening…"/"Transcribing…". */
  voiceBusy: boolean;
};

const Ctx = createContext<ComposerCtx | null>(null);

export function useComposer(): ComposerCtx {
  const ctx = useContext(Ctx);
  if (!ctx)
    throw new Error("useComposer must be used inside <AiComposerProvider>");
  return ctx;
}

type ProviderProps = {
  children: React.ReactNode;
};

export function AiComposerProvider({ children }: ProviderProps) {
  const runtime = useProjectRuntime();
  const sessionId = useChatStore((s) => s.activeSessionId);
  const status = useChatStore((s) => s.agentMeta.status);
  const isBusy =
    status === "thinking" ||
    status === "streaming" ||
    status === "awaiting-approval";

  const [value, setValue] = useState(() => sessionId ? getSessionPreferences(sessionId).draft ?? "" : "");
  const draftSessionRef = useRef(sessionId);
  useEffect(() => {
    void hydrateSessionPreferences();
  }, []);
  useEffect(() => {
    if (draftSessionRef.current !== sessionId) {
      draftSessionRef.current = sessionId;
      setValue(sessionId ? getSessionPreferences(sessionId).draft ?? "" : "");
      return;
    }
    if (!sessionId) return;
    const timer = setTimeout(() => {
      // Hydration is app-owned; the composer must not replace a persisted
      // draft with its initial empty value before the store has loaded.
      void hydrateSessionPreferences().then(() => {
        if (draftSessionRef.current === sessionId) {
          setSessionPreferences(sessionId, { draft: value || undefined });
        }
      });
    }, 150);
    return () => clearTimeout(timer);
  }, [sessionId, value]);
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [pickedSnippets, setPickedSnippets] = useState<Snippet[]>([]);
  const [pickedCommands, setPickedCommands] = useState<SlashCommandMeta[]>([]);
  const [pendingQuote, setPendingQuote] = useState<PendingQuote | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Transient slash-command outcome. The main window has no transcript
  // (AgentRunBridge is headless; the transcript lives in the mini window),
  // so without this a refused /compact ("wait for the run…", "already
  // minimal") was completely invisible — the input just cleared.
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice = useCallback((text: string) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = setTimeout(() => setNotice(null), 4_000);
  }, []);
  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );

  const focusSignal = useChatStore((s) => s.focusSignal);
  const pendingPrefill = useChatStore((s) => s.pendingPrefill);
  const consumePrefill = useChatStore((s) => s.consumePrefill);
  const pendingSelections = useChatStore((s) => s.pendingSelections);
  const consumeSelections = useChatStore((s) => s.consumeSelections);

  useEffect(() => {
    if (focusSignal === 0) return;
    textareaRef.current?.focus();
    if (pendingPrefill != null) {
      const text = consumePrefill();
      if (text) setValue((v) => (v ? `${text}${v}` : text));
    }
  }, [focusSignal, pendingPrefill, consumePrefill]);

  // Listen for explorer's "Attach to Agent" event.
  useEffect(() => {
    const onAttach = (e: Event) => {
      const detail = (e as CustomEvent<{ path: string; projectId?: string }>).detail;
      if (runtime && detail.projectId !== runtime.id) return;
      if (detail.path) void attachFileByPath(detail.path);
    };
    window.addEventListener("Kai:ai-attach-file", onAttach);
    return () => window.removeEventListener("Kai:ai-attach-file", onAttach);
  }, [runtime]);

  // Quote-from-transcript (right-click Quote on a chat message). Replaces
  // any pending quote - one quote per message, like every chat app.
  useEffect(() => {
    const onQuote = (e: Event) => {
      const detail = (e as CustomEvent<{ author: string; text: string }>).detail;
      if (!detail?.text) return;
      setPendingQuote({ author: detail.author, text: detail.text });
    };
    window.addEventListener("Kai:ai-quote", onQuote);
    return () => window.removeEventListener("Kai:ai-quote", onQuote);
  }, []);

  useEffect(() => {
    if (pendingSelections.length === 0) return;
    const drained = consumeSelections();
    if (drained.length === 0) return;
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => f.id));
      const next: FileAttachment[] = [];
      for (const sel of drained) {
        if (existing.has(sel.id)) continue;
        next.push({
          id: sel.id,
          name:
            sel.source === "editor"
              ? "Editor selection"
              : "Terminal selection",
          kind: "selection",
          mediaType: "text/plain",
          text: sel.text,
          size: sel.text.length,
          source: sel.source,
        });
      }
      return next.length ? [...prev, ...next] : prev;
    });
  }, [pendingSelections, consumeSelections]);

  // Hands-free voice: with auto-approve active, a finished transcription
  // submits immediately — a true Enter-equivalent (busy agent → steering,
  // same as pressing Enter manually). With approvals on (Ask mode), the
  // transcript lands in the field for review as before.
  const autoApprove = useChatStore((s) => s.autoApprove);
  const voice = useWhisperRecording({
    onResult: (transcript: string) => {
      setValue((v) => (v ? `${v} ${transcript}` : transcript));
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    autoSubmit: autoApprove !== "off",
    onAutoSubmit: (transcript: string) => {
      // Merge with pre-typed text: `value` in this closure is fresh as of
      // the last render (the hook keeps the callback current via ref), so
      // it holds whatever the user typed BEFORE capture started — the
      // transcript itself has not flushed into state yet.
      const pre = value.trim();
      void submit({ text: pre ? `${pre} ${transcript}` : transcript });
    },
  });

  // Global shortcut (ai.voice, Cmd/Ctrl+M) dispatches this event — the
  // composer owns the recording state, so the toggle logic lives here.
  // Same decoupling pattern as the Kai:ai-attach-file listener above.
  useEffect(() => {
    const onVoiceToggle = () => {
      if (voice.transcribing) return; // a click now would abandon the transcript
      if (voice.recording) {
        voice.stop();
      } else {
        if (voice.error) voice.clearError();
        void voice.start();
      }
    };
    window.addEventListener("Kai:ai-voice-toggle", onVoiceToggle);
    return () =>
      window.removeEventListener("Kai:ai-voice-toggle", onVoiceToggle);
  }, [voice]);

  const addFiles = async (list: FileList | null) => {
    if (!list) return;
    const next: FileAttachment[] = [];
    for (const f of Array.from(list)) {
      const att = await readAttachment(f);
      if (att) next.push(att);
    }
    if (next.length) setFiles((prev) => [...prev, ...next]);
  };

  const removeFile = (id: string) =>
    setFiles((prev) => prev.filter((f) => f.id !== id));

  const attachPastedText = (text: string) => {
    const trimmed = text;
    if (!trimmed) return;
    const firstLine =
      trimmed.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "text";
    const name =
      firstLine.length > 24 ? `${firstLine.slice(0, 24)}…` : firstLine;
    const id = `paste-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    setFiles((prev) => [
      ...prev,
      {
        id,
        name: `Pasted: ${name}`,
        kind: "text",
        mediaType: "text/plain",
        text: trimmed,
        size: trimmed.length,
      },
    ]);
  };

  const addSnippet = (s: Snippet) =>
    setPickedSnippets((prev) =>
      prev.some((p) => p.id === s.id) ? prev : [...prev, s],
    );
  const removeSnippet = (id: string) =>
    setPickedSnippets((prev) => prev.filter((s) => s.id !== id));

  const addCommand = (cmd: SlashCommandMeta) =>
    setPickedCommands((prev) =>
      prev.some((p) => p.name === cmd.name) ? prev : [...prev, cmd],
    );
  const removeCommand = (name: string) =>
    setPickedCommands((prev) => prev.filter((c) => c.name !== name));

  const attachFileByPath = async (path: string) => {
    try {
      type ReadResult =
        | { kind: "text"; content: string; size: number }
        | { kind: "binary"; size: number }
        | { kind: "toolarge"; size: number; limit: number };
      const result = await invoke<ReadResult>("fs_read_file", {
        path,
        workspace: runtime?.env ?? currentWorkspaceEnv(),
      });
      if (result.kind !== "text") {
        // Binary/oversize files: skip (could surface a toast in future).
        console.warn("attachFileByPath: skipped non-text file", path, result);
        return;
      }
      const name = path.split(/[\\/]/).pop() || path;
      const id = `path-${path}`;
      setFiles((prev) => {
        if (prev.some((f) => f.id === id)) return prev;
        const att: FileAttachment = {
          id,
          name,
          kind: "text",
          mediaType: "text/plain",
          text: result.content,
          size: result.size,
        };
        return [...prev, att];
      });
      // Open the AI panel & focus the input so the user sees the chip.
      useChatStore.getState().focusInput();
    } catch (e) {
      console.error("attachFileByPath failed:", e);
    }
  };

  const submit = async (options?: { text?: string; background?: boolean }) => {
    // `text` overrides the field value — used by hands-free voice: the
    // transcript arrives via callback before the field's setState flushes,
    // so reading `value` there would miss it.
    const trimmed = (options?.text ?? value).trim();
    if (
      !trimmed &&
      files.length === 0 &&
      pickedSnippets.length === 0 &&
      pickedCommands.length === 0
    )
      return;

    // Slash-command interception. `/plan` toggles plan mode; `/init` rewrites
    // the prompt to the Kai.md scan template before sending.
    let effectiveText = trimmed;
    let commandMarker: string | null = null;
    let commandSource = trimmed;
    if (pickedCommands.length > 0 && !trimmed.startsWith("/") && !trimmed.startsWith("#")) {
      // Commands are slash-invoked (`/plan`, `/compact`) — the `#` form is
      // reserved for snippets. tryRunSlashCommand accepts both, but the
      // canonical prefix here is `/`.
      commandSource = `/${pickedCommands[0].name} ${trimmed}`.trim();
    }
    if (commandSource.startsWith("/") || commandSource.startsWith("#")) {
      const outcome = await tryRunSlashCommand(commandSource);
      if (outcome.kind === "handled") {
        setValue("");
        setFiles([]);
        setPickedSnippets([]);
        setPickedCommands([]);
        if (outcome.toast) showNotice(outcome.toast);
        return;
      }
      if (outcome.kind === "send-prompt") {
        effectiveText = outcome.prompt;
        if (outcome.commandName) {
          commandMarker = `<Kai-command name="${outcome.commandName}" />`;
        }
      }
    }

    const parts: MessagePart[] = [];
    const fileBlocks = files
      .filter((f) => f.kind === "text")
      .map(
        (f) =>
          `<file name="${f.name}" mediaType="${f.mediaType}">\n${f.text ?? ""}\n</file>`,
      );
    const selectionBlocks = files
      .filter((f) => f.kind === "selection")
      .map(
        (f) =>
          `<selection source="${f.source ?? "terminal"}">\n${f.text ?? ""}\n</selection>`,
      );
    const { body: bodyAfterTokens, blocks: snippetBlocks } = expandSnippetTokens(
      effectiveText,
      useSnippetsStore.getState().snippets,
    );
    const seenHandles = new Set<string>();
    const allSnippetBlocks: string[] = [];
    for (const s of pickedSnippets) {
      if (seenHandles.has(s.handle)) continue;
      seenHandles.add(s.handle);
      allSnippetBlocks.push(
        `<snippet name="${s.handle}">\n${s.content}\n</snippet>`,
      );
    }
    for (const block of snippetBlocks) {
      const m = block.match(/^<snippet name="([^"]+)"/);
      if (m && seenHandles.has(m[1])) continue;
      if (m) seenHandles.add(m[1]);
      allSnippetBlocks.push(block);
    }
    const quoteBlock = pendingQuote
      ? buildQuoteBlock(pendingQuote.author, pendingQuote.text)
      : null;
    const composed = [
      commandMarker ?? "",
      allSnippetBlocks.join("\n\n"),
      quoteBlock ?? "",
      selectionBlocks.join("\n\n"),
      fileBlocks.join("\n\n"),
      bodyAfterTokens,
    ]
      .filter(Boolean)
      .join("\n\n");
    if (composed) parts.push({ type: "text", text: composed });
    // The quote is one-shot: consumed by the send, like files and snippets.
    setPendingQuote(null);

    for (const f of files) {
      if (f.kind === "image" && f.url) {
        parts.push({
          type: "file",
          mediaType: f.mediaType,
          url: f.url,
          filename: f.name,
        });
      }
    }

    // NOTE: text-only models are handled in the agent transport
    // (agent.ts swaps image file parts for extracted text at request time).
    // The message sent to the Chat — and therefore the transcript — keeps
    // the image part so the user sees their attachment.

    // When the agent is busy, queue the FULL composed message (text blocks
    // AND image file parts) as a steering signal — the bridge stops the
    // current run and sends it as-is once idle. Anything sent here must
    // match the normal path exactly: attachments included.
    // AND image file parts) as a steering signal — the bridge stops the
    // current run and sends it as-is once idle. Anything sent here must
    // match the normal path exactly: attachments included.
    if (isBusy) {
      const pending = sessionId ? getSessionSteeringMessage(sessionId) : null;
      if (sessionId) setSessionSteeringMessage(sessionId, (pending ?? []).concat(parts as LoosePart[]));
      setValue("");
      setFiles([]);
      setPickedSnippets([]);
      setPickedCommands([]);
      setPendingQuote(null);
      return;
    }

    if (!sessionId) return;
    const chat = getOrCreateChat(sessionId);
    void chat.sendMessage({ role: "user", parts } as Parameters<
      typeof chat.sendMessage
    >[0]);
    const store = useChatStore.getState();
    store.patchAgentMeta({
      hitStepCap: false,
      finishReason: "",
      compactionNotice: null,
      // A new run clears any end-of-run notice from the previous one (the
      // stall-recovery breadcrumb, the loop-stopped reason) so a stale banner
      // never sits above a fresh reply.
      summaryNotice: null,
    });
    if (!options?.background && !store.mini.open) store.openMini();
    if (options?.background) showNotice("Agent started in background");
    setValue("");
    setFiles([]);
    setPickedSnippets([]);
    setPickedCommands([]);
    setPendingQuote(null);
  };

  const stop = () => {
    if (!sessionId) return;
    stopSession(sessionId);
  };

  const canSend =
    value.trim().length > 0 ||
    (!isBusy &&
      (files.length > 0 ||
        pickedSnippets.length > 0 ||
        pickedCommands.length > 0 ||
        pendingQuote !== null));

  const ctx: ComposerCtx = {
    textareaRef,
    value,
    setValue,
    files,
    addFiles,
    attachPastedText,
    attachFileByPath,
    removeFile,
    pendingQuote,
    setPendingQuote,
    pickedSnippets,
    addSnippet,
    removeSnippet,
    pickedCommands,
    addCommand,
    removeCommand,
    isBusy,
    submit,
    stop,
    voice,
    canSend,
    notice,
    voiceBusy: voice.recording || voice.transcribing,
  };

  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
}

async function readAttachment(file: File): Promise<FileAttachment | null> {
  const id = `${file.name}-${file.size}-${file.lastModified}`;
  if (file.type.startsWith("image/")) {
    const url = await readAsDataURL(file);
    return {
      id,
      name: file.name,
      kind: "image",
      mediaType: file.type || "image/png",
      url,
      size: file.size,
    };
  }
  // Structured documents (PDF/DOCX) — extract the text layer with the same
  // pdfjs/mammoth parsers the read_file tool uses. Works for every model; no
  // provider PDF support needed.
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".pdf")) {
    const text = await pdfTextFromBytes(new Uint8Array(await file.arrayBuffer()));
    return {
      id,
      name: file.name,
      kind: "text",
      mediaType: "text/plain",
      text: text.trim() ? text : EMPTY_DOCUMENT_TEXT,
      size: file.size,
    };
  }
  if (lower.endsWith(".docx")) {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({
      arrayBuffer: await file.arrayBuffer(),
    });
    const text = result.value;
    return {
      id,
      name: file.name,
      kind: "text",
      mediaType: "text/plain",
      text: text.trim() ? text : EMPTY_DOCUMENT_TEXT,
      size: file.size,
    };
  }
  // Spreadsheets: the parser lives in Rust (calamine). The picker only
  // hands us a File, so use the bytes-in command — no temp file needed.
  if (
    lower.endsWith(".xlsx") ||
    lower.endsWith(".xlsm") ||
    lower.endsWith(".xlsb") ||
    lower.endsWith(".xls") ||
    lower.endsWith(".ods")
  ) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const data = await invoke<SpreadsheetData>(
      "fs_parse_spreadsheet_bytes",
      { bytes: Array.from(bytes) },
    );
    const text = spreadsheetToText(data);
    return {
      id,
      name: file.name,
      kind: "text",
      mediaType: "text/plain",
      text: text.trim() ? text : EMPTY_DOCUMENT_TEXT,
      size: file.size,
    };
  }
  if (file.size > MAX_TEXT_INLINE) return null;
  const text = await file.text();
  return {
    id,
    name: file.name,
    kind: "text",
    mediaType: file.type || "text/plain",
    text,
    size: file.size,
  };
}

function readAsDataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
