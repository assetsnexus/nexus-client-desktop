import { describe, expect, it } from 'vitest';
import { BUILTIN_VOICE_MODELS, mergeVoiceCatalog } from '../builtin-catalog.js';
import { parseLocalVoiceModel } from '../catalog.js';

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

describe('mergeVoiceCatalog', () => {
  it('returns the builtins when the region catalog is empty', () => {
    expect(mergeVoiceCatalog([])).toHaveLength(BUILTIN_VOICE_MODELS.length);
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
    expect(merged.length).toBe(BUILTIN_VOICE_MODELS.length + 1);
  });

  it('sorts STT models before TTS models', () => {
    const merged = mergeVoiceCatalog([]);
    const kinds = merged.map((m) => m.kind);
    const firstTts = kinds.indexOf('tts');
    const lastStt = kinds.lastIndexOf('stt');
    expect(lastStt).toBeLessThan(firstTts);
  });
});
