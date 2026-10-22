import { describe, expect, it } from 'vitest';
import {
  BUILTIN_DETECTOR_MODELS,
  BUILTIN_VOICE_MODELS,
  isFixedPhraseWakeModel,
  mergeVoiceCatalog,
  wakeModelPhrase,
} from '../builtin-catalog.js';
import { parseLocalVoiceModel } from '../catalog.js';

const ALL_BUILTINS = [...BUILTIN_VOICE_MODELS, ...BUILTIN_DETECTOR_MODELS];

describe('BUILTIN_VOICE_MODELS', () => {
  it('ships both an STT and a TTS default with a real download URL', () => {
    expect(BUILTIN_VOICE_MODELS.some((m) => m.kind === 'stt')).toBe(true);
    expect(BUILTIN_VOICE_MODELS.some((m) => m.kind === 'tts')).toBe(true);
    expect(BUILTIN_VOICE_MODELS.every((m) => m.downloadUrl?.startsWith('https://'))).toBe(true);
    expect(BUILTIN_VOICE_MODELS.every((m) => m.files.length > 0)).toBe(true);
  });

  it('uses https + a public repository for every artifact', () => {
    for (const m of BUILTIN_VOICE_MODELS) {
      for (const f of m.files) {
        expect(f.url).toMatch(/^https:\/\/(huggingface\.co|github\.com)\//);
      }
    }
  });
});

describe('BUILTIN_DETECTOR_MODELS', () => {
  it('ships a VAD and at least one wake-word model', () => {
    expect(BUILTIN_DETECTOR_MODELS.some((m) => m.kind === 'vad')).toBe(true);
    expect(BUILTIN_DETECTOR_MODELS.some((m) => m.kind === 'wake')).toBe(true);
  });

  it('ships several usable fixed-phrase wake models', () => {
    const wakes = BUILTIN_DETECTOR_MODELS.filter((m) => m.kind === 'wake');
    expect(wakes.length).toBeGreaterThanOrEqual(4);
    for (const m of wakes) expect(wakeModelPhrase(m)).toBeTruthy();
  });

  it('is tiny and on-device only (https public release assets)', () => {
    for (const m of BUILTIN_DETECTOR_MODELS) {
      expect(m.vramGiB).toBe(0);
      expect(m.files.length).toBeGreaterThan(0);
      for (const f of m.files) {
        expect(f.url).toMatch(/^https:\/\/(github\.com|huggingface\.co)\//);
      }
    }
  });
});

describe('builtin artifact URLs', () => {
  it('never points a GitHub *release* URL at a repo that publishes no assets', () => {
    // Regression: Silero VAD ships tag-only releases with NO release assets, so
    // `releases/download/<tag>/silero_vad.onnx` was a guaranteed HTTP 404 and the
    // VAD row could never install. Its weights live in the source tree instead.
    const offenders = ALL_BUILTINS.flatMap((m) => m.files)
      .map((f) => f.url)
      .filter((u) => /^https:\/\/github\.com\/snakers4\/silero-vad\/releases\/download\//.test(u));
    expect(offenders).toEqual([]);
  });

  it('fetches Silero VAD from the pinned source tree and links its project page', () => {
    const vad = BUILTIN_DETECTOR_MODELS.find((m) => m.id === 'catalog:desktop/silero-vad')!;
    expect(vad.files[0]!.url).toBe(
      'https://github.com/snakers4/silero-vad/raw/v5.1.2/src/silero_vad/data/silero_vad.onnx',
    );
    expect(vad.sourceUrl).toBe('https://github.com/snakers4/silero-vad');
    expect(vad.licenseKeys).toEqual(['mit']);
  });

  it('links every artifact to its GitHub repo or HuggingFace model page', () => {
    // Every row must be attributable: a raw-bytes URL alone is not enough.
    for (const m of ALL_BUILTINS) {
      expect(m.sourceUrl, `${m.id} has no source page`).toMatch(
        /^https:\/\/(github\.com|huggingface\.co)\/[^/]+\/[^/]+/,
      );
      // The source page is a *page*, never the raw download endpoint.
      expect(m.sourceUrl).not.toMatch(/\/(resolve|raw)\//);
    }
  });

  it('pins every detector artifact with a real size and sha256', () => {
    // The downloader refuses to commit a checksum mismatch, so a wrong or absent
    // digest is a silent install failure. Detectors are small: pin them all.
    for (const m of BUILTIN_DETECTOR_MODELS) {
      for (const f of m.files) {
        expect(f.sizeBytes, `${f.name} size`).toBeGreaterThan(0);
        expect(f.sha256, `${f.name} sha256`).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.sizeBytes).toBeGreaterThan(0);
    }
  });

  it('keeps each model\'s declared size consistent with its files', () => {
    for (const m of ALL_BUILTINS) {
      const summed = m.files.reduce((n, f) => n + (f.sizeBytes ?? 0), 0);
      if (m.files.length === 1) expect(m.sizeBytes).toBe(summed);
      else expect(m.sizeBytes).toBeGreaterThanOrEqual(Math.max(...m.files.map((f) => f.sizeBytes ?? 0)));
    }
  });

  it('does not fabricate a size for an artifact it cannot measure', () => {
    // Guard rail: a null size is honest; a 0 or negative one is not.
    for (const m of ALL_BUILTINS) {
      for (const f of m.files) {
        expect(f.sizeBytes === null || f.sizeBytes > 0).toBe(true);
      }
    }
  });
});

describe('wakeModelPhrase', () => {  it('extracts the quoted phrase a keyword model listens for', () => {
    const jarvis = BUILTIN_DETECTOR_MODELS.find((m) => m.id.includes('hey-jarvis'))!;
    expect(wakeModelPhrase(jarvis)).toBe('hey jarvis');
  });

  it('returns null for a non-wake model', () => {
    const stt = BUILTIN_VOICE_MODELS.find((m) => m.kind === 'stt')!;
    expect(wakeModelPhrase(stt)).toBeNull();
    expect(isFixedPhraseWakeModel(stt)).toBe(false);
  });
});

describe('mergeVoiceCatalog', () => {
  it('returns the builtins when the region catalog is empty', () => {
    expect(mergeVoiceCatalog([])).toHaveLength(ALL_BUILTINS.length);
  });

  it('lets a region row override a builtin by id', () => {
    const regionRow = parseLocalVoiceModel({
      id: 'desktop/whisper-small-q5',
      category: 'stt',
      downloadUrl: 'https://region.example/whisper-small',
      displayName: 'Whisper Small (region build)',
    })!;
    const merged = mergeVoiceCatalog([regionRow]);
    const row = merged.find((m) => m.id === 'catalog:desktop/whisper-small-q5')!;
    expect(row.downloadUrl).toBe('https://region.example/whisper-small');
    expect(row.label).toBe('Whisper Small (region build)');
  });

  it('adds a brand-new region model alongside the builtins', () => {
    const regionRow = parseLocalVoiceModel({
      id: 'region-only',
      category: 'tts',
      downloadUrl: 'https://region.example/tts',
    })!;
    const merged = mergeVoiceCatalog([regionRow]);
    expect(merged.some((m) => m.id === 'catalog:region-only')).toBe(true);
    expect(merged.length).toBe(ALL_BUILTINS.length + 1);
  });

  it('groups the catalog by kind: speech first, detectors last', () => {
    const merged = mergeVoiceCatalog([]);
    const kinds = merged.map((m) => m.kind);
    expect(kinds.lastIndexOf('stt')).toBeLessThan(kinds.indexOf('tts'));
    expect(kinds.lastIndexOf('tts')).toBeLessThan(kinds.indexOf('vad'));
    expect(kinds.lastIndexOf('vad')).toBeLessThan(kinds.indexOf('wake'));
  });

  it('accepts a region wake model and classifies it', () => {
    const regionRow = parseLocalVoiceModel({
      id: 'region-wake',
      category: 'wake_word',
      downloadUrl: 'https://region.example/wake.onnx',
    })!;
    expect(regionRow.kind).toBe('wake');
  });
});
