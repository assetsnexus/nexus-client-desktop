/**
 * Live wake-word caption.
 *
 * Streams the words the on-device wake engine actually transcribed, so the user
 * can see *why* a wake did or did not fire: it is the ground truth behind the
 * status label. Any armed wake word inside the transcript is highlighted, which
 * makes a near-miss (e.g. the engine heard "hey jenner" instead of "hey jarvis")
 * immediately legible — the common reason an agent name or configured phrase
 * "isn't recognized".
 *
 * Purely presentational: it reads the director's live state and renders it. It
 * never touches audio, never authorizes anything, and never leaves the machine.
 */

import type { CSSProperties } from 'react';
import { useWakeState } from '../wake/director-host.js';
import { annotateTranscriptTokens } from '../../shared/wake-phrase.js';

const wrap: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 4,
  flex: 1,
  minWidth: 0,
  fontSize: 12.5,
  lineHeight: 1.35,
};

const heardLabel: CSSProperties = {
  color: '#6b7784',
  flexShrink: 0,
};

/** The recognized words: may wrap to a second line instead of being clipped. */
const words: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  flexWrap: 'wrap',
  gap: 4,
  minWidth: 0,
};

const word: CSSProperties = {
  color: '#cbd5e1',
};

const wakeWord: CSSProperties = {
  color: '#0f1419',
  background: '#d8a5ff',
  borderRadius: 4,
  padding: '0 4px',
  fontWeight: 700,
};

const empty: CSSProperties = {
  color: '#6b7784',
  fontStyle: 'italic',
};

export function LiveTranscript() {
  const state = useWakeState();
  const text = state.transcript;
  // Only meaningful while listening/armed; hidden otherwise so the bar stays thin.
  if (!state.enabled) return null;

  const tokens = text ? annotateTranscriptTokens(text, state.activePhrases) : [];
  const hasWake = tokens.some((t) => t.wake);

  return (
    <span
      style={wrap}
      data-nexus-surface="live-transcript"
      data-has-wake={hasWake ? 'true' : 'false'}
      title={text ? `Heard: ${text}` : 'Waiting for speech…'}
    >
      <span style={heardLabel}>heard</span>
      {tokens.length ? (
        <span style={words} data-nexus-transcript-words>
          {tokens.map((token, index) => (
            <span key={`${index}-${token.text}`} style={token.wake ? wakeWord : word}>
              {token.text}
            </span>
          ))}
        </span>
      ) : (
        <span style={empty}>…</span>
      )}
    </span>
  );
}
