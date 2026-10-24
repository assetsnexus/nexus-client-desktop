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

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
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

const tinyGhostButton: CSSProperties = {
  ...ghostButton,
  padding: '3px 9px',
  fontSize: 11,
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
  /**
   * Bumped once per activation. Used to reset the frozen edit so a second wake
   * never shows the previous session's typed text. Optional for tests.
   */
  sessionToken?: number;
  /** `chat` renders the slim review bar; `widget` the standalone card. */
  mode: 'chat' | 'widget' | 'companion';
  agent: WakeOverlayAgent | null;
  onSubmit: () => void;
  onCancel: () => void;
  /** Reflects / toggles the "open the agent in the companion window in voice mode" setting. */
  companionOnWake?: boolean;
  onToggleCompanion?: (next: boolean) => void;
  /** Replace the committed transcript with user-edited text. */
  onEdit?: (text: string) => void;
  /** Open this agent in the companion window in voice mode right now. */
  onOpenCompanion?: () => void;
  /** Engine feeding the live preview ("On-device" / "Region inference"), if known. */
  engineLabel?: string | null;
  /** Send the recorded audio batch as a normal voice message (cloud/custom STT). */
  onSendAudio?: () => void;
};

export function WakeOverlay({
  session,
  sessionToken = 0,
  mode,
  agent,
  onSubmit,
  onCancel,
  companionOnWake = false,
  onToggleCompanion,
  onEdit,
  onOpenCompanion,
  engineLabel = null,
  onSendAudio,
}: WakeOverlayProps) {
  const wake = useWakeState();
  const live = session.status === 'listening' || session.status === 'transcribing';
  const compact = mode === 'chat';
  const done = session.status === 'submitted' || session.status === 'discarded' || session.status === 'queued';

  /**
   * The field streams the live partial as it arrives (`session.preview` is the
   * committed buffer plus the in-flight partial). Once the user types, we freeze
   * their text so a late partial cannot clobber a manual edit; `onEdit` commits
   * that text to the session so Submit sends exactly what is visible.
   */
  const [typed, setTyped] = useState<string | null>(null);
  // A fresh wake must not show the previous session's typed text. The token is
  // bumped once per activation by the host (the session object itself changes on
  // every state emit, so it cannot be the reset key).
  useEffect(() => {
    setTyped(null);
  }, [sessionToken]);
  const fieldValue = typed ?? session.preview;
  const canSend = fieldValue.trim().length > 0 && !done;
  const edit = (next: string) => {
    setTyped(next);
    onEdit?.(next);
  };
  // Dual-mode: the audio batch runs in parallel with the live preview, so the
  // user can always fall back to sending the audio itself. Shown when audio was
  // recorded and while the turn has not finished.
  const batchSeconds = Math.round(session.batchDurationMs / 100) / 10;
  const canSendAudio = Boolean(onSendAudio) && session.batchAvailable && !done;
  const showBatch = session.batchAvailable && !done;

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

      {/* An editable field, not a read-only caption: the live STT streams in here
          (committed buffer + the in-flight partial) and the user can fix it or
          type before pressing Send. Submitting folds the partial in, so whatever
          is visible is exactly what is sent. */}
      <textarea
        data-nexus-surface="wake-field"
        value={fieldValue}
        readOnly={done}
        placeholder={live ? 'Say something…' : 'Nothing was captured.'}
        onChange={(e) => edit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (canSend) onSubmit();
          }
        }}
        style={{
          minHeight: 46,
          maxHeight: 160,
          resize: 'vertical',
          padding: '8px 10px',
          borderRadius: 10,
          background: '#0f1419',
          border: '1px solid #2a333d',
          color: '#e8eef4',
          fontSize: 13,
          lineHeight: 1.45,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontFamily: 'inherit',
        }}
      />
      {live && session.partial ? (
        <span style={{ fontSize: 10, color: '#9aa7b5' }}>
          streaming live… press Send to send what you see
        </span>
      ) : null}

      {engineLabel ? (
        <span style={{ fontSize: 10, color: '#6b7784' }} data-nexus-wake-engine={engineLabel}>
          Live preview engine: {engineLabel}
        </span>
      ) : null}

      {/* Dual-mode capture: the audio batch records in parallel with the live
          preview, so the user can send the recording itself (cloud/custom STT)
          instead of the on-device transcript. */}
      {showBatch ? (
        <div
          data-nexus-wake-batch="true"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 11,
            color: '#cbd5e1',
            background: '#141b23',
            border: '1px solid #2a333d',
            borderRadius: 8,
            padding: '6px 8px',
          }}
        >
          <span>
            Audio batch · {batchSeconds}s recorded
            {session.batchChunks > 1 ? ` · ${session.batchChunks} parts` : ''}
          </span>
          <span style={{ flex: 1 }} />
          {onSendAudio ? (
            <button
              type="button"
              style={tinyGhostButton}
              disabled={!canSendAudio || session.sendingAudio}
              onClick={onSendAudio}
            >
              {session.sendingAudio ? 'Sending…' : 'Send as voice'}
            </button>
          ) : null}
        </div>
      ) : null}

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
        <button type="button" style={button} disabled={!canSend} onClick={onSubmit}>
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

      {/* Companion + voice mode: link this wake to the immersive companion window.
          The checkbox persists the setting, so every future wake for any agent
          opens there in voice mode; the button opens *this* agent now. */}
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          flexWrap: 'wrap',
          paddingTop: 8,
          borderTop: '1px solid #2a333d',
        }}
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#cbd5e1', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={companionOnWake}
            disabled={!onToggleCompanion}
            onChange={(e) => onToggleCompanion?.(e.target.checked)}
          />
          Open the agent in the companion window + voice mode on a wake
        </label>
        {onOpenCompanion ? (
          <button type="button" style={tinyGhostButton} onClick={onOpenCompanion}>
            Open companion + voice now
          </button>
        ) : null}
      </div>
    </div>
  );
}
