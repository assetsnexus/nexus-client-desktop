/**
 * Privacy classifier — pure mapping from the desktop's configuration to a
 * per-stage "where does this run" verdict, plus the catalog hosting breakdown.
 */
import { describe, expect, it } from 'vitest';
import {
  HOSTING_CLASSES,
  classifyHosting,
  classifyPipeline,
  countHostingClasses,
  isHostingClass,
} from './privacy.js';

describe('classifyHosting', () => {
  it('returns null when no hosting class is advertised', () => {
    expect(classifyHosting([])).toBeNull();
  });

  it('prefers the most private class a model can run on', () => {
    expect(classifyHosting(['public_cloud', 'edge_processing'])).toBe('onDevice');
    expect(classifyHosting(['public_cloud', 'private_cloud'])).toBe('region');
    expect(classifyHosting(['public_cloud', 'managed_cloud'])).toBe('region');
    expect(classifyHosting(['public_cloud'])).toBe('publicCloud');
  });

  it('reports unknown for an unrecognised class', () => {
    expect(classifyHosting(['frobnicate_cloud'])).toBe('unknown');
  });
});

describe('classifyPipeline', () => {
  it('reports every stage unset when nothing is configured', () => {
    const stages = classifyPipeline({ chatModelHosting: [] });
    expect(stages.map((s) => s.id)).toEqual(['llm', 'stt', 'tts', 'wake']);
    expect(stages.every((s) => s.location === null)).toBe(true);
  });

  it('clocks a local engine as on-device only when a model is actually installed', () => {
    const installed = classifyPipeline({
      chatModelHosting: [],
      sttEngine: 'local',
      localSttAvailable: true,
    });
    expect(installed.find((s) => s.id === 'stt')!.location).toBe('onDevice');

    const missing = classifyPipeline({ chatModelHosting: [], sttEngine: 'local' });
    expect(missing.find((s) => s.id === 'stt')!.location).toBe('region');
  });

  it('treats a custom endpoint as an on-device/local alternative', () => {
    const stages = classifyPipeline({
      chatModelHosting: [],
      ttsEngine: 'local',
      customTtsEndpoint: true,
    });
    expect(stages.find((s) => s.id === 'tts')!.location).toBe('onDevice');
  });

  it('reports the wake stage as on-device when a local engine is configured', () => {
    const stages = classifyPipeline({ chatModelHosting: [], wakeEngine: 'openwakeword' });
    expect(stages.find((s) => s.id === 'wake')!.location).toBe('onDevice');
  });

  it('marks the wake stage unset when the engine is unavailable', () => {
    const stages = classifyPipeline({
      chatModelHosting: [],
      wakeEngine: 'openwakeword',
      wakeUnavailable: true,
    });
    expect(stages.find((s) => s.id === 'wake')!.location).toBeNull();
  });

  it('marks a cloud wake as region', () => {
    const stages = classifyPipeline({
      chatModelHosting: [],
      wakeEngine: 'porcupine',
      wakeUsesCloud: true,
    });
    expect(stages.find((s) => s.id === 'wake')!.location).toBe('region');
  });
});

describe('countHostingClasses', () => {
  it('counts each model once per class it advertises', () => {
    const counts = countHostingClasses([
      { availableHostingTypes: ['public_cloud', 'private_cloud'] },
      { availableHostingTypes: ['public_cloud'] },
    ]);
    expect(counts).toEqual([
      { hosting: 'public_cloud', count: 2 },
      { hosting: 'private_cloud', count: 1 },
    ]);
  });

  it('omits classes with no models and ignores unknown keys', () => {
    const counts = countHostingClasses([{ availableHostingTypes: ['frobnicate'] }]);
    expect(counts).toEqual([]);
  });

  it('recognises exactly the four canonical classes', () => {
    for (const key of HOSTING_CLASSES) expect(isHostingClass(key)).toBe(true);
    expect(isHostingClass('frobnicate')).toBe(false);
  });
});
