/**
 * Wake listening bottom bar.
 *
 * A thin strip pinned to the bottom of the shell that appears only when wake
 * listening is active. It shows:
 *  - a pulsing mic icon while genuinely detecting (never while merely "enabled"),
 *  - a live level meter (the smoothed input RMS),
 *  - the phrases currently armed, so the user knows what to say.
 *
 * It is informational only: it never authorizes anything and offers no controls
 * that could gate the microphone (opt-in lives in Settings).
 */

import type { CSSProperties } from 'react';
import { useWakeState } from '../wake/director-host.js';
import { MicToggleBar } from './MicToggleBar.js';
import { LiveTranscript } from './LiveTranscript.js';

const bar: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '6px 14px',
  borderTop: '1px solid #2a333d',
  background: '#12171c',
  color: '#9aa7b5',
  fontSize: 12,
  flexShrink: 0,
};

const dot = (live: boolean): CSSProperties => ({
  width: 9,
  height: 9,
  borderRadius: '50%',
  background: live ? '#4ade80' : '#6b7784',
  boxShadow: live ? '0 0 0 4px rgba(74,222,128,0.18)' : 'none',
  animation: live ? 'nexus-wake-pulse 1.4s ease-in-out infinite' : 'none',
});

const meterTrack: CSSProperties = {
  position: 'relative',
  width: 120,
  height: 8,
  borderRadius: 999,
  background: '#0f1419',
  border: '1px solid #2a333d',
  overflow: 'hidden',
};

const meterFill = (level: number): CSSProperties => ({
  height: '100%',
  width: `${Math.round(Math.min(1, Math.max(0, level)) * 100)}%`,
  background: 'linear-gradient(90deg,#2f7d5f,#4ade80)',
  transition: 'width 0.08s linear',
});

const chip: CSSProperties = {
  padding: '1px 8px',
  borderRadius: 999,
  border: '1px solid #6a3f9e',
  color: '#d8a5ff',
  fontSize: 11,
};

/** Keyframes for the pulsing dot, injected once. */
const KEYFRAMES = '@keyframes nexus-wake-pulse{0%,100%{opacity:1}50%{opacity:.45}}';

export function WakeBottomBar() {
  const state = useWakeState();
  // Hidden entirely unless the user has wake words enabled.
  if (!state.enabled) return null;
  const live = state.listening;

  return (
    <div style={bar} data-nexus-surface="wake-bar" data-wake-live={live ? 'true' : 'false'}>
      <style>{KEYFRAMES}</style>
      {/* Microphone mute toggle + live soundwave, immediately left of the status. */}
      <MicToggleBar />
      <span style={dot(live)} aria-hidden />
      <span style={{ color: '#e8eef4', fontWeight: 600 }}>
        {live ? 'Listening for wake words' : 'Wake words idle'}
      </span>

      {/* Live on-device STT caption, immediately right of the status: streams the
          words the wake engine heard and highlights any armed wake word. */}
      <LiveTranscript />

      <div style={meterTrack} aria-hidden title="Microphone level">
        <div style={meterFill(state.level)} />
      </div>

      <span style={{ flex: 1 }} />

      {state.activePhrases.length ? (
        <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {state.activePhrases.map((phrase) => (
            <span key={phrase} style={chip}>
              “{phrase}”
            </span>
          ))}
        </span>
      ) : null}

      {state.message ? (
        <span style={{ color: '#fbbf24', maxWidth: 320 }} title={state.message}>
          {state.message}
        </span>
      ) : null}

      {state.lastDetection ? (
        <span style={{ color: '#6b7784' }}>
          heard “{state.lastDetection.phrase}”
        </span>
      ) : null}
    </div>
  );
}
