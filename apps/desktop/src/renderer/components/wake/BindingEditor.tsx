/**
 * One wake-word binding card.
 *
 * A binding is a phrase + the agent it activates + the on-device engine that
 * listens for it, with an optional recorded voice sample (custom detector) and
 * sensitivity. Fields that still block the binding from arming are highlighted so
 * a user who added a wake word can see exactly what is left to configure.
 *
 * TRUST: detection runs entirely on this machine. A wake word is not sign-in: it
 * only opens the agent's chat and starts dictation — it can never approve a
 * payment or a 2FA prompt.
 */

import { useCallback, useState } from 'react';
import { bindingPhrases } from '../../../shared/wake.js';
import { isAutoBinding } from '../../../shared/wake-automap.js';
import type { LocalVoiceState, WakeAgentRow, WakeWordBinding } from '../../bridge.js';
import { createUtteranceSource } from '../../wake/utterance.js';
import { startEnrollment, type EnrollmentSession } from '../../wake/enroll.js';
import { AliasEditor } from './AliasEditor.js';
import {
  SUGGESTED_PHRASES,
  card,
  chip,
  field,
  input,
  inputNeedsAttention,
  recordButtonActive,
  tinyButton,
} from './parts.js';

export function BindingEditor({
  binding,
  agents,
  wakeModels,
  busy,
  isSttModel,
  onChange,
  onRemove,
}: {
  binding: WakeWordBinding;
  agents: WakeAgentRow[];
  wakeModels: LocalVoiceState['models'];
  busy: boolean;
  /** True when the chosen model transcribes on-device (a speech model). */
  isSttModel: (modelId: string | null) => boolean;
  onChange: (next: WakeWordBinding) => void;
  onRemove: () => void;
}) {
  const [recording, setRecording] = useState<EnrollmentSession | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const auto = isAutoBinding(binding);

  const startRecording = useCallback(async () => {
    setRecordError(null);
    try {
      const session = await startEnrollment(createUtteranceSource());
      setRecording(session);
    } catch (err) {
      setRecordError(err instanceof Error ? err.message : 'Could not start recording.');
    }
  }, []);

  const finishRecording = useCallback(async () => {
    const session = recording;
    setRecording(null);
    if (!session) return;
    const result = await session.finish();
    if (!result) {
      setRecordError('No audio was captured. Try again closer to the microphone.');
      return;
    }
    // A recorded sample switches this binding to the on-device custom detector.
    onChange({ ...binding, sampleFingerprint: result.fingerprint, sampleRef: null });
  }, [binding, onChange, recording]);

  // Highlight the fields that still block this binding from arming, so a user
  // who added a wake word knows exactly what is left to configure.
  const sttChosen = isSttModel(binding.modelId);
  const missingPhrase = !binding.phrase.trim();
  const missingAgent = !binding.agentId;
  const missingModel = !binding.modelId && !binding.sampleFingerprint;
  const modelNeedsInstall =
    missingModel === false &&
    !binding.sampleFingerprint &&
    wakeModels.find((m) => m.id === binding.modelId)?.installState !== 'installed';

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <label style={{ ...field, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={binding.enabled}
            disabled={busy}
            onChange={(e) => onChange({ ...binding, enabled: e.target.checked })}
          />
          <span style={{ color: '#e8eef4', fontWeight: 600 }}>
            {binding.phrase || 'New wake word'}
          </span>
        </label>
        {auto ? (
          <span style={{ ...chip, borderColor: '#6a3f9e', color: '#d8a5ff' }} title="From the agent's name">
            auto
          </span>
        ) : null}
        {sttChosen ? (
          <span style={{ ...chip, borderColor: '#2f5c9e', color: '#7fb2ff' }} title="Matched by on-device speech recognition">
            any phrase
          </span>
        ) : null}
        {sttChosen && binding.aliases.length ? (
          <span
            style={{ ...chip, borderColor: '#2f5c9e', color: '#7fb2ff' }}
            title={`Also wakes on: ${bindingPhrases(binding).slice(1).join(', ')}`}
          >
            +{binding.aliases.length} alias{binding.aliases.length === 1 ? '' : 'es'}
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        <button type="button" style={tinyButton} disabled={busy} onClick={onRemove}>
          {auto ? 'Remove (adds to the auto-map blocklist)' : 'Remove'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <label style={{ ...field, flex: 1, minWidth: 190 }}>
          <span>
            Spoken phrase
            {missingPhrase ? <span style={{ color: '#fbbf24' }}> · required</span> : null}
          </span>
          <input
            style={missingPhrase ? inputNeedsAttention : input}
            value={binding.phrase}
            placeholder="Hey Jarvis — or any phrase, e.g. an agent name"
            list={`wake-phrases-${binding.id}`}
            disabled={busy}
            onChange={(e) => onChange({ ...binding, phrase: e.target.value })}
          />
          <datalist id={`wake-phrases-${binding.id}`}>
            {SUGGESTED_PHRASES.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </label>

        <label style={{ ...field, flex: 1, minWidth: 190 }}>
          <span>
            Activates agent
            {missingAgent ? <span style={{ color: '#fbbf24' }}> · suggested</span> : null}
          </span>
          <select
            style={missingAgent ? inputNeedsAttention : input}
            value={binding.agentId ?? ''}
            disabled={busy}
            onChange={(e) => {
              const agent = agents.find((a) => a.contactId === e.target.value) ?? null;
              onChange({
                ...binding,
                agentId: agent?.contactId ?? null,
                agentName: agent?.name ?? null,
              });
            }}
          >
            <option value="">Choose an agent…</option>
            {agents.map((agent) => (
              <option key={agent.contactId} value={agent.contactId}>
                {agent.name}
                {agent.canConfigure ? '' : ' (public)'}
              </option>
            ))}
          </select>
        </label>
      </div>

      <AliasEditor
        aliases={binding.aliases}
        primary={binding.phrase}
        enabled={sttChosen}
        busy={busy}
        onChange={(aliases) => onChange({ ...binding, aliases })}
      />

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <label style={{ ...field, flex: 1, minWidth: 190 }}>
          <span>
            Engine
            {missingModel ? <span style={{ color: '#fbbf24' }}> · required</span> : null}
          </span>

          <select
            style={missingModel || modelNeedsInstall ? inputNeedsAttention : input}
            value={binding.modelId ?? ''}
            disabled={busy || Boolean(binding.sampleFingerprint)}
            onChange={(e) => onChange({ ...binding, modelId: e.target.value || null })}
          >
            <option value="">Choose a model…</option>
            {wakeModels.some((m) => m.kind === 'stt') ? (
              <optgroup label="Speech model — wake on ANY phrase (recommended for names)">
                {wakeModels
                  .filter((m) => m.kind === 'stt')
                  .map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                      {model.installState === 'installed' ? ' ✓ installed' : ' (not installed)'}
                    </option>
                  ))}
              </optgroup>
            ) : null}
            {wakeModels.some((m) => m.kind === 'wake') ? (
              <optgroup label="Wake-word model — fires on its own fixed phrase only">
                {wakeModels
                  .filter((m) => m.kind === 'wake')
                  .map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                      {model.installState === 'installed' ? ' ✓ installed' : ' (not installed)'}
                    </option>
                  ))}
              </optgroup>
            ) : null}
          </select>
          {binding.sampleFingerprint ? (
            <span style={{ color: '#6b7784' }}>Using your recorded sample instead of a model.</span>
          ) : sttChosen ? (
            <span style={{ color: '#7fb2ff' }}>
              Transcribes on this machine and matches the phrase as text — works for any phrase,
              including this agent&apos;s name.
            </span>
          ) : missingModel ? (
            <span style={{ color: '#fbbf24' }}>
              Pick a speech model to wake on any phrase, or install a wake-word model.
            </span>
          ) : modelNeedsInstall ? (
            <span style={{ color: '#fbbf24' }}>Download the chosen model above to use it.</span>
          ) : (
            <span style={{ color: '#6b7784' }}>
              A wake-word model only fires on its own phrase. Pick a speech model to wake on any phrase.
            </span>
          )}
        </label>

        <label style={{ ...field, minWidth: 150 }}>
          <span>Sensitivity</span>
          <input
            style={input}
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={binding.sensitivity}
            disabled={busy}
            onChange={(e) => onChange({ ...binding, sensitivity: Number(e.target.value) })}
          />
          <span style={{ color: '#6b7784' }}>{binding.sensitivity.toFixed(2)} · higher fires more easily</span>
        </label>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        {recording ? (
          <button type="button" style={recordButtonActive} onClick={() => void finishRecording()}>
            ■ Stop &amp; save sample
          </button>
        ) : (
          <button type="button" style={tinyButton} disabled={busy} onClick={() => void startRecording()}>
            ● Record a voice sample (optional)
          </button>
        )}
        {recording ? (
          <span style={{ color: '#fbbf24', fontSize: 11 }}>Recording… say “{binding.phrase || 'your phrase'}”.</span>
        ) : null}
        {binding.sampleFingerprint ? (
          <button
            type="button"
            style={tinyButton}
            disabled={busy}
            onClick={() => onChange({ ...binding, sampleFingerprint: null })}
          >
            Clear sample
          </button>
        ) : null}
        {recordError ? <span style={{ color: '#f87171', fontSize: 11 }}>{recordError}</span> : null}
      </div>

      <span style={{ fontSize: 11, color: '#6b7784' }}>
        Detection runs entirely on this machine. A wake word is not sign-in: it only opens the
        agent&apos;s chat and starts dictation — it can never approve a payment or a 2FA prompt.
      </span>
    </div>
  );
}
