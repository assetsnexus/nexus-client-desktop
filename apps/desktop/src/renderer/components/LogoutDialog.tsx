/**
 * Logout dialog (Deliverable 5): two explicit choices, never leaving the user
 * stuck.
 *
 * - **Switch to another user (keep local data)** — ends the session but keeps the
 *   local identity store, sync bindings, mounts, wake queue, and secure store.
 *   The user is additionally asked whether to unmount local storage dirs/mounts.
 * - **Permanent logout** — clears all local data, identity bindings, mounts, and
 *   the secure store.
 *
 * After a run it shows a per-step report; when a step failed the user can retry
 * just the failed steps.
 */

import { useCallback, useState, type CSSProperties } from 'react';
import { bridge, stepLabel, type LogoutChoice, type LogoutReport } from '../bridge.js';

const backdrop: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 900,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(9,12,16,0.7)',
};

const card: CSSProperties = {
  width: 420,
  maxWidth: '92vw',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  padding: 22,
  borderRadius: 14,
  background: '#151b22',
  border: '1px solid #2a333d',
  color: '#e8eef4',
};

const primary: CSSProperties = {
  padding: '10px 14px',
  borderRadius: 10,
  border: '1px solid #3f6cb0',
  background: '#2f5c9e',
  color: '#fff',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
};

const secondary: CSSProperties = {
  padding: '10px 14px',
  borderRadius: 10,
  border: '1px solid #3a4654',
  background: '#1c2430',
  color: '#e8eef4',
  cursor: 'pointer',
  fontSize: 13,
};

export function LogoutDialog({
  onClose,
  onDone,
}: {
  /** Dismiss without logging out (the user cancelled). */
  onClose: () => void;
  /** The logout completed and the renderer should refresh its auth state. */
  onDone: () => void;
}) {
  const [unmount, setUnmount] = useState(true);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<LogoutReport | null>(null);
  const [lastChoice, setLastChoice] = useState<LogoutChoice | null>(null);

  const run = useCallback(
    async (choice: LogoutChoice) => {
      setBusy(true);
      setLastChoice(choice);
      try {
        const next = await bridge.logoutRun(choice);
        setReport(next);
        if (next.ok) onDone();
      } finally {
        setBusy(false);
      }
    },
    [onDone],
  );

  const retry = useCallback(async () => {
    if (!report || !lastChoice) return;
    setBusy(true);
    try {
      const next = await bridge.logoutRetry([...report.retryable], lastChoice);
      // Keep the earlier successes in the report so the user sees the full run.
      setReport({
        ...next,
        results: [...report.results.filter((r) => r.ok), ...next.results],
      });
      if (next.ok) onDone();
    } finally {
      setBusy(false);
    }
  }, [report, lastChoice, onDone]);

  return (
    <div style={backdrop}>
      <div style={card} role="dialog" aria-modal="true" aria-label="Sign out">
        <strong style={{ fontSize: 16 }}>Sign out</strong>

        {!report ? (
          <>
            <p style={{ margin: 0, color: '#8b95a1', fontSize: 12 }}>
              How would you like to sign out? Your local data can be kept for the next person on
              this machine, or removed entirely.
            </p>

            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 12px',
                borderRadius: 10,
                border: '1px solid #2a333d',
                background: '#12171c',
              }}
            >
              <input
                type="checkbox"
                checked={unmount}
                disabled={busy}
                onChange={(e) => setUnmount(e.target.checked)}
              />
              <span style={{ fontSize: 13 }}>
                Unmount local drives and stop syncing
                <span style={{ color: '#6b7784' }}> (keeps files and accounts)</span>
              </span>
            </label>

            <button
              type="button"
              style={primary}
              disabled={busy}
              onClick={() => void run({ kind: 'switch_user', unmount })}
            >
              Switch to another user (keep local data)
            </button>
            <button
              type="button"
              style={secondary}
              disabled={busy}
              onClick={() => void run({ kind: 'permanent' })}
            >
              Permanent logout (clear all local data)
            </button>
            <button
              type="button"
              style={{ ...secondary, background: 'none', border: 'none', color: '#8b95a1' }}
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            {report.ok ? (
              <p style={{ margin: 0, color: '#4ade80', fontSize: 13 }}>
                {report.choice.kind === 'permanent'
                  ? 'Permanent logout complete. All local data was cleared.'
                  : 'Switched out. Your local data was kept.'}
              </p>
            ) : (
              <p style={{ margin: 0, color: '#f2a1a1', fontSize: 13 }}>
                Some steps could not be completed. You can retry them.
              </p>
            )}
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: '#9aa7b5' }}>
              {report.results.map((r) => (
                <li key={r.step} style={{ color: r.ok ? '#9aa7b5' : '#f2a1a1' }}>
                  {stepLabel(r.step)}
                  {r.ok ? ' — done' : ` — failed (${r.error ?? 'unknown reason'})`}
                </li>
              ))}
            </ul>
            <div style={{ display: 'flex', gap: 10 }}>
              {!report.ok ? (
                <button type="button" style={primary} disabled={busy} onClick={() => void retry()}>
                  Retry failed steps
                </button>
              ) : null}
              <button
                type="button"
                style={secondary}
                disabled={busy}
                onClick={() => {
                  onDone();
                  onClose();
                }}
              >
                {report.ok ? 'Close' : 'Continue anyway'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
