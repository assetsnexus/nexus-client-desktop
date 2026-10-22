/**
 * Wake-word engine host for the desktop main process.
 *
 * `@nexus/wake-word` owns the detector logic and the microphone path; this module
 * is the thin host that:
 *  - reads the *installed* wake-model bytes off disk (they were downloaded by the
 *    local-voice manager) and hands them to the engine,
 *  - enforces the trust invariant that a wake only ever routes to the mapped
 *    agent (never authenticates),
 *  - exposes a small, serializable status the renderer can visualize.
 *
 * The audio path is Web Audio, which only exists in the renderer, so the engine
 * itself is constructed *there* (see `wake-engine-bootstrap` in chat-react). This
 * module provides the two things the renderer cannot do: resolve model bytes from
 * disk and persist the mapping.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LocalVoiceModel } from '@nexus/local-voice';
import { modelDirName } from '@nexus/local-voice';
import {
  bindingEngineKind,
  bindingIsArmed,
  bindingUnavailableReason,
  normalizeWakeBinding,
  normalizeWakeSettings,
  type WakeEngineKind,
  type WakeSettings,
  type WakeWordBinding,
} from '../shared/wake.js';
import type { WakeTemplateFingerprintWire } from '../shared/ipc.js';

/**
 * The detector kind for a binding, given the catalog model it points at:
 * a sample always means `custom_sample`; an STT model means `stt_phrase`
 * (arbitrary phrase matched against on-device transcription); anything else
 * (a fixed-phrase keyword model) means `builtin`.
 */
export function resolveEngineKind(
  binding: WakeWordBinding,
  modelKind: 'stt' | 'tts' | 'vad' | 'wake' | null,
): WakeEngineKind {
  const base = bindingEngineKind(binding);
  if (base === 'custom_sample') return 'custom_sample';
  if (binding.modelId && modelKind === 'stt') return 'stt_phrase';
  return 'builtin';
}

/**
 * Decode a device-local custom-sample fingerprint. The fingerprint is stored as
 * base64-encoded little-endian float32 samples (see the renderer enrolment
 * path); decoding it here keeps the renderer from re-parsing untrusted bytes.
 * Returns null for anything malformed rather than throwing.
 */
export function decodeSampleFingerprint(
  encoded: string | null,
  meta?: { sampleRate?: number; hopSamples?: number },
): WakeTemplateFingerprintWire | null {
  if (!encoded) return null;
  let buffer: Buffer;
  try {
    buffer = Buffer.from(encoded, 'base64');
  } catch {
    return null;
  }
  if (buffer.byteLength < 4 || buffer.byteLength % 4 !== 0) return null;
  const frames = buffer.byteLength / 4;
  const envelope = new Array<number>(frames);
  for (let i = 0; i < frames; i++) envelope[i] = buffer.readFloatLE(i * 4);
  return {
    envelope,
    frames,
    sampleRate: meta?.sampleRate ?? 16000,
    hopSamples: meta?.hopSamples ?? 512,
  };
}

export type WakeModelArtifact = {
  /** Model id this artifact belongs to. */
  modelId: string;
  /** Relative file name inside the model directory. */
  fileName: string;
  /** Raw model bytes (ONNX). Empty when the file is missing/unreadable. */
  bytes: Uint8Array;
  /** Absolute path, for diagnostics only (never logged with audio). */
  path: string;
};

export type WakeHostDeps = {
  /** Absolute directory the local-voice manager installs models into. */
  modelsDir: string;
  /** Look up a catalog model by id (to resolve its file list). */
  findModel: (modelId: string) => LocalVoiceModel | null;
  readSettings: () => WakeSettings;
  /** Optional: the manager owns canonical persistence; the host may delegate. */
  writeSettings?: (next: WakeSettings) => void;
};

/** The primary `.onnx` file of a model (the detector artifact). */
export function primaryModelFile(model: LocalVoiceModel): string | null {
  const onnx = model.files.find((f) => f.name.toLowerCase().endsWith('.onnx'));
  return onnx?.name ?? model.files[0]?.name ?? null;
}

export function createWakeHost(deps: WakeHostDeps) {
  /**
   * Read the installed detector bytes for a binding. Returns null when the model
   * is not installed yet, so the caller reports "install the model" instead of a
   * confusing load error. Never used for an STT-phrase binding, whose model is a
   * speech model (transcribed via `wake-stt.ts`), not an ONNX keyword artifact.
   */
  function readArtifact(binding: WakeWordBinding): WakeModelArtifact | null {
    if (!binding.modelId) return null;
    const model = deps.findModel(binding.modelId);
    if (!model) return null;
    const fileName = primaryModelFile(model);
    if (!fileName) return null;
    const path = join(deps.modelsDir, modelDirName(model), fileName);
    if (!existsSync(path)) return null;
    try {
      return { modelId: model.id, fileName, bytes: readFileSync(path), path };
    } catch {
      return null;
    }
  }

  return {
    getSettings(): WakeSettings {
      return deps.readSettings();
    },
    setSettings(next: unknown): WakeSettings {
      const normalized = normalizeWakeSettings(next);
      deps.writeSettings?.(normalized);
      return normalized;
    },
    readArtifact,
    /**
     * Resolve everything the renderer needs to arm one binding: the engine kind,
     * the phrase, and (for builtin) the model bytes. Never returns auth material.
     *
     * Accepts a binding id (a persisted, manual binding) or a full binding object
     * (an auto-mapped one that only exists in the renderer). A passed object is
     * normalized here, so main never trusts renderer-supplied fields — but the
     * persisted record wins when the id is known, so a stale copy cannot change
     * what actually gets armed.
     */
    resolveBinding(bindingOrId: WakeWordBinding | string): {
      binding: WakeWordBinding;
      engineKind: WakeEngineKind;
      artifact: WakeModelArtifact | null;
      customSampleFingerprint: WakeTemplateFingerprintWire | null;
      armed: boolean;
    } | null {
      const passed = typeof bindingOrId === 'string' ? null : normalizeWakeBinding(bindingOrId);
      const id = typeof bindingOrId === 'string' ? bindingOrId : passed?.id ?? '';
      if (!id) return null;
      const binding =
        deps.readSettings().bindings.find((b) => b.id === id) ?? passed ?? null;
      if (!binding) return null;
      const model = binding.modelId ? deps.findModel(binding.modelId) : null;
      const engineKind = resolveEngineKind(binding, model?.kind ?? null);
      return {
        binding,
        engineKind,
        artifact: engineKind === 'builtin' ? readArtifact(binding) : null,
        customSampleFingerprint:
          engineKind === 'custom_sample'
            ? decodeSampleFingerprint(binding.sampleFingerprint)
            : null,
        armed: bindingIsArmed(binding, engineKind),
      };
    },
    /** The engine kind + unavailability reason for a binding, without artifacts. */
    describeBinding(bindingId: string): { engineKind: WakeEngineKind; reason: string | null } | null {
      const binding = deps.readSettings().bindings.find((b) => b.id === bindingId);
      if (!binding) return null;
      const model = binding.modelId ? deps.findModel(binding.modelId) : null;
      const engineKind = resolveEngineKind(binding, model?.kind ?? null);
      return { engineKind, reason: bindingUnavailableReason(binding, engineKind) };
    },
  };
}

export type WakeHost = ReturnType<typeof createWakeHost>;
