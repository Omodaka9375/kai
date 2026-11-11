import { useChatStore } from "../../store/chatStore";

type MediaTask = {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  /** Silence the terminal patch (session deletion: there is no chat left). */
  silent: boolean;
};
const activeTasks = new Map<string, Map<string, MediaTask>>();
const DEFAULT_MEDIA_TIMEOUT_MS = 10 * 60_000;

/**
 * Cancel this session's detached media jobs.
 *
 * `reason` given (user pressed Stop) → each job resolves to a visible
 * `{error}` so its card stops spinning. Omitted (session deleted) → silent:
 * there is no chat left to patch, and patching would resignal a deleted
 * session's stale placeholder back to disk.
 */
export function cancelMediaTasksForSession(
  sessionId: string,
  reason?: string,
): void {
  const tasks = activeTasks.get(sessionId);
  if (!tasks) return;
  // Do NOT drop the map entry here: each job's own settle/finally decides
  // whether it is still current, so an eager delete would make every
  // cancellation look like a stale task and silently skip the visible
  // {error} patch (the card kept spinning after Stop).
  for (const task of tasks.values()) {
    if (task.timer !== null) clearTimeout(task.timer);
    task.silent = reason === undefined;
    task.controller.abort(
      new Error(reason ?? "Generation cancelled because the chat was deleted."),
    );
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
 *
 * LIFECYCLE (2026-11-12): the job is deliberately NOT tied to the agent run's
 * AbortSignal. That signal is aborted whenever a new run supersedes the
 * current one (registerRunController) — i.e. as soon as the user sends
 * anything, or the next turn starts — so every generation was killed seconds
 * after it began and surfaced as "Generation cancelled before completion.",
 * leaving the card stuck on "generating". Detached background work must only
 * die from its own timeout or an explicit session-level cancel.
 */
export function spawnMediaTask(
  sessionId: string | null,
  toolCallId: string,
  run: () => Promise<unknown>,
  timeoutMs = DEFAULT_MEDIA_TIMEOUT_MS,
): void {
  if (!sessionId) {
    // There is no transcript to patch, but never swallow the provider's
    // failure silently: the console still explains why nothing arrived.
    void run().catch((e) =>
      console.error("Media generation failed without a chat session:", e),
    );
    return;
  }

  const controller = new AbortController();
  const task: MediaTask = { controller, timer: null, silent: false };
  let tasks = activeTasks.get(sessionId);
  if (!tasks) {
    tasks = new Map();
    activeTasks.set(sessionId, tasks);
  }
  tasks.set(toolCallId, task);
  const isCurrent = () => activeTasks.get(sessionId)?.get(toolCallId) === task;

  const settle = (output: unknown) => {
    if (!isCurrent()) return;
    if (!task.silent) {
      useChatStore.getState().resolveMedia(sessionId, toolCallId, output);
    }
  };

  task.timer = setTimeout(() => {
    controller.abort(
      new Error(
        `Generation timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
      ),
    );
  }, timeoutMs);

  void (async () => {
    try {
      // The run itself does not observe the controller — providers only see
      // `opts.signal` where one is explicitly threaded. Racing it keeps the
      // card honest when we DO cancel (timeout / Stop / session delete).
      const cancelled = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () =>
            reject(
              controller.signal.reason instanceof Error
                ? controller.signal.reason
                : new Error("Generation cancelled before completion."),
            ),
          { once: true },
        );
      });
      const output = await Promise.race([run(), cancelled]);
      settle(output);
    } catch (e) {
      // A failed job is a terminal state, not "generating" forever. The
      // provider's reason stays visible in the originating tool card.
      settle({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (task.timer !== null) clearTimeout(task.timer);
      if (isCurrent()) activeTasks.get(sessionId)?.delete(toolCallId);
      if (tasks.size === 0) activeTasks.delete(sessionId);
    }
  })();
}
