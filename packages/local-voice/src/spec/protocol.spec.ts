import { describe, expect, it } from 'vitest';
import {
  normalizeBaseUrl,
  resolveEndpoint,
  validateBaseUrl,
  VOICE_ENGINE_PROTOCOL_DEFAULTS,
} from '../protocol.js';

describe('normalizeBaseUrl', () => {
  it('trims and strips trailing slashes', () => {
    expect(normalizeBaseUrl('  http://127.0.0.1:8000//  ')).toBe('http://127.0.0.1:8000');
    expect(normalizeBaseUrl('')).toBeNull();
    expect(normalizeBaseUrl(null)).toBeNull();
  });
});

describe('validateBaseUrl', () => {
  it('accepts http and https', () => {
    expect(validateBaseUrl('http://localhost:9000')).toBeNull();
    expect(validateBaseUrl('https://my-box.local:8443')).toBeNull();
  });

  it('rejects empty, relative, and non-http schemes', () => {
    expect(validateBaseUrl('')).toMatch(/Enter a base URL/);
    expect(validateBaseUrl('not a url')).toMatch(/valid URL/);
    expect(validateBaseUrl('ftp://host')).toMatch(/http/);
  });
});

describe('resolveEndpoint', () => {
  it('uses protocol defaults for a known protocol', () => {
    const stt = resolveEndpoint({ kind: 'stt', protocol: 'whisper_rest' });
    expect(stt.baseUrl).toBe(VOICE_ENGINE_PROTOCOL_DEFAULTS.whisper_rest.baseUrl);
    expect(stt.url).toBe(`${VOICE_ENGINE_PROTOCOL_DEFAULTS.whisper_rest.baseUrl}/inference`);
  });

  it('prefers an explicit custom base URL and path', () => {
    const e = resolveEndpoint({
      kind: 'stt',
      protocol: 'openai_audio',
      baseUrl: 'https://my-server:8443/',
      path: '/audio/transcribe',
    });
    expect(e.url).toBe('https://my-server:8443/audio/transcribe');
  });

  it('leaves nexus endpoints base-url-less (region is implicit)', () => {
    const e = resolveEndpoint({ kind: 'tts', protocol: 'nexus', baseUrl: '' });
    expect(e.baseUrl).toBeNull();
    expect(e.url).toBe('');
  });

  it('only relaxes TLS for https endpoints the user flagged', () => {
    expect(
      resolveEndpoint({ kind: 'stt', protocol: 'custom', baseUrl: 'https://self-signed.local', ignoreTls: true })
        .relaxTls,
    ).toBe(true);
    expect(
      resolveEndpoint({ kind: 'stt', protocol: 'custom', baseUrl: 'http://plain.local', ignoreTls: true })
        .relaxTls,
    ).toBe(false);
    expect(
      resolveEndpoint({ kind: 'stt', protocol: 'custom', baseUrl: 'https://self-signed.local' }).relaxTls,
    ).toBe(false);
  });

  it('coerces an unknown protocol to custom', () => {
    const e = resolveEndpoint({ kind: 'stt', protocol: 'nope' as never, baseUrl: 'http://x' });
    expect(e.protocol).toBe('custom');
  });
});
