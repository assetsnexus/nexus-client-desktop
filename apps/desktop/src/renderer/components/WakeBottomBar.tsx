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

import { useEffect, useState, type CSSProperties } from 'react';
import { bridge } from '../bridge.js';
import { useWakeState } from '../wake/director-host.js';
import { MicToggleBar } from './MicToggleBar.js';
import { LiveTranscript } from './LiveTranscript.js';

const bar: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '6px 14px',
  borderTop: '1px solid #2a333d',
  background: '#12171c',
  color: '#9aa7b5',
  fontSize: 12,
  flexShrink: 0,
};

/** Top line: mic toggle, live status, level meter, and any transient message. */
const statusRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  minWidth: 0,
};

/** Second line: the live caption, full width so the words are always readable. */
const captionRow: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  minWidth: 0,
};

/**
 * Third line: the armed phrases. A single horizontal strip that scrolls rather
 * than wrapping — with dozens of agents, wrapping would push the bar very tall.
 */
const chipsRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
  overflowX: 'auto',
  overflowY: 'hidden',
  scrollbarWidth: 'thin',
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

/** Local-engine / cloud status chip (a small neutral pill). */
const engineChip: CSSProperties = {
  padding: '1px 8px',
  borderRadius: 999,
  border: '1px solid #2a333d',
  background: '#0f1419',
  color: '#9aa7b5',
  fontSize: 11,
  whiteSpace: 'nowrap',
  flexShrink: 0,
};

/** Human label for the wake STT engine the bar is reporting. */
function engineLabel(status: {
  ready: boolean;
  backend: 'whisper_cpp' | 'faster_whisper' | 'custom';
} | null): string | null {
  if (!status) return null;
  if (!status.ready) return 'STT: cloud';
  if (status.backend === 'faster_whisper') return 'STT: GPU';
  if (status.backend === 'custom') return 'STT: custom local';
  return 'STT: CPU';
}

/** Keyframes for the pulsing dot, injected once. */
const KEYFRAMES = '@keyframes nexus-wake-pulse{0%,100%{opacity:1}50%{opacity:.45}}';

export function WakeBottomBar() {
  const state = useWakeState();
  // Which on-device engine feeds the caption (GPU / CPU / custom) — probed when
  // the caption is actually live and refreshed when listening toggles, so the bar
  // can show a truthful engine chip instead of guessing.
  const [stt, setStt] = useState<Awaited<ReturnType<typeof bridge.wakeSttStatus>> | null>(null);
  useEffect(() => {
    if (!state.enabled) return;
    let cancelled = false;
    void bridge
      .wakeSttStatus()
      .then((next) => {
        if (!cancelled) setStt(next);
      })
      .catch(() => {
        if (!cancelled) setStt(null);
      });
    return () => {
      cancelled = true;
    };
  }, [state.enabled, state.listening]);
  // Hidden entirely unless the user has wake words enabled.
  if (!state.enabled) return null;
  const live = state.listening;
  // While capturing, detection is suppressed so the agent's own name spoken
  // inside an instruction is not a new wake. Say so, instead of leaving the bar
  // claiming to listen when detectors are intentionally paused.
  const capturing = state.capturing;

  return (
    <div
      style={bar}
      data-nexus-surface="wake-bar"
      data-wake-live={live ? 'true' : 'false'}
      data-wake-capturing={capturing ? 'true' : 'false'}
    >
      <style>{KEYFRAMES}</style>
      <div style={statusRow}>
        {/* Microphone mute toggle + live soundwave, immediately left of the status. */}
        <MicToggleBar />
        <span style={dot(live && !capturing)} aria-hidden />
        <span style={{ color: '#e8eef4', fontWeight: 600, flexShrink: 0 }}>
          {capturing
            ? `Paused — speaking to ${state.lastDetection?.phrase ? '“' + state.lastDetection.phrase + '”' : 'your agent'}`
            : live
              ? 'Listening for wake words'
              : 'Wake words idle'}
        </span>
        <div style={meterTrack} aria-hidden title="Microphone level">
          <div style={meterFill(state.level)} />
        </div>
        <span style={{ flex: 1 }} />
        {engineLabel(stt) ? (
          <span
            style={engineChip}
            data-nexus-wake-engine={engineLabel(stt)}
            title="Engine feeding the live wake caption"
          >
            {engineLabel(stt)}
          </span>
        ) : null}
        {state.lastDetection ? (
          <span style={{ color: '#6b7784', flexShrink: 0 }}>
            matched “{state.lastDetection.phrase}”
          </span>
        ) : null}
        {state.message ? (
          <span style={{ color: '#fbbf24', maxWidth: 380 }} title={state.message}>
            {state.message}
          </span>
        ) : null}
      </div>

      {/* The caption gets its own full-width line: sharing a row with the phrase
          chips collapsed it to a few clipped characters (the unreadable "heard…"). */}
      <div style={captionRow}>
        {/* Live on-device STT caption: streams the words the wake engine heard and
            highlights any armed wake word. */}
        <LiveTranscript />
      </div>

      {state.activePhrases.length ? (
        <div style={chipsRow} aria-label="Armed wake phrases">
          {state.activePhrases.map((phrase) => (
            <span key={phrase} style={{ ...chip, flexShrink: 0 }}>
              “{phrase}”
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
