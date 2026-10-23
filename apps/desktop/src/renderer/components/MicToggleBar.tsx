/**
 * Bottom-bar microphone toggle + live soundwave.
 *
 * Sits immediately left of the "Wake words idle" status. Shows:
 *  - a mute/unmute button reflecting whether the microphone is muted,
 *  - a scrolling soundwave of the live microphone input while capturing,
 *  - a flat line while muted, so the state is obvious at a glance.
 *
 * The waveform is driven by {@link startMicLevel}, which meters the primary input
 * independently of wake listening, so the meter works whenever the mic is open.
 * TRUST: it only derives a display level locally; nothing is recorded or sent.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { audioStore, useAudioSnapshot } from '../audio/use-audio-store.js';
import {
  WAVEFORM_BUCKETS,
  emptyWaveform,
  pushWaveform,
  startMicLevel,
  type MicLevelHandle,
  type Waveform,
} from '../audio/mic-level.js';
import { reconcileWakeDirector } from '../wake/director-host.js';

const wrap: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const button = (muted: boolean): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 26,
  height: 26,
  borderRadius: 8,
  border: `1px solid ${muted ? '#7a3b3b' : '#3a4654'}`,
  background: muted ? '#2a1414' : '#1c2430',
  color: muted ? '#f2a1a1' : '#9fe3c0',
  cursor: 'pointer',
  padding: 0,
  flexShrink: 0,
});

const waveWrap: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  height: 22,
  width: WAVEFORM_BUCKETS * 3,
  flexShrink: 0,
};

const barStyle = (value: number, muted: boolean): CSSProperties => ({
  width: 2,
  height: `${Math.max(2, Math.round(value * 20))}px`,
  borderRadius: 1,
  background: muted ? '#3a4654' : 'linear-gradient(180deg,#4ade80,#2f7d5f)',
  transition: 'height 0.08s linear',
});

/** A simple mic glyph that reflects mute with a struck-through line. */
function MicGlyph({ muted }: { muted: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden focusable="false">
      <path
        d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"
        fill={muted ? '#f2a1a1' : '#9fe3c0'}
      />
      <path
        d="M5 11a7 7 0 0 0 14 0M12 18v3"
        fill="none"
        stroke={muted ? '#f2a1a1' : '#9fe3c0'}
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      {muted ? (
        <path d="M4 4l16 16" fill="none" stroke="#f2a1a1" strokeWidth="1.8" strokeLinecap="round" />
      ) : null}
    </svg>
  );
}

export function MicToggleBar() {
  const snapshot = useAudioSnapshot();
  const muted = snapshot.inputMuted;
  const [waveform, setWaveform] = useState<Waveform>(() => emptyWaveform());
  const handleRef = useRef<MicLevelHandle | null>(null);

  // Meter the primary input while the bar is mounted and not muted. The wake
  // director may also hold a stream; a second analyser stream is harmless and
  // keeps the meter live even when wake listening is off.
  useEffect(() => {
    let cancelled = false;
    if (muted) {
      setWaveform(emptyWaveform());
      return;
    }
    void startMicLevel({
      deviceId: snapshot.settings.input.primaryInputId,
      onLevel: (level) => {
        if (cancelled) return;
        setWaveform((prev) => pushWaveform(prev, level));
      },
    }).then((handle) => {
      if (cancelled) {
        handle.stop();
        return;
      }
      handleRef.current = handle;
    });
    return () => {
      cancelled = true;
      handleRef.current?.stop();
      handleRef.current = null;
    };
  }, [muted, snapshot.settings.input.primaryInputId]);

  const toggle = () => {
    const next = !muted;
    audioStore().setInputMuted(next);
    // Reconcile so a muted director releases its microphone immediately.
    void reconcileWakeDirector();
  };

  return (
    <div style={wrap} data-nexus-surface="mic-toggle" data-mic-muted={muted ? 'true' : 'false'}>
      <button
        type="button"
        style={button(muted)}
        onClick={toggle}
        aria-pressed={muted}
        title={muted ? 'Unmute the microphone' : 'Mute the microphone'}
      >
        <MicGlyph muted={muted} />
      </button>
      <div style={waveWrap} aria-hidden title={muted ? 'Muted' : 'Microphone input'}>
        {waveform.map((value, index) => (
          <div key={index} style={barStyle(value, muted)} />
        ))}
      </div>
    </div>
  );
}
