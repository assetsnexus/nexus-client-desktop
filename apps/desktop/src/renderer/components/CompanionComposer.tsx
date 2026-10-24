/**
 * Companion STT composer (companion window).
 *
 * The companion is the wake target in dictation mode: when a wake addresses this
 * agent, the main renderer owns the capture (it holds the shared mic graph + the
 * pre-roll) and mirrors the live turn here as a {@link CompanionSessionView}. This
 * strip renders that view — a live, editable STT preview with Send / Cancel and a
 * parallel "send as voice" action — and relays each control back to the session
 * owner via `bridge.companionAction`.
 *
 * It opens **no** microphone and starts **no** call by itself, so dictation never
 * competes with the realtime voice toggle in {@link CompanionView}.
 *
 * TRUST: this surface can only submit an ordinary user message. It shows no
 * approve/confirm affordance and can never satisfy 2FA / SCA / biometric.
 */

import { useEffect, useState, type CSSProperties } from 'react';
import { bridge, callBridge, onBridge, type CompanionSessionView } from '../bridge.js';

const KEYFRAMES =
  '@keyframes nexus-companion-wave{0%,100%{transform:scaleY(0.35)}50%{transform:scaleY(1)}}';

const wrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '8px 12px',
  borderTop: '1px solid #1e2731',
  background: '#0f141a',
  flexShrink: 0,
};

const fieldStyle: CSSProperties = {
  minHeight: 40,
  maxHeight: 120,
  resize: 'vertical',
  padding: '7px 9px',
  borderRadius: 10,
  background: '#0b0f14',
  border: '1px solid #2a333d',
  color: '#e8eef4',
  fontSize: 13,
  lineHeight: 1.4,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  fontFamily: 'inherit',
};

const button: CSSProperties = {
  padding: '5px 11px',
  borderRadius: 8,
  border: '1px solid #3f6cb0',
  background: '#2f5c9e',
  color: '#fff',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
};

const ghost: CSSProperties = {
  ...button,
  background: '#1c2430',
  borderColor: '#3a4654',
  color: '#e8eef4',
  fontWeight: 500,
};

const STATUS_COPY: Record<CompanionSessionView['status'], string> = {
  idle: 'Ready when you speak…',
  listening: 'Listening…',
  transcribing: 'Transcribing…',
  review: 'Review before sending',
  submitted: 'Sent',
  discarded: 'Discarded',
  queued: 'Saved for later',
  error: 'Something went wrong',
};

/** A cheap CSS-only soundwave, so the strip shows it is live. */
function Soundwave({ live }: { live: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, height: 16 }} aria-hidden>
      {Array.from({ length: 12 }, (_, i) => (
        <span
          key={i}
          style={{
            width: 2,
            height: 14,
            borderRadius: 2,
            background: live ? 'linear-gradient(180deg,#4ade80,#2f7d5f)' : '#3a4654',
            transformOrigin: 'center',
            animation: live
              ? `nexus-companion-wave ${(0.6 + (i % 5) * 0.1).toFixed(2)}s ease-in-out infinite`
              : 'none',
            transform: live ? undefined : 'scaleY(0.2)',
          }}
        />
      ))}
    </span>
  );
}

export type CompanionComposerProps = {
  contactId: string;
};

export function CompanionComposer({ contactId }: CompanionComposerProps) {
  const [view, setView] = useState<CompanionSessionView | null>(null);
  // A user edit freezes the field so a late partial cannot clobber it.
  const [typed, setTyped] = useState<string | null>(null);

  useEffect(() => {
    // `onBridge` tolerates a preload that predates this channel (returns a no-op
    // unsubscribe) so the companion never blanks on an older main process.
    const off = onBridge<CompanionSessionView>(bridge, 'onCompanionSession', (next) => {
      if (next.contactId !== contactId) return;
      setView(next);
    });
    return () => off();
  }, [contactId]);

  // A new activation (status back to `idle`/`listening` from a terminal state, or
  // a fresh preview) clears any frozen edit from the previous turn.
  useEffect(() => {
    if (!view) return;
    if (view.status === 'idle' || view.status === 'listening') setTyped(null);
  }, [view?.status, view?.engineLabel]);

  if (!view) return null;

  const live = view.status === 'listening' || view.status === 'transcribing';
  const done =
    view.status === 'submitted' || view.status === 'discarded' || view.status === 'queued';
  const fieldValue = typed ?? view.preview;
  const canSend = fieldValue.trim().length > 0 && !done;
  const batchSeconds = Math.round(view.batchDurationMs / 100) / 10;
  const canSendAudio = view.batchAvailable && !done;

  const send = (action: 'submit' | 'cancel' | 'sendAudio') => {
    void callBridge(bridge, 'companionAction', false, { contactId, action });
  };
  const edit = (text: string) => {
    setTyped(text);
    void callBridge(bridge, 'companionAction', false, { contactId, action: 'edit', text });
  };

  return (
    <div style={wrapStyle} data-nexus-surface="companion-composer">
      <style>{KEYFRAMES}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Soundwave live={live} />
        <span style={{ fontSize: 12, color: live ? '#4ade80' : '#9aa7b5' }}>
          {STATUS_COPY[view.status]}
        </span>
        {view.engineLabel ? (
          <span style={{ fontSize: 10, color: '#6b7784' }} data-nexus-wake-engine={view.engineLabel}>
            · {view.engineLabel}
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        {view.cloudTranscription && !done ? (
          <span style={{ fontSize: 10, color: '#ffd479' }} title="Speech is streamed to region inference">
            ☁︎ cloud STT
          </span>
        ) : null}
      </div>

      <textarea
        data-nexus-surface="companion-field"
        value={fieldValue}
        readOnly={done}
        placeholder={live ? 'Say something…' : 'Nothing was captured.'}
        onChange={(e) => edit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (canSend) send('submit');
          }
        }}
        style={fieldStyle}
      />

      {view.message ? <span style={{ fontSize: 11, color: '#fbbf24' }}>{view.message}</span> : null}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" style={button} disabled={!canSend} onClick={() => send('submit')}>
          Send
        </button>
        <button type="button" style={ghost} onClick={() => send('cancel')}>
          {done ? 'Close' : 'Cancel'}
        </button>
        {view.batchAvailable && !done ? (
          <button
            type="button"
            style={ghost}
            disabled={!canSendAudio || view.sendingAudio}
            onClick={() => send('sendAudio')}
            title="Send the recorded audio as a voice message (cloud/custom STT)"
          >
            {view.sendingAudio ? 'Sending…' : `Send voice · ${batchSeconds}s`}
          </button>
        ) : null}
      </div>
    </div>
  );
}
