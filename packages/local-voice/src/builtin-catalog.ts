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
import type { VoiceEngineKind } from './protocol.js';

/** HuggingFace resolve URL for a whisper.cpp GGML build. */
function whisperCpp(repo: string, file: string): string {
  return `https://huggingface.co/${repo}/resolve/main/${file}`;
}

/** Canonical HuggingFace *model card* page (attribution), not the raw bytes. */
function hfPage(repo: string): string {
  return `https://huggingface.co/${repo}`;
}

/** Canonical GitHub project page (attribution), not a release asset. */
function ghPage(repo: string): string {
  return `https://github.com/${repo}`;
}

/**
 * Raw file from a GitHub repo at a pinned tag/ref.
 *
 * NOTE: we deliberately avoid `releases/download/...` for Silero. That project
 * publishes **no release assets at all** (every GitHub release is tag-only), so
 * `releases/download/v<tag>/<file>` is a guaranteed 404. The `.onnx` weights
 * live in the source tree under `src/silero_vad/data/`, so we fetch those at the
 * pinned ref. The path is verified against the repo tree and the bytes are
 * pinned by `sha256`, so a retargeted tag cannot silently change the model.
 */
function ghRawFile(repo: string, ref: string, filePath: string): string {
  return `https://github.com/${repo}/raw/${ref}/${filePath}`;
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
    sourceUrl: hfPage('ggerganov/whisper.cpp'),
    sizeBytes: 574_041_195,
    vramGiB: 2,
    runtime: 'ggml-q5_0',
    files: [
      {
        name: 'ggml-large-v3-turbo-q5_0.bin',
        url: whisperCpp('ggerganov/whisper.cpp', 'ggml-large-v3-turbo-q5_0.bin'),
        sizeBytes: 574_041_195,
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
    sourceUrl: hfPage('ggerganov/whisper.cpp'),
    sizeBytes: 190_085_487,
    vramGiB: 1,
    runtime: 'ggml-q5_1',
    files: [
      {
        name: 'ggml-small-q5_1.bin',
        url: whisperCpp('ggerganov/whisper.cpp', 'ggml-small-q5_1.bin'),
        sizeBytes: 190_085_487,
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
    sourceUrl: hfPage('rhasspy/piper-voices'),
    sizeBytes: 63_201_294,
    vramGiB: 1,
    runtime: 'onnx',
    files: [
      {
        name: 'en_US-amy-medium.onnx',
        url: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx',
        sizeBytes: 63_201_294,
        sha256: null,
      },
      {
        name: 'en_US-amy-medium.onnx.json',
        url: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx.json',
        sizeBytes: 4_882,
        sha256: null,
      },
    ],
    licenseKeys: ['mit'],
    sha256: null,
  },
];

/**
 * Always-on detector artifacts (VAD + wake words).
 *
 * These are tiny (a few MB) ONNX models the client runs locally, in the desktop
 * app, to decide when to listen. They are never sent to the cloud: detection
 * happens on-device and only a wake event (never audio) leaves the machine.
 * Sizes and `sha256` checksums are the real values of the pinned artifacts (the
 * downloader verifies the checksum before committing).
 *
 * These fixed-phrase keyword models only fire on their trained phrase.
 * Arbitrary phrases (e.g. an agent's name) use the STT-phrase engine instead,
 * which transcribes on-device and matches text — see the wake-settings panel.
 */
function githubRelease(repo: string, tag: string, file: string): string {
  return `https://github.com/${repo}/releases/download/${tag}/${file}`;
}

/** The openWakeWord release the built-in keyword models are pinned to. */
const OPENWAKEWORD_TAG = 'v0.5.1';

/** The Silero VAD ref the VAD model is pinned to (source tree, not a release). */
const SILERO_VAD_REF = 'v5.1.2';
/** Where the `.onnx` weights live inside the silero-vad source tree. */
const SILERO_VAD_PATH = 'src/silero_vad/data/silero_vad.onnx';

export const BUILTIN_DETECTOR_MODELS: LocalVoiceModel[] = [
  {
    id: 'catalog:desktop/silero-vad',
    kind: 'vad',
    source: 'region',
    label: 'Silero VAD (voice activity)',
    modelRef: 'edge/silero-vad',
    // Silero publishes NO GitHub release assets (tag-only releases), so
    // `releases/download/...` 404s. The weights come from the pinned source tree.
    downloadUrl: ghRawFile('snakers4/silero-vad', SILERO_VAD_REF, SILERO_VAD_PATH),
    sourceUrl: ghPage('snakers4/silero-vad'),
    sizeBytes: 2_327_524,
    vramGiB: 0,
    runtime: 'onnx',
    files: [
      {
        name: 'silero_vad.onnx',
        url: ghRawFile('snakers4/silero-vad', SILERO_VAD_REF, SILERO_VAD_PATH),
        sizeBytes: 2_327_524,
        sha256: '2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f',
      },
    ],
    licenseKeys: ['mit'],
    sha256: '2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f',
  },
  {
    id: 'catalog:desktop/wake-hey-jarvis',
    kind: 'wake',
    source: 'region',
    label: 'Wake word: “Hey Jarvis”',
    modelRef: 'edge/openwakeword-hey-jarvis',
    downloadUrl: githubRelease('dscripka/openWakeWord', OPENWAKEWORD_TAG, 'hey_jarvis_v0.1.onnx'),
    sourceUrl: ghPage('dscripka/openWakeWord'),
    sizeBytes: 1_271_370,
    vramGiB: 0,
    runtime: 'onnx',
    files: [
      {
        name: 'hey_jarvis_v0.1.onnx',
        url: githubRelease('dscripka/openWakeWord', OPENWAKEWORD_TAG, 'hey_jarvis_v0.1.onnx'),
        sizeBytes: 1_271_370,
        sha256: '94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb',
      },
    ],
    licenseKeys: ['apache-2.0'],
    sha256: '94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb',
  },
  {
    id: 'catalog:desktop/wake-alexa',
    kind: 'wake',
    source: 'region',
    label: 'Wake word: “Alexa”',
    modelRef: 'edge/openwakeword-alexa',
    downloadUrl: githubRelease('dscripka/openWakeWord', OPENWAKEWORD_TAG, 'alexa_v0.1.onnx'),
    sourceUrl: ghPage('dscripka/openWakeWord'),
    sizeBytes: 854_246,
    vramGiB: 0,
    runtime: 'onnx',
    files: [
      {
        name: 'alexa_v0.1.onnx',
        url: githubRelease('dscripka/openWakeWord', OPENWAKEWORD_TAG, 'alexa_v0.1.onnx'),
        sizeBytes: 854_246,
        sha256: '6ff566a01d12670e8d9e3c59da32651db1575d17272a601b7f8a39283dfbae3e',
      },
    ],
    licenseKeys: ['apache-2.0'],
    sha256: '6ff566a01d12670e8d9e3c59da32651db1575d17272a601b7f8a39283dfbae3e',
  },
  {
    id: 'catalog:desktop/wake-hey-mycroft',
    kind: 'wake',
    source: 'region',
    label: 'Wake word: “Hey Mycroft”',
    modelRef: 'edge/openwakeword-hey-mycroft',
    downloadUrl: githubRelease('dscripka/openWakeWord', OPENWAKEWORD_TAG, 'hey_mycroft_v0.1.onnx'),
    sourceUrl: ghPage('dscripka/openWakeWord'),
    sizeBytes: 857_691,
    vramGiB: 0,
    runtime: 'onnx',
    files: [
      {
        name: 'hey_mycroft_v0.1.onnx',
        url: githubRelease('dscripka/openWakeWord', OPENWAKEWORD_TAG, 'hey_mycroft_v0.1.onnx'),
        sizeBytes: 857_691,
        sha256: 'c2a311e8fa1338de89c31b3b46dc4dffd4af2f9a8d6ddead48893c2d301b1f18',
      },
    ],
    licenseKeys: ['apache-2.0'],
    sha256: 'c2a311e8fa1338de89c31b3b46dc4dffd4af2f9a8d6ddead48893c2d301b1f18',
  },
  {
    id: 'catalog:desktop/wake-hey-rhasspy',
    kind: 'wake',
    source: 'region',
    label: 'Wake word: “Hey Rhasspy”',
    modelRef: 'edge/openwakeword-hey-rhasspy',
    downloadUrl: githubRelease('dscripka/openWakeWord', OPENWAKEWORD_TAG, 'hey_rhasspy_v0.1.onnx'),
    sourceUrl: ghPage('dscripka/openWakeWord'),
    sizeBytes: 204_081,
    vramGiB: 0,
    runtime: 'onnx',
    files: [
      {
        name: 'hey_rhasspy_v0.1.onnx',
        url: githubRelease('dscripka/openWakeWord', OPENWAKEWORD_TAG, 'hey_rhasspy_v0.1.onnx'),
        sizeBytes: 204_081,
        sha256: '5a9b3ed3be2910e35780e097905aa9f35a9c10038df47914cf2b3ec4d670f6ea',
      },
    ],
    licenseKeys: ['apache-2.0'],
    sha256: '5a9b3ed3be2910e35780e097905aa9f35a9c10038df47914cf2b3ec4d670f6ea',
  },
];

/** Display order for catalog kinds: speech first, then the on-device detectors. */
const KIND_ORDER: VoiceEngineKind[] = ['stt', 'tts', 'vad', 'wake'];

/**
 * True when a model is a fixed-phrase keyword detector: it can only ever fire on
 * the phrase it was trained for, so its label — not any user-chosen phrase —
 * decides what it listens for. Everything else installed locally (an STT model)
 * is driven by the STT-phrase wake engine, which matches arbitrary text.
 */
export function isFixedPhraseWakeModel(model: LocalVoiceModel): boolean {
  return model.kind === 'wake';
}

/**
 * The phrase a fixed keyword model listens for, parsed from its label
 * (`Wake word: “Hey Jarvis”` -> `hey jarvis`). Null when none can be derived.
 */
export function wakeModelPhrase(model: LocalVoiceModel): string | null {
  if (!isFixedPhraseWakeModel(model)) return null;
  const quoted = model.label.match(/[“"']([^”"']+)[”"']/);
  const phrase = (quoted?.[1] ?? model.label).trim().toLowerCase().replace(/\s+/g, ' ');
  return phrase || null;
}

/**
 * Merge the region catalog over the built-in fallback. Region rows win by id so
 * the platform can retarget a download URL without shipping a new desktop build.
 */
export function mergeVoiceCatalog(
  region: LocalVoiceModel[],
  builtin: LocalVoiceModel[] = [...BUILTIN_VOICE_MODELS, ...BUILTIN_DETECTOR_MODELS],
): LocalVoiceModel[] {
  const byId = new Map<string, LocalVoiceModel>();
  for (const m of builtin) byId.set(m.id, m);
  for (const m of region) byId.set(m.id, m);
  const merged = [...byId.values()];
  // Stable, readable ordering: grouped by kind, then by label.
  merged.sort((a, b) => {
    const ka = KIND_ORDER.indexOf(a.kind);
    const kb = KIND_ORDER.indexOf(b.kind);
    if (ka !== kb) return ka - kb;
    return a.label.localeCompare(b.label);
  });
  return merged;
}
