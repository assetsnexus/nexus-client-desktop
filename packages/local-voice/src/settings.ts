/**
 * Local voice settings (@nexus/local-voice).
 *
 * The settings UI persists a small object; keeping its shape + validation here
 * (rather than only in the renderer) means the main process can trust what it
 * loads and the UI can render errors the same way. The custom-endpoint fields
 * mirror {@link CustomVoiceEndpoint} so selecting a protocol from the system
 * catalog + a custom URL + the ignore-TLS acknowledgement is a pure transform.
 */

import type { VoiceEngineKind, VoiceEngineProtocol } from './protocol.js';
import { resolveEndpoint, validateBaseUrl, VOICE_ENGINE_PROTOCOLS } from './protocol.js';
import type { CustomVoiceEndpoint } from './catalog.js';

export type LocalVoiceSettings = {
  enabled: boolean;
  /** Unload a local engine after this many seconds idle (VRAM/RAM saver). */
  idleTimeoutSeconds: number;
  /** Preferred engine per modality: 'cloud' uses region inference, 'local' on-device. */
  sttEngine: 'cloud' | 'local';
  ttsEngine: 'cloud' | 'local';
  /** Installed model ids per modality. */
  sttModelId: string | null;
  ttsModelId: string | null;
  /** Custom self-hosted endpoints (advanced). */
  customSttEndpoint: CustomVoiceEndpoint | null;
  customTtsEndpoint: CustomVoiceEndpoint | null;
  /** Whether to acknowledge a self-signed TLS endpoint for all custom endpoints. */
  ignoreTlsForCustom: boolean;
};

export const DEFAULT_LOCAL_VOICE_SETTINGS: LocalVoiceSettings = {
  enabled: true,
  idleTimeoutSeconds: 5 * 60,
  sttEngine: 'cloud',
  ttsEngine: 'cloud',
  sttModelId: null,
  ttsModelId: null,
  customSttEndpoint: null,
  customTtsEndpoint: null,
  ignoreTlsForCustom: false,
};

/** Coerce an untrusted persisted blob into valid settings. */
export function normalizeLocalVoiceSettings(raw: unknown): LocalVoiceSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const mode = (v: unknown, fallback: 'cloud' | 'local'): 'cloud' | 'local' =>
    v === 'local' || v === 'cloud' ? v : fallback;
  const idle = Number(r.idleTimeoutSeconds);
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_LOCAL_VOICE_SETTINGS.enabled,
    idleTimeoutSeconds:
      Number.isFinite(idle) && idle >= 0
        ? Math.min(60 * 60, Math.floor(idle))
        : DEFAULT_LOCAL_VOICE_SETTINGS.idleTimeoutSeconds,
    sttEngine: mode(r.sttEngine, DEFAULT_LOCAL_VOICE_SETTINGS.sttEngine),
    ttsEngine: mode(r.ttsEngine, DEFAULT_LOCAL_VOICE_SETTINGS.ttsEngine),
    sttModelId: typeof r.sttModelId === 'string' ? r.sttModelId : null,
    ttsModelId: typeof r.ttsModelId === 'string' ? r.ttsModelId : null,
    customSttEndpoint: normalizeCustomEndpoint(r.customSttEndpoint, 'stt'),
    customTtsEndpoint: normalizeCustomEndpoint(r.customTtsEndpoint, 'tts'),
    ignoreTlsForCustom: r.ignoreTlsForCustom === true,
  };
}

export function normalizeCustomEndpoint(raw: unknown, kind: VoiceEngineKind): CustomVoiceEndpoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const protocol = (VOICE_ENGINE_PROTOCOLS as string[]).includes(String(r.protocol))
    ? (r.protocol as VoiceEngineProtocol)
    : 'custom';
  const baseUrl = typeof r.baseUrl === 'string' ? r.baseUrl.trim() : '';
  if (!baseUrl) return null;
  return {
    id: typeof r.id === 'string' && r.id ? r.id : `${kind}-custom`,
    kind,
    label: typeof r.label === 'string' && r.label ? r.label : `Custom ${kind.toUpperCase()}`,
    protocol,
    baseUrl,
    ignoreTls: r.ignoreTls === true,
    apiKey: typeof r.apiKey === 'string' ? r.apiKey : null,
  };
}

export type SettingsValidation = {
  valid: boolean;
  errors: Record<string, string>;
};

/** Validate the persisted settings, including the selected custom endpoints. */
export function validateLocalVoiceSettings(settings: LocalVoiceSettings): SettingsValidation {
  const errors: Record<string, string> = {};
  if (settings.sttEngine === 'local' && settings.customSttEndpoint) {
    const err = validateBaseUrl(settings.customSttEndpoint.baseUrl);
    if (err) errors.customSttEndpoint = err;
    else {
      const resolved = resolveEndpoint({
        kind: 'stt',
        protocol: settings.customSttEndpoint.protocol,
        baseUrl: settings.customSttEndpoint.baseUrl,
        ignoreTls: settings.customSttEndpoint.ignoreTls || settings.ignoreTlsForCustom,
      });
      if (resolved.relaxTls && !settings.customSttEndpoint.ignoreTls) {
        errors.customSttEndpointTls = 'Self-signed https endpoint: confirm "ignore TLS warnings".';
      }
    }
  }
  if (settings.ttsEngine === 'local' && settings.customTtsEndpoint) {
    const err = validateBaseUrl(settings.customTtsEndpoint.baseUrl);
    if (err) errors.customTtsEndpoint = err;
  }
  if (settings.sttEngine === 'local' && !settings.sttModelId && !settings.customSttEndpoint) {
    errors.sttModel = 'Pick or install an STT model, or configure a custom endpoint.';
  }
  if (settings.ttsEngine === 'local' && !settings.ttsModelId && !settings.customTtsEndpoint) {
    errors.ttsModel = 'Pick or install a TTS model, or configure a custom endpoint.';
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

/** Convenience: the idle policy the lifecycle manager should use. */
export function idlePolicyFromSettings(settings: LocalVoiceSettings): { idleTimeoutMs: number } {
  return { idleTimeoutMs: Math.max(0, settings.idleTimeoutSeconds) * 1000 };
}
