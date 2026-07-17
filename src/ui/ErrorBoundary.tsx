/**
 * Last-resort crash guard for the public build: a rendering error anywhere in
 * the tree shows a friendly recovery card instead of a white screen. The
 * engine itself never throws into React (useGame catches EngineErrors as
 * toasts) — this catches genuine UI bugs.
 */

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // No telemetry by design (the game collects nothing); log locally so a
    // player reporting a bug can open the console and copy the details.
    console.error('Whimsy Wars crashed:', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="setup-screen">
        <div className="setup-card crash-card" role="alert">
          <h1 className="game-title">🥀 The garden wilted</h1>
          <p className="tagline">
            Something went wrong and the game couldn't recover. Reloading returns you to the
            setup screen — your current match can't be restored (saved games are on the roadmap).
          </p>
          <details className="crash-details">
            <summary>Technical details (for a bug report)</summary>
            <pre>{`${this.state.error.name}: ${this.state.error.message}\n${this.state.error.stack ?? ''}`}</pre>
          </details>
          <button type="button" className="btn accent big" onClick={() => window.location.reload()}>
            🔄 Reload the game
          </button>
        </div>
      </div>
    );
  }
}
