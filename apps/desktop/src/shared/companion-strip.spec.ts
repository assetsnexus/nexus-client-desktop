/**
 * Companion dictation-strip gate spec.
 *
 * The wake → companion strip contract: a dictation wake on the elected primary
 * shows the strip; a demoted window, a voice-mode presentation, and a live call
 * all hide it (so no two surfaces ever compete for the microphone).
 */

import { describe, expect, it } from 'vitest';
import { showsDictationStrip } from './companion-strip.js';

describe('showsDictationStrip', () => {
  it('shows the strip when the wake asked for dictation and this window is primary', () => {
    expect(
      showsDictationStrip({ dictate: true, sttPrimary: true, voiceActive: false }),
    ).toBe(true);
  });

  it('hides it when the wake did not ask for dictation (voice-mode presentation)', () => {
    expect(
      showsDictationStrip({ dictate: false, sttPrimary: true, voiceActive: false }),
    ).toBe(false);
  });

  it('hides it when another companion owns the microphone', () => {
    expect(
      showsDictationStrip({ dictate: true, sttPrimary: false, voiceActive: false }),
    ).toBe(false);
  });

  it('hides it while a realtime call owns the capture', () => {
    expect(
      showsDictationStrip({ dictate: true, sttPrimary: true, voiceActive: true }),
    ).toBe(false);
  });
});
