import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

type Props = {
  children: ReactNode;
  /** Window surface name shown in the crash card ("main" / "settings"). */
  surface?: string;
};

type State = {
  error: Error | null;
};

/**
 * Last-resort error boundary for a WINDOW ROOT. Without it, any uncaught
 * render error unmounts the entire React tree and the user sees only the
 * page background — the "themed blank window" failure: the process is
 * alive (IPC, PTYs, agent runs all continue) but nothing renders and nothing
 * is diagnosable from the UI.
 *
 * Unlike AiErrorBoundary (which collapses its section to null), this MUST
 * render a visible, themed crash card with the error text and a reload
 * action — the boundary is the only thing left on screen.
 */
export class RootErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Forwarded into the Rust log file by the console bridge (logging.ts),
    // so the crash leaves a paper trail in kai-<pid>.log next boot.
    console.error(
      `[RootErrorBoundary:${this.props.surface ?? "app"}] render crashed:`,
      error,
      info.componentStack,
    );
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const stack = error.stack ?? "";
    const details = `${error.name}: ${error.message}\n\n${stack}`;
    const reload = () => {
      try {
        window.location.reload();
      } catch {
        // Navigation can throw if the document is mid-teardown (HMR churn);
        // the user can still close/reopen the window.
      }
    };
    const copy = () => {
      void navigator.clipboard?.writeText(details).catch(() => undefined);
    };

    return (
      <div
        className="flex h-screen w-full flex-col items-center justify-center gap-3 bg-background px-6 text-foreground"
        role="alert"
      >
        <h1 className="text-sm font-semibold">
          KAI hit an unexpected error
        </h1>
        <p className="max-w-xl text-center text-xs text-muted-foreground">
          The interface crashed but the app is still running — terminals,
          agents, and background work continue. Reload to restore the UI.
        </p>
        <pre className="max-h-56 w-full max-w-2xl overflow-auto rounded-md border border-border/60 bg-card p-3 text-left font-mono text-[11px] leading-relaxed text-muted-foreground">
          {details}
        </pre>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={reload}
            className="rounded-md border border-border/60 bg-card px-3 py-1.5 text-xs transition-colors hover:bg-accent"
          >
            Reload interface
          </button>
          <button
            type="button"
            onClick={copy}
            className="rounded-md border border-border/60 bg-card px-3 py-1.5 text-xs transition-colors hover:bg-accent"
          >
            Copy details
          </button>
        </div>
      </div>
    );
  }
}
