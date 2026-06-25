import { useChat, type UIMessage } from "@ai-sdk/react";
import type { ToolUIPart, UIMessagePart } from "ai";
import { useEffect, useMemo, useRef } from "react";
import { native } from "../lib/native";
import { checkReadable } from "../lib/security";
import { resolvePath } from "../tools/tools";
import {
  FILE_MUTATION_TOOLS,
  flushPersist,
  getOrCreateChat,
  useChatStore,
  type AgentRunStatus,
} from "../store/chatStore";

/**
 * Headless bridge that mirrors chat lifecycle into the store, so the status
 * pill / mini-window / panel can react without being inside the chat hook tree.
 *
 * Side effects:
 *  - Patches `agentMeta` on every status / approvals change.
 *  - Auto-opens the mini-window when an approval is pending — the user has
 *    to act on it; hiding it would be hostile.
 *  - For pending `write_file` calls, opens an AI diff tab in the editor area
 *    so the user can review the proposed change before approving.
 *  - Persists messages of the active session on every change.
 */

export type DiffOpenInput = {
  path: string;
  originalContent: string;
  proposedContent: string;
  approvalId: string;
  isNewFile: boolean;
};

export type AgentRunBridgeProps = {
  openAiDiffTab: (input: DiffOpenInput) => number | null;
  closeAiDiffTab: (approvalId: string) => void;
};

export function AgentRunBridge(props: AgentRunBridgeProps) {
  const sessionId = useChatStore((s) => s.activeSessionId);
  if (!sessionId) return null;
  return <Bridge sessionId={sessionId} {...props} />;
}

type BridgeProps = { sessionId: string } & AgentRunBridgeProps;

type WriteFileInput = { path?: unknown; content?: unknown };

type ToolPartLike = ToolUIPart & {
  approval?: { id: string };
  input?: WriteFileInput;
};

type AnyPart = UIMessagePart<Record<string, never>, Record<string, never>>;

function Bridge({
  sessionId,
  openAiDiffTab,
  closeAiDiffTab,
}: BridgeProps) {
  // getOrCreateChat returns a cached Chat instance per session id. On fast
  // session switches the useMemo swaps the reference, but since Chat instances
  // are long-lived and keyed by id, useChat simply reconnects to the existing
  // subscription — no state is lost.
  const chat = useMemo(() => getOrCreateChat(sessionId), [sessionId]);
  const { status, messages, addToolApprovalResponse } = useChat<UIMessage>({
    chat,
  });
  const patch = useChatStore((s) => s.patchAgentMeta);
  const openMini = useChatStore((s) => s.openMini);
  const persistMessages = useChatStore((s) => s.persistMessages);
  const setApprovalResponder = useChatStore((s) => s.setApprovalResponder);

  // Expose the approval responder so the diff tab can resolve approvals.
  // We keep it in a ref-stable closure so identity is stable per render.
  // Wrapped in try-catch: if the agent was stopped/restarted between the
  // approval card opening and the user clicking Accept/Reject, the Chat
  // may no longer have the tool call (stripped by stripIncompleteToolCalls)
  // and addToolApprovalResponse throws "Tool call not found". Swallow it.
  useEffect(() => {
    setApprovalResponder((id, approved) => {
      try {
        addToolApprovalResponse({ id, approved });
      } catch (e) {
        console.debug("[kai] stale approval ignored:", id, e);
      }
    });
    return () => setApprovalResponder(null);
  }, [setApprovalResponder, addToolApprovalResponse]);

  useEffect(() => {
    persistMessages(sessionId, messages);
  }, [sessionId, messages, persistMessages]);

  // Flush the debounced write whenever the chat goes idle (or errors),
  // and on unmount, so a closed app or session-switch never loses the tail.
  useEffect(() => {
    if (status !== "submitted" && status !== "streaming") {
      flushPersist(sessionId);
    }
  }, [sessionId, status]);
  useEffect(() => {
    return () => flushPersist(sessionId);
  }, [sessionId]);

  const approvalsPending = useMemo(() => {
    let n = 0;
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      for (const p of m.parts) {
        if ((p as { state?: string }).state === "approval-requested") n++;
      }
    }
    return n;
  }, [messages]);

  const prevStatusRef = useRef(status);
  const nudgeCountRef = useRef(0);
  const prevMessageCountRef = useRef(messages.length);
  const focusInput = useChatStore((s) => s.focusInput);

  // ---- Steering message injection -------------------------------------------
  // When the user sends a message while the agent is busy, stop the current
  // run first (so incomplete tool_use parts get cleaned up by
  // stripIncompleteToolCalls in the transport), then inject the steering
  // message once the status settles to idle.
  const steeringMessage = useChatStore((s) => s.steeringMessage);
  const setSteeringMessage = useChatStore((s) => s.setSteeringMessage);
  useEffect(() => {
    if (!steeringMessage) return;
    if (status === "submitted" || status === "streaming") {
      // Agent is still running — stop it so the next idle transition picks
      // up the queued steering message.
      void chat.stop();
      return;
    }
    const msg = steeringMessage;
    setSteeringMessage(null);
    // Small delay lets the Chat internals settle after stop() before we
    // send the new message.
    const t = setTimeout(() => {
      void chat.sendMessage({
        role: "user",
        parts: [{ type: "text", text: msg }],
      });
    }, 150);
    return () => clearTimeout(t);
  }, [steeringMessage, status, chat, setSteeringMessage]);

  // Reset nudge counter when the user sends a new message (message count
  // increases with a user-role message), not on every idle transition.
  useEffect(() => {
    if (messages.length > prevMessageCountRef.current) {
      const newest = messages[messages.length - 1];
      if (newest?.role === "user") nudgeCountRef.current = 0;
    }
    prevMessageCountRef.current = messages.length;
  }, [messages.length, messages]);

  useEffect(() => {
    let runStatus: AgentRunStatus;
    if (approvalsPending > 0) runStatus = "awaiting-approval";
    else if (status === "submitted") runStatus = "thinking";
    else if (status === "streaming") runStatus = "streaming";
    else if (status === "error") runStatus = "error";
    else runStatus = "idle";
    patch({
      status: runStatus,
      approvalsPending,
      ...(runStatus === "idle" || runStatus === "error"
        ? { step: null }
        : {}),
      ...(runStatus === "idle" ? { error: null } : {}),
    });
    // Auto-open the mini chat window when the agent is thinking or streaming!
    if (runStatus === "thinking" || runStatus === "streaming") {
      openMini();
    }
    // When the agent goes idle, check if it stopped prematurely (narrated
    // instead of acting). If so, auto-nudge it to continue.
    const wasActive =
      prevStatusRef.current === "submitted" ||
      prevStatusRef.current === "streaming";
    if (wasActive && runStatus === "idle" && messages.length > 0) {
      const last = messages[messages.length - 1];
      if (last?.role === "assistant" && shouldAutoNudge(last, nudgeCountRef.current)) {
        const text = last.parts
          .filter((p) => (p as { type?: string }).type === "text")
          .map((p) => (p as { text?: string }).text ?? "")
          .join(" ");
        const isLeak = 
          text.includes("<|tool_call") || 
          text.includes("<|tool_call:") || 
          text.includes("new_string:<|") || 
          text.includes("proposedContent:") ||
          (text.includes("<|\"|>") && text.includes("path:"));

        const nudgeText = isLeak
          ? "System correction: You generated raw JSON/text tool call parameters inside your response instead of executing the tool. Please execute the tool call using the proper native function-calling format."
          : "Continue";

        nudgeCountRef.current++;
        // Small delay so the UI settles before the next request.
        setTimeout(() => {
          void chat.sendMessage({
            role: "user",
            parts: [{ type: "text", text: nudgeText }],
          });
        }, 300);
      } else {
        focusInput(null);
      }
    }
    prevStatusRef.current = status;
  }, [status, approvalsPending, patch, focusInput, messages.length, chat]);

  useEffect(() => {
    if (approvalsPending > 0) openMini();
  }, [approvalsPending, openMini]);

  // ---- Auto-approve effect --------------------------------------------------
  const autoApprove = useChatStore((s) => s.autoApprove);
  const markAutoApproved = useChatStore((s) => s.markAutoApproved);
  const autoApprovedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    autoApprovedRef.current = new Set();
  }, [sessionId]);

  useEffect(() => {
    if (autoApprove === "off") return;
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      for (const p of m.parts as AnyPart[]) {
        const state = (p as { state?: string }).state;
        if (state !== "approval-requested") continue;
        const id = (p as { approval?: { id?: string } }).approval?.id;
        if (!id || autoApprovedRef.current.has(id)) continue;
        // Determine the tool name.
        const type = (p as { type?: string }).type ?? "";
        const toolName = type.replace(/^tool-/, "");
        const shouldApprove =
          autoApprove === "all" ||
          (autoApprove === "edits" && FILE_MUTATION_TOOLS.has(toolName));
        if (!shouldApprove) continue;
        autoApprovedRef.current.add(id);
        markAutoApproved(id);
        try {
          addToolApprovalResponse({ id, approved: true });
        } catch {
          // Tool call may have been cleaned up already.
        }
      }
    }
  }, [messages, autoApprove, addToolApprovalResponse, markAutoApproved]);

  // ---- AI diff tab management ----------------------------------------------
  // We track which approvalIds have already opened a tab so re-renders don't
  // open duplicates. Reset when the session changes.
  const openedRef = useRef<Set<string>>(new Set());
  const fileMutationFingerprintRef = useRef<string>("");
  useEffect(() => {
    openedRef.current = new Set();
    fileMutationFingerprintRef.current = "";
  }, [sessionId]);

  // Cheap fingerprint of file-mutation tool parts only. The diff-tab effect
  // is the most expensive thing on the streaming path, so we skip it when
  // only text/reasoning tokens have arrived (the common case).
  const fileMutationFingerprint = useMemo(() => {
    let fp = "";
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      for (const p of m.parts as AnyPart[]) {
        const t = (p as { type?: string }).type;
        if (
          t === "tool-write_file" ||
          t === "tool-edit" ||
          t === "tool-multi_edit"
        ) {
          const state = (p as { state?: string }).state ?? "";
          const id =
            (p as { approval?: { id?: string } }).approval?.id ?? "";
          fp += `${id}:${state}|`;
        }
      }
    }
    return fp;
  }, [messages]);

  useEffect(() => {
    type Pending = {
      approvalId: string;
      path: string;
      /**
       * Either a literal proposed content (write_file), or a function that
       * derives proposed content from the on-disk original (edit/multi_edit).
       */
      derive:
        | { kind: "literal"; content: string }
        | { kind: "edits"; edits: EditOp[] };
    };
    if (fileMutationFingerprint === fileMutationFingerprintRef.current) {
      return;
    }
    fileMutationFingerprintRef.current = fileMutationFingerprint;

    const pending: Pending[] = [];
    const toClose = new Set<string>();

    for (const m of messages) {
      if (m.role !== "assistant") continue;
      for (const part of m.parts as AnyPart[]) {
        const info = extractFileMutation(part);
        if (!info) continue;
        const { state, approvalId, path, derive } = info;
        if (!approvalId) continue;
        if (state === "approval-requested") {
          if (!openedRef.current.has(approvalId)) {
            pending.push({ approvalId, path, derive });
          }
        } else if (
          state === "approval-responded" ||
          state === "output-available" ||
          state === "output-error"
        ) {
          if (openedRef.current.has(approvalId)) toClose.add(approvalId);
        }
      }
    }

    for (const id of toClose) {
      openedRef.current.delete(id);
      closeAiDiffTab(id);
    }

    if (pending.length === 0) return;

    let cancelled = false;
    void (async () => {
      const cwd = useChatStore.getState().live.getCwd();
      for (const p of pending) {
        if (cancelled) return;
        // Mark as opened up-front so a re-render mid-await doesn't double-open.
        openedRef.current.add(p.approvalId);
        let abs: string;
        try {
          abs = resolvePath(p.path, cwd);
        } catch {
          abs = p.path;
        }
        const original = await readOriginal(abs);
        if (cancelled) return;
        let proposed = "";
        if (p.derive.kind === "literal") {
          proposed = p.derive.content;
        } else {
          const r = applyEditsLocally(original.content, p.derive.edits);
          if (r.ok) {
            proposed = r.content;
          } else {
            // Edit precondition failed — show a best-effort diff by
            // concatenating the new_string values so the user can still
            // review what the model proposed.
            proposed = original.content + "\n/* [Kai: edit could not be applied cleanly — showing raw proposal] */\n" +
              p.derive.edits.map((e) => e.new_string).join("\n");
          }
        }
        openAiDiffTab({
          path: abs,
          originalContent: original.content,
          proposedContent: proposed,
          approvalId: p.approvalId,
          isNewFile: original.isNewFile,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [messages, fileMutationFingerprint, openAiDiffTab, closeAiDiffTab]);

  return null;
}

type EditOp = { old_string: string; new_string: string; replace_all?: boolean };

type FileMutation =
  | {
      state: string;
      approvalId: string | null;
      path: string;
      derive: { kind: "literal"; content: string };
    }
  | {
      state: string;
      approvalId: string | null;
      path: string;
      derive: { kind: "edits"; edits: EditOp[] };
    };

function extractFileMutation(part: AnyPart): FileMutation | null {
  const type = (part as { type?: string }).type;
  const p = part as ToolPartLike;
  const state = (p as { state?: string }).state ?? "";
  const approvalId = p.approval?.id ?? null;

  if (type === "tool-write_file") {
    const input = (p.input ?? {}) as WriteFileInput;
    const path = typeof input.path === "string" ? input.path : "";
    const content = typeof input.content === "string" ? input.content : "";
    if (!path) return null;
    return { state, approvalId, path, derive: { kind: "literal", content } };
  }
  if (type === "tool-edit") {
    const input = (p.input ?? {}) as {
      path?: unknown;
      old_string?: unknown;
      new_string?: unknown;
      replace_all?: unknown;
    };
    const path = typeof input.path === "string" ? input.path : "";
    const oldStr = typeof input.old_string === "string" ? input.old_string : "";
    const newStr = typeof input.new_string === "string" ? input.new_string : "";
    if (!path) return null;
    return {
      state,
      approvalId,
      path,
      derive: {
        kind: "edits",
        edits: [
          {
            old_string: oldStr,
            new_string: newStr,
            replace_all: Boolean(input.replace_all),
          },
        ],
      },
    };
  }
  if (type === "tool-multi_edit") {
    const input = (p.input ?? {}) as { path?: unknown; edits?: unknown };
    const path = typeof input.path === "string" ? input.path : "";
    if (!path || !Array.isArray(input.edits)) return null;
    const edits: EditOp[] = (input.edits as Record<string, unknown>[])
      .map((e) => ({
        old_string: typeof e.old_string === "string" ? e.old_string : "",
        new_string: typeof e.new_string === "string" ? e.new_string : "",
        replace_all: Boolean(e.replace_all),
      }))
      .filter((e) => e.old_string.length > 0);
    if (edits.length === 0) return null;
    return { state, approvalId, path, derive: { kind: "edits", edits } };
  }
  return null;
}

function applyEditsLocally(
  original: string,
  edits: EditOp[],
): { ok: true; content: string } | { ok: false } {
  let content = original;
  for (const e of edits) {
    if (e.old_string === e.new_string || e.old_string.length === 0)
      return { ok: false };
    if (e.replace_all) {
      if (!content.includes(e.old_string)) return { ok: false };
      content = content.split(e.old_string).join(e.new_string);
    } else {
      const first = content.indexOf(e.old_string);
      if (first === -1) return { ok: false };
      const second = content.indexOf(e.old_string, first + 1);
      if (second !== -1) return { ok: false };
      content =
        content.slice(0, first) +
        e.new_string +
        content.slice(first + e.old_string.length);
    }
  }
  return { ok: true, content };
}

/**
 * Detect when the agent stopped with narration instead of acting.
 * Returns true if the last message looks like the model announced a tool
 * call but never made one — e.g. "Let me read the file" then stopped.
 * Limits to 2 auto-nudges per agent run to prevent infinite loops.
 */
function shouldAutoNudge(msg: UIMessage, nudgesSoFar: number): boolean {
  if (nudgesSoFar >= 2) return false;
  const parts = msg.parts;
  if (parts.length === 0) return false;
  // Only nudge if the response is text-only (no tool calls at all).
  const hasToolCall = parts.some((p) => {
    const t = (p as { type?: string }).type ?? "";
    return t.startsWith("tool-") || t === "dynamic-tool";
  });
  if (hasToolCall) return false;
  // Check if the text mentions intent to act without having acted.
  const text = parts
    .filter((p) => (p as { type?: string }).type === "text")
    .map((p) => (p as { text?: string }).text ?? "")
    .join(" ");

  // Check if the text contains raw leaked JSON tool-call tokens/delimiters
  const hasLeakedToolCall = 
    text.includes("<|tool_call") || 
    text.includes("<|tool_call:") || 
    text.includes("new_string:<|") || 
    text.includes("proposedContent:") ||
    (text.includes("<|\"|>") && text.includes("path:"));

  if (hasLeakedToolCall) return true;

  const lowerText = text.toLowerCase();
  const intentPatterns = [
    /\b(?:let me|i(?:'ll| will| need to| should| can))\s+(?:read|check|look|examine|open|search|scan|grep|find|review|analyze|inspect|explore)/,
    /\b(?:first|now),?\s+(?:i(?:'ll| will| need to))\b/,
    /\b(?:let's|i'm going to)\s+(?:start|begin|take a look)/,
  ];
  return intentPatterns.some((re) => re.test(lowerText));
}

async function readOriginal(
  abs: string,
): Promise<{ content: string; isNewFile: boolean }> {
  // The fs guard rejects sensitive paths even on read; mirror that here so
  // the user sees an empty "before" rather than an error tab.
  const safety = checkReadable(abs);
  if (!safety.ok) return { content: "", isNewFile: false };
  try {
    const r = await native.readFile(abs);
    if (r.kind === "text") return { content: r.content, isNewFile: false };
    // Binary or oversized — we can't render the original sensibly. Show the
    // proposed content as a "new" view; the user can still cancel.
    return { content: "", isNewFile: false };
  } catch (e) {
    const msg = String(e).toLowerCase();
    const notFound =
      msg.includes("no such file") ||
      msg.includes("not found") ||
      msg.includes("os error 2");
    return { content: "", isNewFile: notFound };
  }
}
