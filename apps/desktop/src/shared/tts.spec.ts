import { describe, expect, it } from 'vitest';
import {
  DEFAULT_APP_DEFAULT_TTS,
  normalizeAppDefaultTts,
  resolveAppDefaultTts,
  summarizeTtsCapabilities,
  ttsModelSupportsVoiceSample,
  ttsVoiceSelectMode,
} from './tts.js';

/**
 * The app-default voice picker leans on these helpers for three things that are
 * easy to get subtly wrong: which voice-selection model a catalog entry uses
 * (`reference_id` vs a named list), whether a WAV sample is even accepted, and
 * whether a half-configured default should be used at all.
 */

describe('ttsVoiceSelectMode', () => {
  it('treats a reference_id capability as the Fish-Audio style', () => {
    expect(ttsVoiceSelectMode(['tts', 'tts_stream', 'reference_id'])).toBe('reference_id');
    expect(ttsVoiceSelectMode(['voice-cloning', 'reference-id'])).toBe('reference_id');
  });

  it('treats a generic tts/voice capability as a named-voice list', () => {
    expect(ttsVoiceSelectMode(['tts', 'tts_stream'])).toBe('name');
    expect(ttsVoiceSelectMode(['named_voice'])).toBe('name');
  });

  it('treats a cloning-capable model with no named list as the reference-id style', () => {
    // A Fish Audio catalog row ships cloning but no literal `reference_id`
    // capability; the live voice list confirms the mode, and this heuristic
    // matches it (the picker prefers the live value when it has one).
    expect(ttsVoiceSelectMode(['tts', 'tts_stream', 'voice-cloning', 'multilingual'])).toBe(
      'reference_id',
    );
  });

  it('returns null when the model exposes no voice selection', () => {
    expect(ttsVoiceSelectMode(['image_gen'])).toBeNull();
    expect(ttsVoiceSelectMode([])).toBeNull();
    expect(ttsVoiceSelectMode(null)).toBeNull();
  });

  it('prefers reference_id when a model claims both styles', () => {
    expect(ttsVoiceSelectMode(['named_voice', 'reference_id'])).toBe('reference_id');
  });
});

describe('summarizeTtsCapabilities', () => {
  it('flags a Fish Audio row as reference-id + voice-cloning + multilingual', () => {
    expect(summarizeTtsCapabilities(['tts', 'tts_stream', 'voice-cloning', 'multilingual'])).toEqual({
      namedVoices: false,
      referenceId: true,
      supportsVoiceSample: true,
      streaming: true,
      multilingual: true,
    });
  });

  it('flags a plain TTS row as named voices without a sample', () => {
    expect(summarizeTtsCapabilities(['tts'])).toEqual({
      namedVoices: true,
      referenceId: false,
      supportsVoiceSample: false,
      streaming: false,
      multilingual: false,
    });
  });

  it('is case-insensitive and tolerant of underscores', () => {
    expect(summarizeTtsCapabilities(['TTS_STREAM', 'Voice_Cloning'])).toMatchObject({
      streaming: true,
      supportsVoiceSample: true,
    });
  });

  it('treats an absent capability set as inert', () => {
    expect(summarizeTtsCapabilities(undefined)).toEqual({
      namedVoices: false,
      referenceId: false,
      supportsVoiceSample: false,
      streaming: false,
      multilingual: false,
    });
  });
});

describe('ttsModelSupportsVoiceSample', () => {
  it('is true only for a cloning-capable model', () => {
    expect(ttsModelSupportsVoiceSample(['voice-cloning'])).toBe(true);
    expect(ttsModelSupportsVoiceSample(['tts', 'multilingual'])).toBe(false);
  });
});

describe('normalizeAppDefaultTts', () => {
  it('defaults to off with no model, voice, or sample', () => {
    expect(normalizeAppDefaultTts(null)).toEqual(DEFAULT_APP_DEFAULT_TTS);
    expect(normalizeAppDefaultTts({ enabled: 'yes', modelId: 5 })).toEqual(DEFAULT_APP_DEFAULT_TTS);
  });

  it('keeps a voice only alongside a model', () => {
    expect(
      normalizeAppDefaultTts({ enabled: true, modelId: 'm', voiceId: 'v' }),
    ).toEqual({
      enabled: true,
      modelId: 'm',
      voiceId: 'v',
      voiceSampleRef: null,
      voiceSampleTranscript: null,
    });
    // A voice with no model is dropped rather than persisted as an orphan.
    expect(normalizeAppDefaultTts({ enabled: true, voiceId: 'v' })).toEqual({
      enabled: true,
      modelId: null,
      voiceId: null,
      voiceSampleRef: null,
      voiceSampleTranscript: null,
    });
  });

  it('trims blanks to null', () => {
    expect(normalizeAppDefaultTts({ modelId: '  m  ', voiceId: '   ' })).toEqual({
      enabled: false,
      modelId: 'm',
      voiceId: null,
      voiceSampleRef: null,
      voiceSampleTranscript: null,
    });
  });

  it('keeps a complete clone sample with its model, dropping a partial ref', () => {
    expect(
      normalizeAppDefaultTts({
        enabled: true,
        modelId: 'm',
        voiceSampleRef: { bucketId: 'ws', objectKey: 'a.wav' },
        voiceSampleTranscript: '  sample words  ',
      }),
    ).toEqual({
      enabled: true,
      modelId: 'm',
      voiceId: null,
      voiceSampleRef: { bucketId: 'ws', objectKey: 'a.wav' },
      voiceSampleTranscript: 'sample words',
    });
    // Half a ref cannot resolve an object, so it is dropped entirely.
    expect(
      normalizeAppDefaultTts({ enabled: true, modelId: 'm', voiceSampleRef: { bucketId: 'ws' } }),
    ).toMatchObject({ voiceSampleRef: null, voiceSampleTranscript: null });
    // A sample needs a model to be cloned by.
    expect(
      normalizeAppDefaultTts({
        modelId: null,
        voiceSampleRef: { bucketId: 'ws', objectKey: 'a.wav' },
        voiceSampleTranscript: 'words',
      }),
    ).toMatchObject({ voiceSampleRef: null, voiceSampleTranscript: null });
  });
});

describe('resolveAppDefaultTts', () => {
  it('resolves only when enabled and a model is set', () => {
    expect(resolveAppDefaultTts({ enabled: true, modelId: 'm', voiceId: 'v' })).toEqual({
      modelId: 'm',
      voiceId: 'v',
      voiceSampleRef: null,
      voiceSampleTranscript: null,
    });
    expect(resolveAppDefaultTts({ enabled: false, modelId: 'm', voiceId: 'v' })).toBeNull();
    expect(resolveAppDefaultTts({ enabled: true, modelId: null, voiceId: null })).toBeNull();
    expect(resolveAppDefaultTts(null)).toBeNull();
  });

  it('passes a null voice through so the caller uses the model default', () => {
    expect(resolveAppDefaultTts({ enabled: true, modelId: 'm', voiceId: null })).toEqual({
      modelId: 'm',
      voiceId: null,
      voiceSampleRef: null,
      voiceSampleTranscript: null,
    });
  });

  it('carries the clone sample through for the caller', () => {
    expect(
      resolveAppDefaultTts({
        enabled: true,
        modelId: 'm',
        voiceId: null,
        voiceSampleRef: { bucketId: 'ws', objectKey: 'a.wav' },
        voiceSampleTranscript: 'words',
      }),
    ).toEqual({
      modelId: 'm',
      voiceId: null,
      voiceSampleRef: { bucketId: 'ws', objectKey: 'a.wav' },
      voiceSampleTranscript: 'words',
    });
  });
});
