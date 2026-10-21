import { describe, expect, it } from 'vitest';
import { buildDownloadPlan, modelDirName, planPercent } from '../download.js';
import { parseLocalVoiceModel } from '../catalog.js';

describe('modelDirName', () => {
  it('is filesystem-safe', () => {
    expect(modelDirName(parseLocalVoiceModel({ id: 'a/b c:d', category: 'stt', downloadUrl: 'https://x' })!)).toBe(
      'catalog_a_b_c_d',
    );
  });
});

describe('buildDownloadPlan', () => {
  const model = parseLocalVoiceModel({
    id: 'whisper',
    category: 'stt',
    files: [
      { name: 'model.bin', url: 'https://x/model.bin', sizeBytes: 1000 },
      { name: 'nested/tokens.txt', url: 'https://x/tokens.txt', sizeBytes: 100 },
    ],
  })!;

  it('plans a fresh download', () => {
    const plan = buildDownloadPlan(model);
    expect(plan.dirName).toBe('catalog_whisper');
    expect(plan.items).toHaveLength(2);
    expect(plan.items[0].destPath).toBe('catalog_whisper/model.bin');
    expect(plan.items.every((i) => i.resumeFrom === 0 && !i.complete)).toBe(true);
    expect(plan.totalBytes).toBe(1100);
    expect(plan.remainingBytes).toBe(1100);
    expect(planPercent(plan)).toBe(0);
  });

  it('resumes a partial file', () => {
    const plan = buildDownloadPlan(model, {
      existingBytes: { 'catalog_whisper/model.bin': 400 },
    });
    expect(plan.items[0].resumeFrom).toBe(400);
    expect(plan.items[0].complete).toBe(false);
    expect(plan.haveBytes).toBe(400);
    expect(plan.remainingBytes).toBe(700);
    expect(planPercent(plan)).toBe(36);
  });

  it('marks a fully-downloaded file complete and resets its offset', () => {
    const plan = buildDownloadPlan(model, {
      existingBytes: { 'catalog_whisper/model.bin': 1000, 'catalog_whisper/nested/tokens.txt': 100 },
    });
    expect(plan.items.every((i) => i.complete)).toBe(true);
    expect(plan.remainingBytes).toBe(0);
    expect(planPercent(plan)).toBe(100);
  });

  it('strips path traversal from a file name', () => {
    const evil = parseLocalVoiceModel({
      id: 'evil',
      category: 'stt',
      files: [{ name: '../../etc/passwd', url: 'https://x', sizeBytes: 1 }],
    })!;
    const plan = buildDownloadPlan(evil);
    expect(plan.items[0].destPath).toBe('catalog_evil/etc/passwd');
    expect(plan.items[0].destPath).not.toContain('..');
  });

  it('reports null percent when sizes are unknown', () => {
    const unknown = parseLocalVoiceModel({ id: 'n', category: 'stt', downloadUrl: 'https://x' })!;
    const plan = buildDownloadPlan(unknown);
    expect(plan.totalBytes).toBeNull();
    expect(planPercent(plan)).toBeNull();
  });
});
