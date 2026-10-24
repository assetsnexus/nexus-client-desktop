import { describe, expect, it } from 'vitest';
import { isLargeWakeModel } from '../../shared/wake.js';

/**
 * Wake gating only spots a short phrase, so a large model makes on-device
 * recognition lag speech (a 574 MB turbo build took ~30s per utterance on a CPU
 * box). The UI uses this predicate to point the user at a small model instead of
 * leaving "it's slow" unexplained.
 */
describe('isLargeWakeModel', () => {
  it('flags the heavy Whisper builds', () => {
    expect(isLargeWakeModel('Whisper Large v3 Turbo (q5_0)')).toBe(true);
    expect(isLargeWakeModel('Whisper Medium')).toBe(true);
  });

  it('does not flag the fast wake models', () => {
    expect(isLargeWakeModel('Whisper Tiny (q5_1) — fastest')).toBe(false);
    expect(isLargeWakeModel('Whisper Base (q5_1) — fast')).toBe(false);
    expect(isLargeWakeModel('Whisper Small (q5_1)')).toBe(false);
  });

  it('treats a missing label as not-large (no false warning)', () => {
    expect(isLargeWakeModel(null)).toBe(false);
    expect(isLargeWakeModel(undefined)).toBe(false);
    expect(isLargeWakeModel('')).toBe(false);
  });
});
