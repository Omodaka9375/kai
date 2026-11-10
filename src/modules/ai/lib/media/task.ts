import { useChatStore } from "../../store/chatStore";

type MediaTask = { controller: AbortController; timer: ReturnType<typeof setTimeout> | null };
const activeTasks = new Map<string, Map<string, MediaTask>>();
const DEFAULT_MEDIA_TIMEOUT_MS = 10 * 60_000;

/** Deleting a session must also cancel its detached media jobs. Otherwise a
 *  late completion has no chat to patch and leaves a stale placeholder on
 *  disk; recreating the Chat here would risk restoring deleted history. */
export function cancelMediaTasksForSession(sessionId: string): void {
  const tasks = activeTasks.get(sessionId);
  if (!tasks) return;
  activeTasks.delete(sessionId);
  for (const task of tasks.values()) {
    if (task.timer !== null) clearTimeout(task.timer);
    task.controller.abort(new Error("Generation cancelled because the chat was deleted."));
  }
}

/**
 * Run a media-generation job in the background and patch its result back into
 * the originating tool-call part once it completes.
 *
 * The tool's `execute` returns a placeholder immediately so the agent step
 * finishes and the chat is not blocked for the (potentially minutes-long)
 * generation. When the job resolves, we find the assistant tool part by
 * `toolCallId` and swap its `output` for the real media payload, which
 * `MediaMessage` picks up on the next re-render.
 */
export function spawnMediaTask(
  sessionId: string | null,
  toolCallId: string,
  signal: AbortSignal | undefined,
  run: () => Promise<unknown>,
  timeoutMs = DEFAULT_MEDIA_TIMEOUT_MS,
): void {
  if (!sessionId) {
    // There is no transcript to patch, but never swallow the provider's
    // failure silently: the console still explains why nothing arrived.
    void run().catch((e) => console.error("Media generation failed without a chat session:", e));
    return;
  }

  const controller = new AbortController();
  const task: MediaTask = { controller, timer: null };
  let tasks = activeTasks.get(sessionId);
  if (!tasks) {
    tasks = new Map();
    activeTasks.set(sessionId, tasks);
  }
  tasks.set(toolCallId, task);
  const isCurrent = () => activeTasks.get(sessionId)?.get(toolCallId) === task;
  const onAbort = () => controller.abort(new Error("Generation cancelled before completion."));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const cancelled = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => {
      reject(controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new Error("Generation cancelled before completion."));
    }, { once: true });
  });
  task.timer = setTimeout(() => {
    controller.abort(new Error(`Generation timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
  }, timeoutMs);

  void (async () => {
    try {
      const output = await Promise.race([run(), cancelled]);
      if (isCurrent()) useChatStore.getState().resolveMedia(sessionId, toolCallId, output);
    } catch (e) {
      // A failed job is a terminal state, not "generating" forever. The
      // provider's reason stays visible in the originating tool card.
      if (isCurrent()) {
        useChatStore.getState().resolveMedia(sessionId, toolCallId, {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (task.timer !== null) clearTimeout(task.timer);
      if (isCurrent()) activeTasks.get(sessionId)?.delete(toolCallId);
      if (tasks.size === 0) activeTasks.delete(sessionId);
    }
  })();
}
