/**
 * Readiness checklist for speech-model (`stt_phrase`) wake words.
 *
 * Turns an opaque "cannot listen yet" banner into a concrete list that highlights
 * the exact step still missing (install a model, install the runner, or free the
 * port), so a user who installed a model can see *why* a wake is not listening.
 */

import { useMemo } from 'react';
import type { WakeSttStatus } from '../../bridge.js';
import { isLargeWakeModel } from '../../../shared/wake.js';

export function SpeechModelReadiness({ status }: { status: WakeSttStatus | null }) {
  const steps = useMemo(() => {
    if (status?.usingCustomEndpoint) {
      return [
        {
          label: status.ready
            ? 'Local speech endpoint reachable'
            : 'Configure a local (loopback/LAN) speech endpoint',
          done: status.ready,
        },
      ];
    }
    const hasModel = Boolean(status?.modelId);
    const hasRunner = status?.runnerInstalled === true;
    return [
      {
        label: hasModel
          ? `Speech model installed${status?.modelLabel ? ` — ${status.modelLabel}` : ''}`
          : 'Install a speech-to-text model under “Local speech models” above',
        done: hasModel,
      },
      {
        label: hasRunner
          ? 'Speech engine runner available (whisper-server)'
          : 'Install the whisper.cpp runner (Speech engine runner → Install)',
        done: hasRunner,
      },
    ];
  }, [status]);

  if (!status) return null;
  if (status.ready) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          borderRadius: 8,
          background: '#0f1f18',
          border: '1px solid #2f7d5f',
          fontSize: 11,
          color: '#8fe3c0',
        }}
      >
        <span style={{ color: '#4ade80' }}>✓</span>
        <span>
          Speech-model wakes are ready
          {status.modelLabel ? ` — using ${status.modelLabel}` : ''}
          {status.threads ? ` on ${status.threads} CPU threads` : ''}.{' '}
          {isLargeWakeModel(status.modelLabel)
            ? 'This model is large, so on-device recognition lags speech; install “Whisper Base/Tiny” for near-realtime wakes.'
            : 'Near-realtime on-device recognition.'}
        </span>
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '8px 10px',
        borderRadius: 8,
        background: '#2a2312',
        border: '1px solid #6b5518',
        fontSize: 11,
        color: '#ffd479',
      }}
    >
      <strong>A speech-model wake cannot listen yet</strong>
      {status.reason ? <span>{status.reason}</span> : null}
      <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {steps.map((step) => (
          <li key={step.label} style={{ color: step.done ? '#8fe3c0' : '#ffd479' }}>
            {step.done ? '✓ ' : '• '}
            {step.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
