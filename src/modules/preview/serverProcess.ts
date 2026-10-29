export type PreviewServerProcess = {
  handle: number;
  command: string;
  exited: boolean;
};

/** Match both explicit command-line ports and the localhost URL printed by
 * dev servers whose command (for example `pnpm dev`) has no port argument. */
export function textMentionsPort(text: string, port: string): boolean {
  const value = text.toLowerCase();
  const patterns = [
    `:${port}`,
    `--port ${port}`,
    `--port=${port}`,
    `-p ${port}`,
    `-p=${port}`,
    `port:${port}`,
    `port=${port}`,
    `localhost:${port}`,
    `127.0.0.1:${port}`,
    `0.0.0.0:${port}`,
    `:::${port}`,
  ];
  return patterns.some((pattern) => value.includes(pattern));
}

export async function findPreviewServerHandle(
  processes: PreviewServerProcess[],
  port: string,
  readLogs: (handle: number) => Promise<string>,
): Promise<number | null> {
  const running = processes.filter((process) => !process.exited);
  const commandMatch = running.find((process) =>
    textMentionsPort(process.command, port),
  );
  if (commandMatch) return commandMatch.handle;

  const logMatches = await Promise.all(
    running.map(async (process) => {
      try {
        return textMentionsPort(await readLogs(process.handle), port)
          ? process.handle
          : null;
      } catch {
        // A process may exit between listing and reading its logs.
        return null;
      }
    }),
  );
  // Avoid guessing when two running processes advertise the same URL.
  const matches = logMatches.filter((handle): handle is number => handle !== null);
  return matches.length === 1 ? matches[0] : null;
}
