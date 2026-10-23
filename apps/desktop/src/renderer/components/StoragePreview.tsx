/**
 * Inline preview pane for the storage explorer's detail area.
 *
 * Renders an **image** in an `<img>` or a **PDF** in an `<iframe>`, both from a
 * `blob:` URL produced by `useStoragePreview` (never pointed at the remote
 * storage URL, which would download rather than display). A file we cannot
 * preview keeps a neutral placeholder, and a load error degrades to a clear
 * "Preview unavailable" state instead of a blank pane.
 */

import type { CSSProperties } from 'react';
import type { PreviewState } from '../storage/use-storage-preview.js';

const frame: CSSProperties = {
  marginTop: 8,
  border: '1px solid #2a333d',
  borderRadius: 8,
  background: '#0b1015',
  padding: 10,
};

const note: CSSProperties = { color: '#8a97a5', fontSize: 12, margin: 0 };

export type StoragePreviewProps = {
  state: PreviewState;
  /** Re-fetch after a transient failure. */
  onRetry?: () => void;
  /** Height budget for the rendered preview. */
  maxHeight?: number;
};

export function StoragePreview({ state, onRetry, maxHeight = 320 }: StoragePreviewProps) {
  if (state.status === 'idle') return null;

  if (state.status === 'unsupported') {
    return (
      <div style={frame} data-testid="storage-preview-unsupported">
        <p style={note}>No inline preview for this file type. Use Save… to open it locally.</p>
      </div>
    );
  }

  if (state.status === 'too-large') {
    return (
      <div style={frame} data-testid="storage-preview-too-large">
        <p style={note}>This file is too large to preview. Use Save… to open it locally.</p>
      </div>
    );
  }

  if (state.status === 'loading') {
    return (
      <div style={frame} data-testid="storage-preview-loading">
        <p style={note}>Loading preview…</p>
      </div>
    );
  }

  if (state.status === 'unavailable') {
    return (
      <div style={frame} data-testid="storage-preview-unavailable">
        <p style={note}>Preview unavailable.</p>
        <p style={{ ...note, marginTop: 2 }}>{state.reason}</p>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            style={{
              marginTop: 6,
              padding: '4px 10px',
              borderRadius: 8,
              border: '1px solid #3a4654',
              background: '#1c2430',
              color: '#e8eef4',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            Retry
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div style={frame} data-testid={`storage-preview-pane-${state.kind}`}>
      {state.kind === 'image' ? (
        <img
          src={state.url}
          alt=""
          data-testid="storage-preview-image"
          style={{ display: 'block', maxWidth: '100%', maxHeight, objectFit: 'contain' }}
        />
      ) : (
        <iframe
          src={state.url}
          title="PDF preview"
          data-testid="storage-preview-pdf"
          style={{ display: 'block', width: '100%', height: maxHeight, border: 'none', background: '#fff' }}
        />
      )}
    </div>
  );
}
