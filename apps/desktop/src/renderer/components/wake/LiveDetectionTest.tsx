/**
 * Live detection test: arms one detector for the typed phrase and lights up.
 *
 * Runs entirely on this machine — nothing is sent and nothing opens. Start is
 * disabled with an honest reason when the test cannot possibly work (e.g. a
 * speech model whose local runner is missing), rather than letting the user talk
 * into a listener that can never transcribe.
 */

import { useCallback, useEffect, useState } from 'react';
import { createWakeLiveTest, type WakeLiveTest, type WakeLiveTestState } from '../../wake/live-test.js';
import { button, card, tinyButton } from './parts.js';

export function LiveDetectionTest({
  phrase,
  modelId,
  sensitivity,
  disabled,
  blockedReason,
}: {
  phrase: string;
  modelId: string | null;
  sensitivity: number;
  disabled: boolean;
  /**
   * Set when the test cannot possibly work (e.g. a speech model with the local
   * runner missing). The reason is shown and Start is disabled, rather than
   * letting the user talk into a listener that can never transcribe.
   */
  blockedReason?: string | null;
}) {
  const [test, setTest] = useState<WakeLiveTest | null>(null);
  const [state, setState] = useState<WakeLiveTestState>('idle');
  const [score, setScore] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      void test?.stop();
    };
  }, [test]);

  const start = useCallback(async () => {
    setError(null);
    try {
      const session = createWakeLiveTest({
        phrase,
        modelId,
        sensitivity,
        onLevel: (level) => setScore(level),
        onState: (next) => setState(next),
      });
      const ok = await session.start();
      if (!ok) {
        setError(blockedReason ?? 'No installed wake model matches this phrase yet — pick a model or install one.');
        return;
      }
      setTest(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the test.');
    }
  }, [blockedReason, modelId, phrase, sensitivity]);

  const stop = useCallback(async () => {
    await test?.stop();
    setTest(null);
    setState('idle');
    setScore(0);
  }, [test]);

  return (
    <div style={{ ...card, background: '#101823' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ fontSize: 12, color: '#e8eef4' }}>Test detection</strong>
        <span style={{ fontSize: 11, color: '#6b7784' }}>
          runs on this machine; nothing is sent and nothing opens
        </span>
        <span style={{ flex: 1 }} />
        {test ? (
          <button type="button" style={tinyButton} onClick={() => void stop()}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            style={{ ...button, padding: '3px 10px' }}
            disabled={disabled || !phrase.trim() || Boolean(blockedReason)}
            onClick={() => void start()}
          >
            Start
          </button>
        )}
      </div>
      {blockedReason ? <span style={{ fontSize: 11, color: '#ffd479' }}>{blockedReason}</span> : null}
      {test ? (
        <span
          style={{
            fontSize: 11,
            color: state === 'unavailable' ? '#fbbf24' : state === 'fired' ? '#4ade80' : '#9aa7b5',
          }}
        >
          {state === 'unavailable'
            ? 'Detector unavailable'
            : state === 'fired'
              ? 'Detected — the phrase works'
              : 'Listening — say the phrase'}
        </span>
      ) : null}
      <div
        style={{
          position: 'relative',
          height: 6,
          borderRadius: 999,
          background: '#0f1419',
          border: '1px solid #2a333d',
          overflow: 'hidden',
        }}
        aria-hidden
      >
        <div
          style={{
            height: '100%',
            width: `${Math.round(Math.min(1, Math.max(0, score)) * 100)}%`,
            background: 'linear-gradient(90deg,#2f7d5f,#4ade80)',
            transition: 'width 0.08s linear',
          }}
        />
      </div>
      {error ? <span style={{ color: '#f87171', fontSize: 11 }}>{error}</span> : null}
    </div>
  );
}
