/**
 * TTS model + voice picker with an inline "test voice" button.
 *
 * Both settings surfaces need the *same* voice logic: the app default
 * (`CompanionSection`) and a per-agent override (`AgentsSection`). The logic is
 * subtle enough to be worth centralising:
 *
 *  - the voice list is model-scoped, so it is fetched from the region when the
 *    model changes (`anx.inference.tts.voices.list`);
 *  - a model may select voices by name (Google/OpenAI style) or by
 *    `reference_id` (Fish-Audio style), and its capability set decides whether a
 *    WAV voice sample is even accepted — that is what the badges show;
 *  - the persisted voice id may not be in the freshly-fetched list (a custom id,
 *    or a live list that failed), so it is preserved as a custom option instead
 *    of silently resetting the user's choice;
 *  - "test" speaks a short sample with **exactly** the selected model + voice, so
 *    the button proves the choice before it is saved.
 *
 * The picker is presentational + self-contained: it loads and plays on its own,
 * and reports selection changes up. The parent owns persistence.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createAndPollTts,
  listTtsVoices,
  playAudioUrl,
  uploadAttachment,
  type AudioModelListItem,
  type CommandClient,
  type TtsVoiceListItem,
} from '@nexus/chat-core';
import { useI18n } from '../../i18n/index.js';
import { summarizeTtsCapabilities, ttsVoiceSelectMode } from '../../../shared/tts.js';
import { Field, settingsGhostButton, settingsHint, settingsInput } from './settings-ui.js';

/** Short sample read aloud by the test button (long enough to judge a voice). */
const TEST_PHRASE = 'Hi, this is how I sound.';

export function TtsVoicePicker({
  client,
  models,
  modelId,
  voiceId,
  disabled,
  noneLabel,
  voiceSampleRef,
  voiceSampleTranscript,
  onModelChange,
  onVoiceChange,
}: {
  client: CommandClient | null;
  /** Entitled, runnable TTS models (already filtered by the parent). */
  models: AudioModelListItem[];
  modelId: string;
  voiceId: string;
  disabled?: boolean;
  /**
   * Label for the empty model option. Defaults to "None"; the per-agent row
   * passes "Use default" because an empty value there means *inherit* the app
   * default rather than "no voice at all".
   */
  noneLabel?: string;
  /**
   * Optional WAV clone sample for the selected model. When present the test
   * button clones from it, so the preview is exactly what will be spoken — not a
   * stock voice that happens to share the model.
   */
  voiceSampleRef?: { bucketId: string; objectKey: string } | null;
  voiceSampleTranscript?: string | null;
  onModelChange: (modelId: string) => void;
  onVoiceChange: (voiceId: string) => void;
}) {
  const { t } = useI18n();
  const [voices, setVoices] = useState<TtsVoiceListItem[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  /** Rises once the live list failed, so the note only shows for a real failure. */
  const [voicesFailed, setVoicesFailed] = useState(false);
  /**
   * The voice-selection mode the region reported for the model's live list.
   *
   * Authoritative when present: the static `capabilities` array is only a hint
   * (a Fish Audio row, for example, ships `tts`/`voice-cloning` but not a literal
   * `reference_id` capability), whereas `anx.inference.tts.voices.list` knows the
   * real selector. Falls back to the capability heuristic when no list arrived.
   */
  const [liveVoiceMode, setLiveVoiceMode] = useState<'reference_id' | 'name' | null>(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const selected = useMemo(() => models.find((m) => m.id === modelId) ?? null, [models, modelId]);
  const caps = useMemo(
    () => summarizeTtsCapabilities(selected?.capabilities),
    [selected?.capabilities],
  );

  // Load the model's voice list whenever the model changes.
  useEffect(() => {
    let cancelled = false;
    setVoicesFailed(false);
    setLiveVoiceMode(null);
    if (!client || !modelId) {
      setVoices([]);
      return;
    }
    setVoicesLoading(true);
    void listTtsVoices(client, { modelId })
      .then((result) => {
        if (cancelled) return;
        setVoices(result.voices);
        setLiveVoiceMode(result.voiceSelectMode);
      })
      .catch(() => {
        if (!cancelled) {
          setVoices([]);
          setVoicesFailed(true);
        }
      })
      .finally(() => {
        if (!cancelled) setVoicesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, modelId]);

  // Stop any in-flight preview when the window unmounts or the model changes.
  const stopAudio = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.src = '';
    audioRef.current = null;
  }, []);
  useEffect(() => stopAudio, [stopAudio, modelId]);

  // Keep a persisted voice that is not in the live list as an explicit option:
  // silently resetting it would erase a custom reference_id on the next save.
  const options = useMemo(() => {
    const list = voices.map((v) => ({ id: v.id, title: v.title || v.id }));
    const current = voiceId.trim();
    if (current && !list.some((o) => o.id === current)) {
      list.unshift({ id: current, title: t('settings.tts.voice.custom', { id: current }) });
    }
    return list;
  }, [voices, voiceId, t]);

  const test = useCallback(async () => {
    if (!client || !modelId) return;
    stopAudio();
    setTesting(true);
    setTestError(null);
    try {
      const result = await createAndPollTts(
        client,
        {
          model: modelId,
          text: TEST_PHRASE,
          voice: voiceId.trim() || undefined,
          // Clone from the sample when one is attached: the preview must be the
          // voice that will actually be used, not the model's stock voice.
          voiceSampleRef: voiceSampleRef ?? undefined,
          voiceSampleTranscript: voiceSampleTranscript ?? undefined,
        },
        { intervalMs: 800, maxAttempts: 60 },
      );
      if (!result.ok) {
        setTestError(result.errorMessage || t('settings.tts.testFailed'));
        return;
      }
      audioRef.current = await playAudioUrl(result.audioUrl);
    } catch (err) {
      setTestError(err instanceof Error ? err.message : t('settings.tts.testFailed'));
    } finally {
      setTesting(false);
    }
  }, [client, modelId, voiceId, voiceSampleRef, voiceSampleTranscript, stopAudio, t]);

  const voiceMode = liveVoiceMode ?? (selected ? ttsVoiceSelectMode(selected.capabilities) : null);

  return (
    <>
      <Field label={t('settings.tts.model')} hint={t('settings.tts.model.help')}>
        <select
          style={settingsInput}
          value={modelId}
          disabled={disabled || !client}
          onChange={(e) => onModelChange(e.target.value)}
        >
          <option value="">{noneLabel ?? t('settings.tts.model.none')}</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName || m.id}
            </option>
          ))}
        </select>
      </Field>

      {selected ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: -2 }}>
          <CapBadge on={caps.supportsVoiceSample} label={t('settings.tts.cap.voiceSample')} />
          <CapBadge on={caps.streaming} label={t('settings.tts.cap.streaming')} />
          <CapBadge on={caps.multilingual} label={t('settings.tts.cap.multilingual')} />
          {voiceMode ? (
            <CapBadge
              on
              label={
                voiceMode === 'reference_id'
                  ? t('settings.tts.cap.referenceId')
                  : t('settings.tts.cap.namedVoices')
              }
            />
          ) : null}
        </div>
      ) : null}

      <Field label={t('settings.tts.voice')} hint={t('settings.tts.voice.help')}>
        <select
          style={settingsInput}
          value={voiceId}
          disabled={disabled || !client || !modelId || (voicesLoading && !options.length)}
          onChange={(e) => onVoiceChange(e.target.value)}
        >
          <option value="">
            {voicesLoading
              ? t('settings.loading')
              : options.length
                ? t('settings.tts.voice.default')
                : t('settings.tts.voice.none')}
          </option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.title}
            </option>
          ))}
        </select>
      </Field>
      {voicesFailed ? <span style={settingsHint}>{t('settings.tts.voice.unavailable')}</span> : null}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button
          type="button"
          style={settingsGhostButton}
          disabled={disabled || testing || !client || !modelId}
          onClick={() => void test()}
        >
          {testing ? t('settings.tts.testing') : t('settings.tts.test')}
        </button>
        {testError ? <span style={{ color: '#f2a1a1', fontSize: 12 }}>{testError}</span> : null}
        {!testError && !testing ? (
          <span style={settingsHint}>{t('settings.tts.test.help')}</span>
        ) : null}
      </div>
    </>
  );
}

/** A small on/off capability chip (on = the model has the capability). */
function CapBadge({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        padding: '2px 7px',
        borderRadius: 999,
        color: on ? '#4ade80' : '#6b7784',
        border: `1px solid ${on ? '#2f6b48' : '#2a333d'}`,
        background: on ? '#12251b' : 'transparent',
        textTransform: 'uppercase',
        letterSpacing: 0.4,
      }}
    >
      {label}
    </span>
  );
}

/**
 * The "test voice" sample phrase. Exported so the spec can assert the exact text
 * the button speaks without duplicating the literal.
 */
export const TTS_TEST_PHRASE = TEST_PHRASE;

/**
 * Optional WAV voice sample for a model that supports cloning (`voice-cloning`).
 *
 * The region stores the sample as a bucket object (`voiceSampleRef`) plus an
 * optional transcript; the picker only has to upload one and show the current
 * state. Kept in this module because it is the other half of "how a voice is
 * chosen" and both call sites that pick a voice can offer it.
 */
export function TtsVoiceSampleField({
  client,
  disabled,
  supportsSample,
  canSet,
  currentRef,
  transcript,
  onRefChange,
  onTranscriptChange,
  onClear,
}: {
  client: CommandClient | null;
  disabled?: boolean;
  /** The selected model advertises `voice-cloning`. */
  supportsSample: boolean;
  /** The region allows this contact to carry a sample (`canSetVoiceSample`). */
  canSet: boolean;
  currentRef: { bucketId: string; objectKey: string } | null;
  transcript: string;
  onRefChange: (ref: { bucketId: string; objectKey: string } | null) => void;
  onTranscriptChange: (text: string) => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = useCallback(
    async (file: File) => {
      if (!client) return;
      setUploading(true);
      setError(null);
      try {
        const uploaded = await uploadAttachment(client, file, {
          module: 'contact-tts-voice',
          originalName: file.name || 'voice-sample.wav',
          encryptionTier: 'user-known',
        });
        onRefChange({ bucketId: uploaded.workspaceId, objectKey: uploaded.storageKey });
      } catch (err) {
        setError(err instanceof Error ? err.message : t('settings.tts.sample.failed'));
      } finally {
        setUploading(false);
      }
    },
    [client, onRefChange, t],
  );

  // The sample only makes sense on a cloning-capable model the region permits.
  if (!canSet || !supportsSample) return null;

  return (
    <>
      <Field
        label={t('settings.tts.sample')}
        hint={t('settings.tts.sample.help')}
      >
        <input
          type="file"
          accept="audio/wav,audio/x-wav,audio/wave,.wav"
          disabled={disabled || uploading || !client}
          style={{ color: '#9aa7b5', fontSize: 12 }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
            e.target.value = '';
          }}
        />
      </Field>
      {currentRef ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ color: '#4ade80', fontSize: 12 }}>
            {t('settings.tts.sample.attached', { key: currentRef.objectKey })}
          </span>
          <button type="button" style={settingsGhostButton} disabled={disabled} onClick={onClear}>
            {t('settings.tts.sample.clear')}
          </button>
        </div>
      ) : (
        <span style={settingsHint}>{t('settings.tts.sample.none')}</span>
      )}
      <Field label={t('settings.tts.sample.transcript')} hint={t('settings.tts.sample.transcript.help')}>
        <input
          type="text"
          style={settingsInput}
          value={transcript}
          disabled={disabled || uploading}
          onChange={(e) => onTranscriptChange(e.target.value)}
        />
      </Field>
      {uploading ? <span style={settingsHint}>{t('settings.tts.sample.uploading')}</span> : null}
      {error ? <span style={{ color: '#f2a1a1', fontSize: 12 }}>{error}</span> : null}
    </>
  );
}
