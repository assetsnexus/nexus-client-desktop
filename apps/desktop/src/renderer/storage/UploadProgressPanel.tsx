/**
 * Upload progress panel (self-contained).
 *
 * Renders the per-file rows and the aggregate of an upload batch. It is a pure
 * view over an `UploadQueueSnapshot`; all state lives in the queue module, so
 * this component can be rendered in isolation (tests, harness) with a snapshot
 * literal.
 *
 * Progress honesty: a row only shows a percentage when the transport reported
 * byte granularity. When the backend can only accept one base64 command, the bar
 * is indeterminate and the row says so — it never fabricates a number.
 */

import type { CSSProperties } from 'react';
import { formatBytes, transferPercent } from '../../shared/storage-transfer.js';
import type { UploadItem, UploadQueueSnapshot } from './upload-queue.js';

const panelStyle: CSSProperties = {
  borderTop: '1px solid #2a333d',
  background: '#12171c',
  padding: '8px 10px',
  maxHeight: 200,
  overflowY: 'auto',
};

const btnStyle: CSSProperties = {
  padding: '3px 8px',
  borderRadius: 6,
  border: '1px solid #3a4654',
  background: '#1c2430',
  color: '#e8eef4',
  cursor: 'pointer',
  fontSize: 11,
};

const STATE_COLOR: Record<UploadItem['state'], string> = {
  queued: '#8a97a5',
  uploading: '#6fa8dc',
  done: '#8fd08f',
  failed: '#f2a1a1',
  cancelled: '#c9a227',
};

export type UploadProgressPanelProps = {
  snapshot: UploadQueueSnapshot;
  onCancelAll: () => void;
  onCancelOne: (id: string) => void;
  onRetryOne: (id: string) => void;
  onRetryAllFailed: () => void;
  onClearFinished: () => void;
};

export function UploadProgressPanel(props: UploadProgressPanelProps) {
  const { snapshot } = props;
  const nothing = snapshot.items.length === 0;
  if (nothing) return null;

  const aggregate = transferPercent(snapshot.sentBytes, snapshot.totalBytes, false);
  const finished = snapshot.counts.done + snapshot.counts.failed + snapshot.counts.cancelled;

  return (
    <div style={panelStyle} data-testid="upload-progress-panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: '#9aa7b5', textTransform: 'uppercase' }}>Uploads</span>
        <span style={{ fontSize: 11, color: '#6b7784' }} data-testid="upload-aggregate">
          {snapshot.counts.done}/{snapshot.items.length} done · {formatBytes(snapshot.sentBytes)} /{' '}
          {formatBytes(snapshot.totalBytes)}
          {snapshot.indeterminate ? ' (some sizes are estimates)' : aggregate != null ? ` · ${aggregate}%` : ''}
        </span>
        <span style={{ flex: 1 }} />
        {snapshot.counts.failed > 0 || snapshot.counts.cancelled > 0 ? (
          <button type="button" style={btnStyle} onClick={props.onRetryAllFailed}>
            Retry failed ({snapshot.counts.failed + snapshot.counts.cancelled})
          </button>
        ) : null}
        {snapshot.active ? (
          <button type="button" style={btnStyle} onClick={props.onCancelAll}>
            Cancel all
          </button>
        ) : finished > 0 ? (
          <button type="button" style={btnStyle} onClick={props.onClearFinished}>
            Clear finished
          </button>
        ) : null}
      </div>

      {snapshot.items.map((item) => (
        <UploadRow
          key={item.id}
          item={item}
          onCancel={() => props.onCancelOne(item.id)}
          onRetry={() => props.onRetryOne(item.id)}
        />
      ))}
    </div>
  );
}

export function UploadRow({
  item,
  onCancel,
  onRetry,
}: {
  item: UploadItem;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const percent = transferPercent(item.sentBytes, item.sizeBytes, item.indeterminate);
  const isActive = item.state === 'uploading' || item.state === 'queued';
  const label = item.prefix ? `${item.prefix}/${item.name}` : item.name;

  return (
    <div
      data-testid={`upload-row-${item.state}`}
      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 12 }}
    >
      <span
        title={label}
        style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#d7e0ea' }}
      >
        {label}
      </span>

      <span style={{ width: 130, height: 6, background: '#0b1015', borderRadius: 3, overflow: 'hidden', flexShrink: 0 }}>
        {item.state === 'uploading' && percent == null ? (
          // Honestly indeterminate: no byte granularity from the transport.
          <span
            data-testid="upload-bar-indeterminate"
            style={{
              display: 'block',
              height: '100%',
              width: '40%',
              background: `repeating-linear-gradient(90deg, ${STATE_COLOR.uploading}, ${STATE_COLOR.uploading} 6px, #24425c 6px, #24425c 12px)`,
              animation: 'none',
            }}
          />
        ) : (
          <span
            style={{
              display: 'block',
              height: '100%',
              width: `${item.state === 'done' ? 100 : (percent ?? 0)}%`,
              background: STATE_COLOR[item.state],
            }}
          />
        )}
      </span>

      <span style={{ width: 96, textAlign: 'right', color: STATE_COLOR[item.state], flexShrink: 0 }}>
        {stateLabel(item, percent)}
      </span>

      {isActive ? (
        <button type="button" style={btnStyle} onClick={onCancel}>
          Cancel
        </button>
      ) : item.state === 'failed' || item.state === 'cancelled' ? (
        <button type="button" style={btnStyle} onClick={onRetry}>
          Retry
        </button>
      ) : (
        <span style={{ width: 48 }} />
      )}
    </div>
  );
}

function stateLabel(item: UploadItem, percent: number | null): string {
  switch (item.state) {
    case 'queued':
      return 'queued';
    case 'uploading':
      return percent == null ? 'uploading…' : `${percent}%`;
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return item.state;
  }
}
