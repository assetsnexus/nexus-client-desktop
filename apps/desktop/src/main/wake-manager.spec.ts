import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWakeManager, toBindingResolution } from './wake-manager.js';
import type { WakeSettings } from '../shared/wake.js';

function makeManager() {
  const dir = mkdtempSync(join(tmpdir(), 'wake-mgr-'));
  const settingsPath = join(dir, 'wake.json');
  const queuePath = join(dir, 'wake-queue.json');
  const onActivate = vi.fn();
  const persist = vi.fn((next: WakeSettings) => next);
  const onStateChange = vi.fn();
  const manager = createWakeManager({
    settingsPath,
    queuePath,
    resolveBinding: () => null,
    persist,
    onActivate,
    onStateChange,
  });
  return { manager, settingsPath, queuePath, onActivate, persist, onStateChange };
}

describe('createWakeManager', () => {
  it('returns safe defaults when no file exists', () => {
    const { manager } = makeManager();
    const settings = manager.getSettings();
    expect(settings.enabled).toBe(false);
    expect(settings.bindings).toEqual([]);
    // Behaviour defaults: review before send, 1-minute discard, auto-map on.
    expect(settings.reviewBeforeSend).toBe(true);
    expect(settings.unsentPolicy).toBe('discard');
    expect(settings.activationTimeoutSeconds).toBe(60);
    expect(settings.autoMapAgents).toBe(true);
  });

  it('persists normalized settings to disk and through the host', () => {
    const { manager, settingsPath, persist } = makeManager();
    const next = manager.setSettings({
      enabled: true,
      bindings: [{ phrase: 'Hey Jarvis', sensitivity: 5 }],
    });
    expect(next.bindings[0]!.sensitivity).toBe(1);
    expect(persist).toHaveBeenCalledWith(next);
    const onDisk = JSON.parse(readFileSync(settingsPath, 'utf8')) as WakeSettings;
    expect(onDisk.enabled).toBe(true);
    expect(onDisk.bindings[0]!.phrase).toBe('Hey Jarvis');
  });

  it('reloads what it wrote', () => {
    const { manager } = makeManager();
    manager.setSettings({ enabled: true, bindings: [{ phrase: 'Ok Nexus' }] });
    expect(manager.getSettings().bindings[0]!.phrase).toBe('Ok Nexus');
  });

  it('recovers from a corrupt file without throwing', () => {
    const { manager, settingsPath } = makeManager();
    writeFileSync(settingsPath, '{ not json');
    const settings = manager.getSettings();
    expect(settings.enabled).toBe(false);
    expect(settings.bindings).toEqual([]);
    expect(settings.activationMode).toBe('chat');
  });

  it('routes an activation to the mapped agent', () => {
    const { manager, onActivate } = makeManager();
    manager.activate({ phrase: 'Hey Jarvis', agentId: 'a1' });
    expect(onActivate).toHaveBeenCalledWith({ phrase: 'Hey Jarvis', agentId: 'a1' });
  });

  it('forwards live state to the state hook', () => {
    const { manager, onStateChange } = makeManager();
    manager.reportState({ listening: true });
    expect(onStateChange).toHaveBeenCalledWith({ listening: true });
  });

  it('persists behaviour settings and clamps the timeout', () => {
    const { manager } = makeManager();
    const next = manager.setSettings({
      enabled: true,
      bindings: [{ phrase: 'Hey' }],
      reviewBeforeSend: false,
      submitPhrases: ['Submit', '  answer now  ', 'submit'],
      unsentPolicy: 'queue',
      activationTimeoutSeconds: 5,
      autoMapAgents: true,
    });
    expect(next.reviewBeforeSend).toBe(false);
    expect(next.submitPhrases).toEqual(['submit', 'answer now']);
    expect(next.unsentPolicy).toBe('queue');
    // Clamped up to the 10s minimum.
    expect(next.activationTimeoutSeconds).toBe(10);
    expect(next.autoMapAgents).toBe(true);
  });
});

describe('wake manager queue', () => {
  it('starts empty and round-trips entries', () => {
    const { manager } = makeManager();
    expect(manager.getQueue()).toEqual([]);
    const entry = {
      id: 'u1',
      agentId: 'a1',
      agentName: 'A',
      text: 'hello',
      at: 5,
      phrase: 'Hey',
    };
    manager.setQueue([entry]);
    expect(manager.getQueue()).toEqual([entry]);
  });

  it('drops malformed entries and persists to disk', () => {
    const { manager, queuePath } = makeManager();
    const out = manager.setQueue([
      { id: 'u1', text: 'ok', at: 1 },
      { id: '', text: 'no id' },
      { id: 'u2', text: '   ' },
      null,
    ]);
    expect(out.map((q) => q.id)).toEqual(['u1']);
    const onDisk = JSON.parse(readFileSync(queuePath, 'utf8')) as unknown[];
    expect(onDisk).toHaveLength(1);
  });

  it('tolerates a non-array setQueue patch', () => {
    const { manager } = makeManager();
    expect(manager.setQueue('nope')).toEqual([]);
  });
});

describe('toBindingResolution', () => {
  const binding = {
    id: 'w1',
    phrase: 'Hey Jarvis',
    aliases: [] as string[],
    agentId: 'a1',
    agentName: 'Jarvis',
    modelId: 'catalog:desktop/wake-hey-jarvis',
    sensitivity: 0.5,
    enabled: true,
    sampleRef: null,
    sampleFingerprint: null,
  };

  it('returns null for a null input', () => {
    expect(toBindingResolution(null)).toBeNull();
  });

  it('flattens artifact bytes to modelBytes when armed', () => {
    const out = toBindingResolution({
      binding,
      engineKind: 'builtin',
      armed: true,
      artifact: { bytes: new Uint8Array([1, 2, 3]) },
      customSampleFingerprint: null,
    });
    expect(out!.modelBytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(out!.armed).toBe(true);
    expect(out!.unavailableReason).toBeNull();
  });

  it('marks an uninstalled model as unavailable', () => {
    const out = toBindingResolution({
      binding,
      engineKind: 'builtin',
      armed: true,
      artifact: null,
      customSampleFingerprint: null,
    });
    expect(out!.armed).toBe(false);
    expect(out!.unavailableReason).toMatch(/not installed/);
  });

  it('marks a disabled binding and a missing model', () => {
    expect(
      toBindingResolution({
        binding: { ...binding, enabled: false },
        engineKind: 'builtin',
        armed: false,
        artifact: null,
        customSampleFingerprint: null,
      })!.unavailableReason,
    ).toMatch(/turned off/);
    expect(
      toBindingResolution({
        binding: { ...binding, modelId: null },
        engineKind: 'builtin',
        armed: false,
        artifact: null,
        customSampleFingerprint: null,
      })!.unavailableReason,
    ).toMatch(/model/);
  });

  it('does not require model bytes for a custom_sample binding', () => {
    const out = toBindingResolution({
      binding: { ...binding, sampleRef: 'priv:abc' },
      engineKind: 'custom_sample',
      armed: true,
      artifact: null,
      customSampleFingerprint: { envelope: [1, 2], frames: 2, sampleRate: 16000, hopSamples: 512 },
    });
    expect(out!.armed).toBe(true);
    expect(out!.unavailableReason).toBeNull();
    expect(out!.customSampleFingerprint?.frames).toBe(2);
  });

  it('arms an stt_phrase binding without model bytes when local STT is ready', () => {
    const out = toBindingResolution(
      {
        binding: { ...binding, modelId: 'catalog:desktop/whisper-small-q5' },
        engineKind: 'stt_phrase',
        armed: true,
        artifact: null,
        customSampleFingerprint: null,
      },
      true,
    );
    expect(out!.armed).toBe(true);
    expect(out!.transcribeLocally).toBe(true);
    expect(out!.unavailableReason).toBeNull();
  });

  it('marks an stt_phrase binding unavailable when local STT is not ready', () => {
    const out = toBindingResolution(
      {
        binding: { ...binding, modelId: 'catalog:desktop/whisper-small-q5' },
        engineKind: 'stt_phrase',
        armed: true,
        artifact: null,
        customSampleFingerprint: null,
      },
      false,
    );
    expect(out!.armed).toBe(false);
    expect(out!.unavailableReason).toMatch(/not installed|no local speech model/i);
  });
});
