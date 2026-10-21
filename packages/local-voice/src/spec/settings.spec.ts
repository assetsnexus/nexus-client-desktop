import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCAL_VOICE_SETTINGS,
  idlePolicyFromSettings,
  normalizeCustomEndpoint,
  normalizeLocalVoiceSettings,
  validateLocalVoiceSettings,
} from '../settings.js';

describe('normalizeLocalVoiceSettings', () => {
  it('returns defaults for an empty blob', () => {
    expect(normalizeLocalVoiceSettings(null)).toEqual(DEFAULT_LOCAL_VOICE_SETTINGS);
    expect(normalizeLocalVoiceSettings({})).toEqual(DEFAULT_LOCAL_VOICE_SETTINGS);
  });

  it('coerces invalid engine modes and clamps idle', () => {
    const s = normalizeLocalVoiceSettings({ sttEngine: 'nope', idleTimeoutSeconds: 999999 });
    expect(s.sttEngine).toBe('cloud');
    expect(s.idleTimeoutSeconds).toBe(3600);
  });

  it('keeps valid persisted values', () => {
    const s = normalizeLocalVoiceSettings({
      enabled: false,
      sttEngine: 'local',
      ttsEngine: 'local',
      sttModelId: 'catalog:whisper',
      idleTimeoutSeconds: 0,
      ignoreTlsForCustom: true,
    });
    expect(s).toMatchObject({
      enabled: false,
      sttEngine: 'local',
      ttsEngine: 'local',
      sttModelId: 'catalog:whisper',
      idleTimeoutSeconds: 0,
      ignoreTlsForCustom: true,
    });
  });
});

describe('normalizeCustomEndpoint', () => {
  it('drops an endpoint with no base URL', () => {
    expect(normalizeCustomEndpoint({ protocol: 'ollama' }, 'stt')).toBeNull();
    expect(normalizeCustomEndpoint(null, 'stt')).toBeNull();
  });

  it('fills defaults and rejects an unknown protocol', () => {
    const e = normalizeCustomEndpoint({ protocol: 'bogus', baseUrl: 'http://x:1' }, 'tts')!;
    expect(e.protocol).toBe('custom');
    expect(e.kind).toBe('tts');
    expect(e.label).toBe('Custom TTS');
    expect(e.ignoreTls).toBe(false);
  });
});

describe('validateLocalVoiceSettings', () => {
  it('flags a local engine with no model and no endpoint', () => {
    const v = validateLocalVoiceSettings({ ...DEFAULT_LOCAL_VOICE_SETTINGS, sttEngine: 'local' });
    expect(v.valid).toBe(false);
    expect(v.errors.sttModel).toBeTruthy();
  });

  it('flags a bad custom endpoint URL', () => {
    const v = validateLocalVoiceSettings({
      ...DEFAULT_LOCAL_VOICE_SETTINGS,
      sttEngine: 'local',
      customSttEndpoint: {
        id: 'x',
        kind: 'stt',
        label: 'X',
        protocol: 'custom',
        baseUrl: 'not-a-url',
        ignoreTls: false,
      },
    });
    expect(v.valid).toBe(false);
    expect(v.errors.customSttEndpoint).toMatch(/valid URL/);
  });

  it('flags a self-signed https endpoint that was not acknowledged', () => {
    const v = validateLocalVoiceSettings({
      ...DEFAULT_LOCAL_VOICE_SETTINGS,
      sttEngine: 'local',
      customSttEndpoint: {
        id: 'x',
        kind: 'stt',
        label: 'X',
        protocol: 'custom',
        baseUrl: 'https://self-signed.local',
        ignoreTls: false,
      },
      ignoreTlsForCustom: true, // resolved URL would relax TLS, but the endpoint itself did not opt in
    });
    expect(v.errors.customSttEndpointTls).toBeTruthy();
  });

  it('accepts a local model id', () => {
    const v = validateLocalVoiceSettings({
      ...DEFAULT_LOCAL_VOICE_SETTINGS,
      sttEngine: 'local',
      sttModelId: 'catalog:whisper',
    });
    expect(v.valid).toBe(true);
  });

  it('accepts the cloud default', () => {
    expect(validateLocalVoiceSettings(DEFAULT_LOCAL_VOICE_SETTINGS).valid).toBe(true);
  });
});

describe('idlePolicyFromSettings', () => {
  it('converts seconds to ms', () => {
    expect(idlePolicyFromSettings({ ...DEFAULT_LOCAL_VOICE_SETTINGS, idleTimeoutSeconds: 30 })).toEqual({
      idleTimeoutMs: 30_000,
    });
  });
});
