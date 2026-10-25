/**
 * Wake transcriber resolution spec.
 *
 * The picker must honour the user's `sttEngine` setting via the shared
 * `dictationTranscribesInCloud` policy (the same one that decides the
 * "streaming to the cloud" banner), fall back to the other engine when the
 * chosen one is not ready, and report which engine actually ran. `leavesDevice`
 * must be correct for each outcome because it gates the visible streaming notice.
 */

import { describe, expect, it, vi } from 'vitest';

/** Local engine readiness is driven by `bridge.wakeSttStatus()`. */
let localReady = false;
vi.mock('../bridge.js', () => ({
  bridge: {
    wakeSttStatus: async () => ({
      ready: localReady,
      reason: localReady ? null : 'No local speech model is installed.',
      modelId: localReady ? 'whisper-small' : null,
      modelLabel: localReady ? 'Whisper Small' : null,
    }),
  },
}));

import {
  createCloudTranscriber,
  createLocalTranscriber,
  engineLabelFor,
  pickWakeTranscriber,
  resolveWakeTranscriber,
} from './stt-transcriber.js';

/** Cloud readiness is driven by whether the catalog holds an STT model. */
function cloudDeps(hasModel: boolean) {
  return {
    client: {},
    listModels: async () => ({
      models: hasModel
        ? [{ id: 'whisper-1', capabilities: ['audio_input'] }]
        : [],
    }),
  };
}

const phrases = () => ['Xeni'];

describe('resolveWakeTranscriber', () => {
  it('uses the cloud engine when the user explicitly selected `cloud`', async () => {
    localReady = true; // even with a local engine available, the choice wins
    const picked = await resolveWakeTranscriber({
      phrases,
      cloud: cloudDeps(true),
      engine: { sttEngine: 'cloud', localSttAvailable: true, customSttEndpoint: false },
    });
    expect(picked.transcriber.id).toBe('cloud');
    expect(picked.transcriber.leavesDevice).toBe(true);
    expect(picked.fallback).toBe(false);
    expect(picked.label).toBe('Region inference');
  });

  it('uses the local engine when `local` is selected and a model is available', async () => {
    localReady = true;
    const picked = await resolveWakeTranscriber({
      phrases,
      cloud: cloudDeps(true),
      engine: { sttEngine: 'local', localSttAvailable: true, customSttEndpoint: false },
    });
    expect(picked.transcriber.id).toBe('local');
    expect(picked.transcriber.leavesDevice).toBe(false);
    expect(picked.fallback).toBe(false);
    expect(picked.label).toBe('On-device');
  });

  it('uses the local engine when `local` is selected with only a custom endpoint', async () => {
    localReady = true;
    const picked = await resolveWakeTranscriber({
      phrases,
      cloud: cloudDeps(true),
      engine: { sttEngine: 'local', localSttAvailable: false, customSttEndpoint: true },
    });
    expect(picked.transcriber.id).toBe('local');
    expect(picked.transcriber.leavesDevice).toBe(false);
    expect(picked.fallback).toBe(false);
  });

  it('falls back to cloud (with the fallback label) when `local` is selected but nothing local exists', async () => {
    localReady = false;
    const picked = await resolveWakeTranscriber({
      phrases,
      cloud: cloudDeps(true),
      engine: { sttEngine: 'local', localSttAvailable: false, customSttEndpoint: false },
    });
    expect(picked.transcriber.id).toBe('cloud');
    expect(picked.transcriber.leavesDevice).toBe(true);
    expect(picked.fallback).toBe(true);
    expect(picked.label).toBe('Region inference (fallback)');
  });

  it('falls back to local (with the fallback label) when `cloud` is selected but no cloud model is entitled', async () => {
    localReady = true;
    const picked = await resolveWakeTranscriber({
      phrases,
      cloud: cloudDeps(false),
      engine: { sttEngine: 'cloud', localSttAvailable: true, customSttEndpoint: false },
    });
    expect(picked.transcriber.id).toBe('local');
    expect(picked.transcriber.leavesDevice).toBe(false);
    expect(picked.fallback).toBe(true);
    expect(picked.label).toBe('On-device (fallback)');
  });

  it('returns the desired engine when neither is ready, so a real error surfaces', async () => {
    localReady = false;
    const picked = await resolveWakeTranscriber({
      phrases,
      cloud: cloudDeps(false),
      engine: { sttEngine: 'cloud', localSttAvailable: false, customSttEndpoint: false },
    });
    expect(picked.transcriber.id).toBe('cloud');
    expect(picked.fallback).toBe(false);
  });

  it('keeps the legacy local-first preference when no engine input is given', async () => {
    localReady = true;
    const withLocal = await resolveWakeTranscriber({ phrases, cloud: cloudDeps(true) });
    expect(withLocal.transcriber.id).toBe('local');
    localReady = false;
    const withoutLocal = await resolveWakeTranscriber({ phrases, cloud: cloudDeps(true) });
    expect(withoutLocal.transcriber.id).toBe('cloud');
  });
});

describe('pickWakeTranscriber', () => {
  it('returns just the transcriber (backward-compatible wrapper)', async () => {
    localReady = true;
    const t = await pickWakeTranscriber({
      phrases,
      cloud: cloudDeps(true),
      engine: { sttEngine: 'cloud', localSttAvailable: true, customSttEndpoint: false },
    });
    expect(t.id).toBe('cloud');
  });
});

describe('engineLabelFor', () => {
  it('maps engine ids to the UI labels', () => {
    expect(engineLabelFor('local')).toBe('On-device');
    expect(engineLabelFor('cloud')).toBe('Region inference');
  });
});

describe('transcriber construction', () => {
  it('gives local/cloud the correct `leavesDevice` capability', () => {
    expect(createLocalTranscriber(phrases).leavesDevice).toBe(false);
    expect(createCloudTranscriber(cloudDeps(true)).leavesDevice).toBe(true);
  });
});
