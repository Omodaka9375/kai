import {
  error as logError,
  warn as logWarn,
  info as logInfo,
} from "@tauri-apps/plugin-log";

let installed = false;

function formatArg(a: unknown): string {
  if (a instanceof Error) {
    return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ""}`;
  }
  if (typeof a === "string") return a;
  if (typeof a === "number" || typeof a === "boolean") return String(a);
  if (a === null) return "null";
  if (a === undefined) return "undefined";
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

/**
 * Forward browser `console.error` / `console.warn` into the Rust log so they
 * land in the rotating log file and the crash-report bundle. `console.info`
 * is included too so non-fatal status messages have a paper trail, but only
 * warn+error are forwarded by default to keep the file lean.
 *
 * The forward is fire-and-forget and never throws: logging must not take down
 * the app it is meant to debug.
 */
export function installConsoleLogBridge(): void {
  if (installed) return;
  installed = true;

  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  const origInfo = console.info.bind(console);

  console.error = (...args: unknown[]) => {
    origError(...args);
    try {
      void logError(args.map(formatArg).join(" "));
    } catch {
      /* ignore */
    }
  };

  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    try {
      void logWarn(args.map(formatArg).join(" "));
    } catch {
      /* ignore */
    }
  };

  console.info = (...args: unknown[]) => {
    origInfo(...args);
    try {
      void logInfo(args.map(formatArg).join(" "));
    } catch {
      /* ignore */
    }
  };
}
