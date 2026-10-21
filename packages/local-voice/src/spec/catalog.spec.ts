import { describe, expect, it } from 'vitest';
import {
  classifyVoiceKind,
  modelDownloadBytes,
  fitsOnDisk,
  parseLocalVoiceCatalog,
  parseLocalVoiceModel,
} from '../catalog.js';

describe('classifyVoiceKind', () => {
  it('reads the explicit category', () => {
    expect(classifyVoiceKind({ category: 'tts' })).toBe('tts');
    expect(classifyVoiceKind({ category: 'stt' })).toBe('stt');
    expect(classifyVoiceKind({ category: 'text_to_speech' })).toBe('tts');
    expect(classifyVoiceKind({ category: 'speech_to_text' })).toBe('stt');
  });

  it('falls back to capabilities', () => {
    expect(classifyVoiceKind({ capabilities: ['transcribe'] })).toBe('stt');
    expect(classifyVoiceKind({ capabilities: ['tts'] })).toBe('tts');
    expect(classifyVoiceKind({ capabilities: ['tts', 'stt'] })).toBeNull();
  });

  it('falls back to transport modality', () => {
    expect(classifyVoiceKind({ modalityTransport: 'stt.audio' })).toBe('stt');
    expect(classifyVoiceKind({ modalityTransport: 'tts.speech' })).toBe('tts');
  });

  it('returns null for non-audio rows', () => {
    expect(classifyVoiceKind({ category: 'text' })).toBeNull();
    expect(classifyVoiceKind({})).toBeNull();
  });
});

describe('parseLocalVoiceModel', () => {
  it('normalizes a HuggingFace download row', () => {
    const model = parseLocalVoiceModel({
      id: 'whisper-large-v3-turbo',
      category: 'stt',
      displayName: 'Whisper Large v3 Turbo',
      downloadUrl: 'https://huggingface.co/edge/whisper-large-v3-turbo/resolve/main/model.bin',
      sizeBytes: 1_600_000_000,
      vramGiB: 3.2,
      runtime: 'ct2',
      licenseKeys: ['mit'],
    });
    expect(model).not.toBeNull();
    expect(model!.id).toBe('catalog:whisper-large-v3-turbo');
    expect(model!.kind).toBe('stt');
    expect(model!.source).toBe('region');
    expect(model!.downloadUrl).toContain('huggingface.co');
    expect(model!.files).toHaveLength(1);
    expect(model!.vramGiB).toBe(3.2);
  });

  it('expands an explicit file list with per-file sizes', () => {
    const model = parseLocalVoiceModel({
      id: 'piper-en',
      category: 'tts',
      files: [
        { name: 'en_US.onnx', url: 'https://example.com/en.onnx', sizeBytes: 60_000_000 },
        { name: 'tokens.txt', url: 'https://example.com/tokens.txt', sizeBytes: 1000 },
      ],
    })!;
    expect(model.files).toHaveLength(2);
    expect(modelDownloadBytes(model)).toBe(60_001_000);
  });

  it('treats a legacy string file list as relative to the download URL', () => {
    const model = parseLocalVoiceModel({
      id: 'x',
      category: 'stt',
      downloadUrl: 'https://example.com/x/',
      files: ['ggml-model.bin', 'config.json'],
    })!;
    expect(model.files.map((f) => f.name)).toEqual(['ggml-model.bin', 'config.json']);
    expect(model.files.every((f) => f.url === 'https://example.com/x/')).toBe(true);
  });

  it('returns null for a row with no id, no download URL, or no audio kind', () => {
    expect(parseLocalVoiceModel(null)).toBeNull();
    expect(parseLocalVoiceModel({ category: 'stt' })).toBeNull();
    expect(parseLocalVoiceModel({ id: 'n', category: 'vision', downloadUrl: 'https://x' })).toBeNull();
  });

  it('does not throw on a malformed row', () => {
    const model = parseLocalVoiceModel({ id: 'weird', category: 'stt', downloadUrl: 'https://x', files: [1, 2] });
    expect(model).not.toBeNull();
    expect(model!.files).toHaveLength(1); // synthesized from the top-level URL
  });
});

describe('parseLocalVoiceCatalog', () => {
  it('dedupes and drops rows without a downloadable artifact', () => {
    const models = parseLocalVoiceCatalog([
      { id: 'a', category: 'stt', downloadUrl: 'https://x/a' },
      { id: 'a', category: 'stt', downloadUrl: 'https://x/a-dup' },
      { id: 'b', category: 'tts' }, // no URL -> dropped
      { id: 'c', category: 'text' },
    ]);
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('catalog:a');
  });

  it('tolerates a non-array input', () => {
    expect(parseLocalVoiceCatalog(null)).toEqual([]);
    expect(parseLocalVoiceCatalog(undefined)).toEqual([]);
  });
});

describe('disk fit', () => {
  it('requires headroom above the raw download size', () => {
    const model = parseLocalVoiceModel({
      id: 'big',
      category: 'stt',
      downloadUrl: 'https://x/big',
      sizeBytes: 1000,
    })!;
    expect(fitsOnDisk(model, 1200)).toBe(true);
    expect(fitsOnDisk(model, 1050)).toBe(false);
  });

  it('is permissive when sizes are unknown', () => {
    const model = parseLocalVoiceModel({ id: 'n', category: 'stt', downloadUrl: 'https://x' })!;
    expect(fitsOnDisk(model, 1)).toBe(true);
    expect(fitsOnDisk(model, null)).toBe(true);
  });
});
