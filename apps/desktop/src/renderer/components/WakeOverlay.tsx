/**
 * Wake overlay: the compact surface a wake word opens.
 *
 * Two shapes, driven by the activation mode the user configured:
 *  - `chat` — a slim review bar pinned bottom-right *over* the open chat, so the
 *    transcript is reviewed where it will be sent;
 *  - `widget` — a standalone floating card (soundwave + live transcript + the
 *    target agent's avatar) that never opens the chat.
 *
 * It renders the *live* dictation preview and, because a wake never auto-sends by
 * default, it holds the transcript until the user submits. Everything here is
 * presentation: the policy lives in `wake/session.ts` and `wake/router.ts`.
 *
 * TRUST: this surface can only submit an ordinary user message. It shows no
 * approve/confirm affordance and can never satisfy 2FA / SCA / biometric.
 */

import { useMemo, type CSSProperties } from 'react';
import type { SessionState } from '../wake/session.js';
import { useWakeState } from '../wake/director-host.js';

export type WakeOverlayAgent = {
  name: string;
  avatarUrl: string | null;
};

const cardBase: CSSProperties = {
  position: 'absolute',
  zIndex: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: 14,
  borderRadius: 14,
  background: 'rgba(15,20,25,0.96)',
  border: '1px solid #2a333d',
  boxShadow: '0 18px 48px rgba(0,0,0,0.55)',
  color: '#e8eef4',
  backdropFilter: 'blur(6px)',
};

const button: CSSProperties = {
  padding: '6px 12px',
  borderRadius: 8,
  border: '1px solid #3f6cb0',
  background: '#2f5c9e',
  color: '#fff',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
};

const ghostButton: CSSProperties = {
  ...button,
  background: '#1c2430',
  borderColor: '#3a4654',
  color: '#e8eef4',
  fontWeight: 500,
};

const KEYFRAMES =
  '@keyframes nexus-wake-wave{0%,100%{transform:scaleY(0.35)}50%{transform:scaleY(1)}}' +
  '@keyframes nexus-wake-ring{0%{transform:scale(0.9);opacity:0.6}100%{transform:scale(1.5);opacity:0}}';

const BARS = 14;

/** A cheap CSS-only soundwave driven by the live microphone level. */
function Soundwave({ level, live }: { level: number; live: boolean }) {
  const amps = useMemo(
    () =>
      Array.from({ length: BARS }, (_, i) => {
        // Deterministic per-bar shape so the wave looks organic but stable.
        const shape = 0.45 + 0.55 * Math.abs(Math.sin((i + 1) * 1.7));
        return shape;
      }),
    [],
  );
  const energy = Math.min(1, Math.max(0, level * 3));
  return (
    <div
      style={{ display: 'flex', alignItems: 'center', gap: 3, height: 34 }}
      aria-hidden
      title="Microphone level"
    >
      {amps.map((shape, i) => {
        const scale = live ? Math.max(0.18, shape * (0.35 + energy)) : 0.18;
        return (
          <span
            key={i}
            style={{
              width: 3,
              height: 30,
              borderRadius: 2,
              background: live ? 'linear-gradient(180deg,#4ade80,#2f7d5f)' : '#3a4654',
              transform: `scaleY(${scale.toFixed(3)})`,
              transformOrigin: 'center',
              animation: live ? `nexus-wake-wave ${(0.7 + (i % 5) * 0.09).toFixed(2)}s ease-in-out infinite` : 'none',
            }}
          />
        );
      })}
    </div>
  );
}

function Avatar({ agent, live }: { agent: WakeOverlayAgent | null; live: boolean }) {
  const initial = (agent?.name || '?').trim().charAt(0).toUpperCase();
  return (
    <div style={{ position: 'relative', width: 44, height: 44, flexShrink: 0 }}>
      {agent?.avatarUrl ? (
        <img
          src={agent.avatarUrl}
          alt=""
          style={{ width: 44, height: 44, borderRadius: '50%', objectFit: 'cover' }}
        />
      ) : (
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: '50%',
            background: '#243244',
            border: '1px solid #3a4654',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 700,
            color: '#9aa7b5',
          }}
        >
          {initial}
        </div>
      )}
      {live ? (
        <span
          style={{
            position: 'absolute',
            inset: -4,
            borderRadius: '50%',
            border: '2px solid #4ade80',
            animation: 'nexus-wake-ring 1.6s ease-out infinite',
          }}
        />
      ) : null}
    </div>
  );
}

const STATUS_COPY: Record<SessionState['status'], string> = {
  idle: 'Starting…',
  listening: 'Listening…',
  transcribing: 'Transcribing…',
  review: 'Review before sending',
  submitted: 'Sent',
  discarded: 'Discarded',
  queued: 'Saved for later',
  error: 'Something went wrong',
};

export type WakeOverlayProps = {
  session: SessionState;
  /** `chat` renders the slim review bar; `widget` the standalone card. */
  mode: 'chat' | 'widget' | 'companion';
  agent: WakeOverlayAgent | null;
  onSubmit: () => void;
  onCancel: () => void;
};

export function WakeOverlay({ session, mode, agent, onSubmit, onCancel }: WakeOverlayProps) {
  const wake = useWakeState();
  const live = session.status === 'listening' || session.status === 'transcribing';
  const compact = mode === 'chat';
  const transcript = session.preview.trim();
  const done = session.status === 'submitted' || session.status === 'discarded' || session.status === 'queued';

  const style: CSSProperties = compact
    ? { ...cardBase, right: 16, bottom: 16, width: 420, maxWidth: 'calc(100% - 32px)' }
    : { ...cardBase, right: 20, bottom: 20, width: 340, maxWidth: 'calc(100% - 40px)' };

  return (
    <div style={style} data-nexus-surface="wake-overlay" data-wake-mode={mode}>
      <style>{KEYFRAMES}</style>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Avatar agent={agent} live={live} />
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{agent?.name ?? 'Agent'}</span>
          <span style={{ fontSize: 11, color: live ? '#4ade80' : '#9aa7b5' }}>
            {STATUS_COPY[session.status]}
            {session.target.phrase ? ` · heard “${session.target.phrase}”` : ''}
          </span>
        </div>
        <Soundwave level={wake.level} live={live} />
      </div>

      <div
        style={{
          minHeight: 46,
          maxHeight: 160,
          overflowY: 'auto',
          padding: '8px 10px',
          borderRadius: 10,
          background: '#0f1419',
          border: '1px solid #2a333d',
          fontSize: 13,
          lineHeight: 1.45,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {transcript ? (
          <span>{session.buffer}</span>
        ) : (
          <span style={{ color: '#6b7784' }}>
            {live ? 'Say something…' : 'Nothing was captured.'}
          </span>
        )}
        {live && session.partial ? (
          <span style={{ color: '#9aa7b5' }}>{session.buffer ? ' ' : ''}{session.partial}</span>
        ) : null}
      </div>

      {session.message ? (
        <span style={{ fontSize: 11, color: '#fbbf24' }}>{session.message}</span>
      ) : null}

      {session.cloudTranscription && !done ? (
        <span
          data-nexus-wake-cloud="true"
          style={{
            fontSize: 11,
            color: '#ffd479',
            background: '#2a2312',
            border: '1px solid #6b5a24',
            borderRadius: 8,
            padding: '4px 8px',
          }}
        >
          Streaming to the cloud — your speech is being sent to region inference for transcription.
        </span>
      ) : null}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" style={button} disabled={done || !session.buffer.trim()} onClick={onSubmit}>
          Send
        </button>
        <button type="button" style={ghostButton} onClick={onCancel}>
          {done ? 'Close' : 'Cancel'}
        </button>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: '#6b7784' }}>
          Reviewing before send — nothing is sent until you press Send.
        </span>
      </div>
    </div>
  );
}
