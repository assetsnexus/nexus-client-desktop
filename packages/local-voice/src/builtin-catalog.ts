/**
 * Built-in speech-model catalog (@nexus/local-voice).
 *
 * The region catalog is the source of truth for *what* is installable, but the
 * desktop must still work offline (a lab machine with no region reachability, a
 * user who has not signed in yet). These rows are the well-known, self-hostable
 * artifacts we can always offer: whisper.cpp GGML builds for STT and a Piper
 * voice for TTS. They are merged **under** the region catalog (the region wins
 * on id), so admins can add or retarget models without a new client build.
 */

import type { LocalVoiceModel } from './catalog.js';

/** HuggingFace resolve URL for a whisper.cpp GGML build. */
function whisperCpp(repo: string, file: string): string {
  return `https://huggingface.co/${repo}/resolve/main/${file}`;
}

export const BUILTIN_VOICE_MODELS: LocalVoiceModel[] = [
  {
    id: 'catalog:desktop/whisper-large-v3-turbo-q5',
    kind: 'stt',
    source: 'region',
    label: 'Whisper Large v3 Turbo (q5_0)',
    modelRef: 'edge/whisper-large-v3-turbo',
    downloadUrl: whisperCpp(
      'ggerganov/whisper.cpp',
      'ggml-large-v3-turbo-q5_0.bin',
    ),
    sizeBytes: 574_000_000,
    vramGiB: 2,
    runtime: 'ggml-q5_0',
    files: [
      {
        name: 'ggml-large-v3-turbo-q5_0.bin',
        url: whisperCpp('ggerganov/whisper.cpp', 'ggml-large-v3-turbo-q5_0.bin'),
        sizeBytes: 574_000_000,
        sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
      },
    ],
    licenseKeys: ['mit'],
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
  },
  {
    id: 'catalog:desktop/whisper-small-q5',
    kind: 'stt',
    source: 'region',
    label: 'Whisper Small (q5_1)',
    modelRef: 'edge/whisper-small',
    downloadUrl: whisperCpp('ggerganov/whisper.cpp', 'ggml-small-q5_1.bin'),
    sizeBytes: 181_000_000,
    vramGiB: 1,
    runtime: 'ggml-q5_1',
    files: [
      {
        name: 'ggml-small-q5_1.bin',
        url: whisperCpp('ggerganov/whisper.cpp', 'ggml-small-q5_1.bin'),
        sizeBytes: 181_000_000,
        sha256: null,
      },
    ],
    licenseKeys: ['mit'],
    sha256: null,
  },
  {
    id: 'catalog:desktop/piper-en-us-amy',
    kind: 'tts',
    source: 'region',
    label: 'Piper en_US Amy (medium)',
    modelRef: 'edge/piper-en-us-amy',
    downloadUrl:
      'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx',
    sizeBytes: 63_000_000,
    vramGiB: 1,
    runtime: 'onnx',
    files: [
      {
        name: 'en_US-amy-medium.onnx',
        url: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx',
        sizeBytes: 63_000_000,
        sha256: null,
      },
      {
        name: 'en_US-amy-medium.onnx.json',
        url: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx.json',
        sizeBytes: 5_000,
        sha256: null,
      },
    ],
    licenseKeys: ['mit'],
    sha256: null,
  },
];

/**
 * Merge the region catalog over the built-in fallback. Region rows win by id so
 * the platform can retarget a download URL without shipping a new desktop build.
 */
export function mergeVoiceCatalog(
  region: LocalVoiceModel[],
  builtin: LocalVoiceModel[] = BUILTIN_VOICE_MODELS,
): LocalVoiceModel[] {
  const byId = new Map<string, LocalVoiceModel>();
  for (const m of builtin) byId.set(m.id, m);
  for (const m of region) byId.set(m.id, m);
  const merged = [...byId.values()];
  // Stable, readable ordering: STT first, then TTS, then by label.
  merged.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'stt' ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  return merged;
}
