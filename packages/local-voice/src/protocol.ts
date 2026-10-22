/**
 * Voice engine protocol (@nexus/local-voice).
 *
 * Kept in sync with `@nexus/meetings-core` `VoiceEngineProtocol`: the desktop
 * main process resolves the same protocol/URL rules as the meeting view so a
 * custom endpoint behaves identically wherever it is configured. A custom
 * endpoint may use a self-signed certificate; `resolveEndpointTls` decides
 * whether the host should relax validation for that endpoint only.
 */

/**
 * Modalities the desktop can install and run on-device. `stt`/`tts` are speech
 * engines; `vad` (voice-activity detection) and `wake` (wake-word detection) are
 * the always-on, low-power detectors the client runs locally to decide when to
 * start listening — they share the same download/install machinery.
 */
export type VoiceEngineKind = 'stt' | 'tts' | 'vad' | 'wake';

/** Modalities that require a microphone and run continuously (never cloud). */
export const ON_DEVICE_DETECTOR_KINDS: readonly VoiceEngineKind[] = ['vad', 'wake'];

export type VoiceEngineProtocol =
  | 'nexus'
  | 'openai_audio'
  | 'whisper_rest'
  | 'ollama'
  | 'custom';

export const VOICE_ENGINE_PROTOCOLS: VoiceEngineProtocol[] = [
  'nexus',
  'openai_audio',
  'whisper_rest',
  'ollama',
  'custom',
];

export const VOICE_ENGINE_PROTOCOL_LABELS: Record<VoiceEngineProtocol, string> = {
  nexus: 'Nexus inference (region)',
  openai_audio: 'OpenAI-compatible audio',
  whisper_rest: 'Whisper REST',
  ollama: 'Ollama',
  custom: 'Custom',
};

export const VOICE_ENGINE_PROTOCOL_DEFAULTS: Record<
  VoiceEngineProtocol,
  { sttPath: string; ttsPath: string; baseUrl: string }
> = {
  nexus: { sttPath: '/anx.inference.stt.create', ttsPath: '/anx.inference.tts.create', baseUrl: '' },
  openai_audio: { sttPath: '/v1/audio/transcriptions', ttsPath: '/v1/audio/speech', baseUrl: 'http://127.0.0.1:8000' },
  whisper_rest: { sttPath: '/inference', ttsPath: '', baseUrl: 'http://127.0.0.1:9000' },
  ollama: { sttPath: '/api/transcribe', ttsPath: '', baseUrl: 'http://127.0.0.1:11434' },
  custom: { sttPath: '', ttsPath: '', baseUrl: '' },
};

export type ResolvedEndpoint = {
  kind: VoiceEngineKind;
  protocol: VoiceEngineProtocol;
  baseUrl: string | null;
  url: string;
  /** True when the host should disable certificate validation for this endpoint. */
  relaxTls: boolean;
};

export function normalizeBaseUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, '');
}

export function validateBaseUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return 'Enter a base URL.';
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return 'Not a valid URL (include http:// or https://).';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'Only http:// or https:// URLs are supported.';
  }
  if (!url.hostname) return 'The URL is missing a host.';
  return null;
}

/**
 * Resolve a concrete request URL + TLS policy. TLS is relaxed only for an
 * explicit `https` endpoint the user flagged; plain http has nothing to relax.
 */
export function resolveEndpoint(input: {
  kind: VoiceEngineKind;
  protocol: VoiceEngineProtocol;
  baseUrl?: string | null;
  path?: string | null;
  ignoreTls?: boolean;
}): ResolvedEndpoint {
  const protocol = VOICE_ENGINE_PROTOCOLS.includes(input.protocol) ? input.protocol : 'custom';
  const defaults = VOICE_ENGINE_PROTOCOL_DEFAULTS[protocol];
  const baseUrl = normalizeBaseUrl(input.baseUrl) ?? (protocol === 'nexus' ? null : defaults.baseUrl);
  const path = (input.path ?? '').trim() || (input.kind === 'stt' ? defaults.sttPath : defaults.ttsPath);
  if (!baseUrl) {
    return { kind: input.kind, protocol, baseUrl: null, url: '', relaxTls: false };
  }
  const url = `${baseUrl}${path || ''}`;
  const relaxTls = /^https:\/\//i.test(url) && input.ignoreTls === true;
  return { kind: input.kind, protocol, baseUrl, url, relaxTls };
}
