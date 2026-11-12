import { useChatStore } from "../../store/chatStore";

/**
 * One detached generation job. A job may own SEVERAL tool-call cards: the
 * model retrying the same prompt (see the dedupe note on spawnMediaTask)
 * attaches to the in-flight job instead of firing a second provider request,
 * so every attached card receives the same result and none is left spinning.
 */
type MediaJob = {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  /** Silence the terminal patch (session deletion: there is no chat left). */
  silent: boolean;
  toolCallIds: Set<string>;
};

/** sessionId -> jobKey -> job. The jobKey is the dedupe key when one is
 *  supplied, else a per-call unique id. */
const activeJobs = new Map<string, Map<string, MediaJob>>();

/** sessionId -> jobKey -> output of the last SUCCESSFUL job for that key.
 *  Bounded per session so a long chat cannot accumulate image base64 forever
 *  (each entry can be megabytes). */
const completedJobs = new Map<string, Map<string, unknown>>();
const COMPLETED_KEY_CAP = 12;

const DEFAULT_MEDIA_TIMEOUT_MS = 10 * 60_000;

function rememberCompleted(sessionId: string, jobKey: string, output: unknown) {
  // Only successes: a failure must be retryable.
  if (!output || typeof output !== "object" || "error" in output) return;
  let done = completedJobs.get(sessionId);
  if (!done) {
    done = new Map();
    completedJobs.set(sessionId, done);
  }
  done.delete(jobKey);
  done.set(jobKey, output);
  while (done.size > COMPLETED_KEY_CAP) {
    const oldest = done.keys().next().value;
    if (oldest === undefined) break;
    done.delete(oldest);
  }
}

/**
 * Cancel this session's detached media jobs.
 *
 * `reason` given (user pressed Stop) → each job resolves to a visible
 * `{error}` so its cards stop spinning. Omitted (session deleted) → silent:
 * there is no chat left to patch, and patching would resignal a deleted
 * session's stale placeholder back to disk.
 */
export function cancelMediaTasksForSession(
  sessionId: string,
  reason?: string,
): void {
  // A cancelled/finished session keeps no reuse cache (it may hold megabytes
  // of base64, and a deleted session must not be able to reply from it).
  if (reason === undefined) completedJobs.delete(sessionId);
  const jobs = activeJobs.get(sessionId);
  if (!jobs) return;
  // Do NOT drop the map entry here: each job's own settle/finally decides
  // whether it is still current, so an eager delete would make every
  // cancellation look like a stale task and silently skip the visible
  // {error} patch (the card kept spinning after Stop).
  for (const job of jobs.values()) {
    if (job.timer !== null) clearTimeout(job.timer);
    job.silent = reason === undefined;
    job.controller.abort(
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
 *
 * DEDUPE (2026-11-12): a model that sees `{status:"generating"}` and reads it
 * as a failure calls the tool again — sometimes for the same prompt, several
 * times in one turn ("you are generating images in loop and I only wanted
 * one"). Passing `dedupeKey` (engine + prompt + options) makes the second call
 * ATTACH to the in-flight job: one provider request, and every attached card
 * gets the same image when it lands. Without it each retry burned a paid
 * generation and produced a second card.
 *
 * The key ALSO covers finished jobs within the session: a retry queued after
 * the image landed reuses that result instead of generating (and paying for)
 * the same picture twice.
 */
export function spawnMediaTask(
  sessionId: string | null,
  toolCallId: string,
  run: () => Promise<unknown>,
  timeoutMs = DEFAULT_MEDIA_TIMEOUT_MS,
  dedupeKey?: string,
): void {
  if (!sessionId) {
    // There is no transcript to patch, but never swallow the provider's
    // failure silently: the console still explains why nothing arrived.
    void run().catch((e) =>
      console.error("Media generation failed without a chat session:", e),
    );
    return;
  }

  const jobKey = dedupeKey ?? `call:${toolCallId}`;
  let jobs = activeJobs.get(sessionId);
  if (!jobs) {
    jobs = new Map();
    activeJobs.set(sessionId, jobs);
  }

  const inFlight = dedupeKey ? jobs.get(jobKey) : undefined;
  if (inFlight) {
    // Same request already running: share its result instead of paying for
    // and displaying a duplicate generation.
    inFlight.toolCallIds.add(toolCallId);
    return;
  }

  const alreadyDone = dedupeKey ? completedJobs.get(sessionId)?.get(jobKey) : undefined;
  if (alreadyDone !== undefined) {
    // Same request already succeeded this session (the model retried after
    // the card had already resolved). Re-publish the existing image to this
    // card instead of generating the same picture a second time.
    useChatStore.getState().resolveMedia(sessionId, toolCallId, alreadyDone);
    return;
  }

  const controller = new AbortController();
  const job: MediaJob = {
    controller,
    timer: null,
    silent: false,
    toolCallIds: new Set([toolCallId]),
  };
  jobs.set(jobKey, job);
  const isCurrent = () => activeJobs.get(sessionId)?.get(jobKey) === job;

  const settle = (output: unknown) => {
    if (!isCurrent() || job.silent) return;
    for (const id of job.toolCallIds) {
      useChatStore.getState().resolveMedia(sessionId, id, output);
    }
  };

  job.timer = setTimeout(() => {
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
      if (dedupeKey) rememberCompleted(sessionId, jobKey, output);
    } catch (e) {
      // A failed job is a terminal state, not "generating" forever. The
      // provider's reason stays visible in the originating tool card.
      settle({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (job.timer !== null) clearTimeout(job.timer);
      if (isCurrent()) jobs.delete(jobKey);
      if (jobs.size === 0) activeJobs.delete(sessionId);
    }
  })();
}
