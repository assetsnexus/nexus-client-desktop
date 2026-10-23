import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUDIO_SETTINGS,
  hasAgentOutputTargets,
  normalizeAudioSettings,
  resolveOutputTargets,
} from './audio.js';

describe('normalizeAudioSettings', () => {
  it('returns defaults for missing/invalid input', () => {
    expect(normalizeAudioSettings(undefined)).toEqual(DEFAULT_AUDIO_SETTINGS);
    expect(normalizeAudioSettings(null)).toEqual(DEFAULT_AUDIO_SETTINGS);
    expect(normalizeAudioSettings('nope')).toEqual(DEFAULT_AUDIO_SETTINGS);
  });

  it('keeps device ids and de-duplicates lists', () => {
    const out = normalizeAudioSettings({
      output: { primaryOutputId: ' spk-1 ', allowedOutputIds: ['spk-2', 'spk-2', ''] },
      input: { primaryInputId: 'mic-1', wakeInputIds: ['mic-2', 'mic-2', 'mic-3'] },
    });
    expect(out.output.primaryOutputId).toBe('spk-1');
    expect(out.output.allowedOutputIds).toEqual(['spk-2']);
    expect(out.input.primaryInputId).toBe('mic-1');
    expect(out.input.wakeInputIds).toEqual(['mic-2', 'mic-3']);
  });

  it('never allows the primary speaker to also be an allowed secondary', () => {
    const out = normalizeAudioSettings({
      output: { primaryOutputId: 'spk-1', allowedOutputIds: ['spk-1', 'spk-2'] },
    });
    expect(out.output.allowedOutputIds).toEqual(['spk-2']);
  });

  it('treats blank ids as the OS default (null)', () => {
    const out = normalizeAudioSettings({ output: { primaryOutputId: '   ' } });
    expect(out.output.primaryOutputId).toBeNull();
  });
});

describe('resolveOutputTargets', () => {
  const settings = normalizeAudioSettings({
    output: { primaryOutputId: 'spk-primary', allowedOutputIds: ['spk-kitchen', 'spk-office'] },
  });

  it('resolves primary to just the primary speaker', () => {
    expect(resolveOutputTargets(settings, 'primary')).toEqual(['spk-primary']);
  });

  it('resolves all to primary plus every allowed speaker', () => {
    expect(resolveOutputTargets(settings, 'all')).toEqual([
      'spk-primary',
      'spk-kitchen',
      'spk-office',
    ]);
  });

  it('allows a specific permitted speaker', () => {
    expect(resolveOutputTargets(settings, 'spk-kitchen')).toEqual(['spk-kitchen']);
  });

  it('refuses a speaker the user did not allow', () => {
    expect(resolveOutputTargets(settings, 'spk-neighbour')).toEqual([]);
  });

  it('returns an empty list for primary when only the OS default is configured', () => {
    const bare = normalizeAudioSettings({});
    expect(resolveOutputTargets(bare, 'primary')).toEqual([]);
  });
});

describe('hasAgentOutputTargets', () => {
  it('is false with no configuration', () => {
    expect(hasAgentOutputTargets(normalizeAudioSettings({}))).toBe(false);
  });

  it('is true once a primary or allowed speaker exists', () => {
    expect(hasAgentOutputTargets(normalizeAudioSettings({ output: { primaryOutputId: 's' } }))).toBe(true);
    expect(
      hasAgentOutputTargets(normalizeAudioSettings({ output: { allowedOutputIds: ['s2'] } })),
    ).toBe(true);
  });
});
