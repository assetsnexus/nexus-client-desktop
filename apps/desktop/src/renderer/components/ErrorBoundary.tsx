/**
 * A minimal React error boundary.
 *
 * Without one, a single throwing child (e.g. a settings panel calling a bridge
 * method an older preload does not expose) unmounts the *entire* tree and the
 * window goes blank. This keeps the failure local: the rest of the shell survives
 * and the user sees what broke instead of an empty view.
 */

import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from 'react';

type Props = {
  /** Short label for the region that failed, shown in the fallback. */
  label?: string;
  children: ReactNode;
};

type State = { error: Error | null };

const wrap: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 18,
  margin: 24,
  borderRadius: 12,
  background: '#1a1416',
  border: '1px solid #5b2a2a',
  color: '#f2a1a1',
  fontSize: 13,
  maxWidth: 760,
};

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the full component stack in the console for debugging; the UI stays terse.
    console.error('[nexus] render failed', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={wrap} role="alert">
        <strong style={{ color: '#f87171' }}>
          {this.props.label ? `${this.props.label} failed to load` : 'This view failed to load'}
        </strong>
        <span style={{ color: '#cbd5e1' }}>{error.message}</span>
        <span style={{ color: '#8b95a1', fontSize: 12 }}>
          The rest of the app still works. If this appeared after an update, restart the app so the
          main process picks up the new bundle.
        </span>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          style={{
            alignSelf: 'flex-start',
            marginTop: 4,
            padding: '6px 12px',
            borderRadius: 8,
            border: '1px solid #3f6cb0',
            background: '#2f5c9e',
            color: '#fff',
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          Try again
        </button>
      </div>
    );
  }
}
