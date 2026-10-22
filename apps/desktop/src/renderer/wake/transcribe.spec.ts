import { describe, expect, it, vi } from 'vitest';
import { rankSttModels, transcribeUtterance } from './transcribe.js';

describe('rankSttModels', () => {
  it('keeps only speech-capable models and prefers whisper', () => {
    const ranked = rankSttModels([
      { id: 'gpt-4o', capabilities: ['chat'] },
      { id: 'generic-stt', capabilities: ['audio_input'] },
      { id: 'openai/whisper-large', capabilities: ['audio_input'] },
    ]);
    expect(ranked[0]).toBe('openai/whisper-large');
    expect(ranked).toContain('generic-stt');
    expect(ranked).not.toContain('gpt-4o');
  });

  it('accepts stt and audio capability labels', () => {
    expect(rankSttModels([{ id: 'a', capabilities: ['stt'] }])).toEqual(['a']);
    expect(rankSttModels([{ id: 'b', capabilities: ['audio'] }])).toEqual(['b']);
  });

  it('returns an empty list when nothing is entitled', () => {
    expect(rankSttModels([])).toEqual([]);
    expect(rankSttModels([{ id: 'x', capabilities: ['chat'] }])).toEqual([]);
  });
});

describe('transcribeUtterance', () => {
  it('returns null when no STT model is entitled', async () => {
    const listModels = vi.fn(async () => ({ models: [{ id: 'chat', capabilities: ['chat'] }] }));
    const out = await transcribeUtterance({ client: {}, listModels }, new Blob([new Uint8Array(4)]));
    expect(out).toBeNull();
  });
});
