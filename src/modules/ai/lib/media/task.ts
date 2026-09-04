import { useChatStore } from "../../store/chatStore";

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
): void {
  if (!sessionId) {
    // No live session to patch — still run, but nothing to surface it into.
    void run().catch(() => {});
    return;
  }

  void (async () => {
    try {
      const output = await run();
      if (signal?.aborted) return;
      useChatStore.getState().resolveMedia(sessionId, toolCallId, output);
    } catch (e) {
      if (signal?.aborted) return;
      useChatStore.getState().resolveMedia(sessionId, toolCallId, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  })();
}
