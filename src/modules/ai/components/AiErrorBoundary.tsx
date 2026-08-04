import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

type Props = {
  children: ReactNode;
  /** Optional label shown in the fallback UI. */
  label?: string;
};

type State = {
  error: Error | null;
};

/**
 * Catches render errors from AI components so a single corrupted chat or
 * tool call doesn't unmount the entire React tree (blank screen).
 */
export class AiErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      `[AiErrorBoundary${this.props.label ? `:${this.props.label}` : ""}]`,
      error,
      info.componentStack,
    );
  }

  render() {
    if (this.state.error) {
      // Render nothing — the AI panel/mini-window collapses gracefully.
      // The rest of the app (terminal, editor, etc.) continues to work.
      return null;
    }
    return this.props.children;
  }
}
