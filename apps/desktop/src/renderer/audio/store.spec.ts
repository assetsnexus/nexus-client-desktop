import { describe, expect, it, vi } from 'vitest';
import { buildAudioDevices, createAudioStore } from './store.js';
import { normalizeAudioSettings } from '../../shared/audio.js';

const RAW = [
  { deviceId: 'default', kind: 'audioinput', label: 'Default Mic' },
  { deviceId: 'mic-1', kind: 'audioinput', label: 'USB Mic' },
  { deviceId: 'spk-1', kind: 'audiooutput', label: 'Kitchen' },
  { deviceId: 'spk-2', kind: 'audiooutput', label: '' },
];

describe('buildAudioDevices', () => {
  it('splits inputs and outputs and marks the default', () => {
    const { inputs, outputs } = buildAudioDevices(RAW, normalizeAudioSettings({}));
    expect(inputs.map((d) => d.deviceId)).toEqual(['default', 'mic-1']);
    expect(inputs[0]!.isDefault).toBe(true);
    expect(outputs.map((d) => d.deviceId)).toEqual(['spk-1', 'spk-2']);
  });

  it('falls back to positional labels for unnamed devices', () => {
    const { outputs } = buildAudioDevices(RAW, normalizeAudioSettings({}));
    expect(outputs[1]!.label).toBe('Speaker 2');
  });

  it('surfaces configured-but-absent devices as unavailable', () => {
    const settings = normalizeAudioSettings({
      output: { primaryOutputId: 'gone-spk' },
      input: { wakeInputIds: ['gone-mic'] },
    });
    const { inputs, outputs } = buildAudioDevices(RAW, settings);
    expect(outputs.find((d) => d.deviceId === 'gone-spk')?.available).toBe(false);
    expect(inputs.find((d) => d.deviceId === 'gone-mic')?.available).toBe(false);
  });
});

function makeStore(overrides: Partial<Parameters<typeof createAudioStore>[0]> = {}) {
  const written: unknown[] = [];
  // Stateful mock: a write is visible to the next read, like the real store.
  let current = normalizeAudioSettings({});
  const deps = {
    readSettings: vi.fn(async () => current),
    writeSettings: vi.fn(async (patch: unknown) => {
      written.push(patch);
      current = normalizeAudioSettings(patch);
      return current;
    }),
    mediaDevices: () => ({
      enumerateDevices: async () => RAW,
    }),
    ...overrides,
  };
  return { store: createAudioStore(deps), deps, written };
}

describe('createAudioStore', () => {
  it('refreshes settings and devices', async () => {
    const { store } = makeStore();
    await store.refresh();
    const snap = store.getSnapshot();
    expect(snap.inputs).toHaveLength(2);
    expect(snap.outputs).toHaveLength(2);
    expect(snap.hasMicPermission).toBe(true);
  });

  it('reports no mic permission when labels are empty', async () => {
    const { store } = makeStore({
      mediaDevices: () => ({
        enumerateDevices: async () => RAW.map((d) => ({ ...d, label: '' })),
      }),
    });
    await store.refresh();
    expect(store.getSnapshot().hasMicPermission).toBe(false);
  });

  it('toggles and persists the input mute', async () => {
    const writes: Array<{ input: boolean; output: boolean }> = [];
    const { store } = makeStore({ writeMute: (m) => writes.push(m) });
    expect(store.toggleInputMuted()).toBe(true);
    expect(store.getSnapshot().inputMuted).toBe(true);
    expect(writes.at(-1)).toEqual({ input: true, output: false });
    expect(store.toggleInputMuted()).toBe(false);
  });

  it('sets the output target and resolves permitted device ids', async () => {
    const { store } = makeStore({
      readSettings: async () =>
        normalizeAudioSettings({
          output: { primaryOutputId: 'spk-primary', allowedOutputIds: ['spk-1'] },
        }),
    });
    await store.refresh();
    expect(store.currentOutputDeviceIds()).toEqual(['spk-primary']);
    store.setOutputTarget('all');
    expect(store.currentOutputDeviceIds()).toEqual(['spk-primary', 'spk-1']);
    store.setOutputTarget('spk-1');
    expect(store.currentOutputDeviceIds()).toEqual(['spk-1']);
  });

  it('exposes whether the agent may route output at all', async () => {
    const { store } = makeStore();
    await store.refresh();
    expect(store.agentCanRoute()).toBe(false);
  });

  it('merges partial patches and re-reads devices', async () => {
    const { store, written } = makeStore();
    await store.refresh();
    await store.setPatch({ output: { primaryOutputId: 'spk-1', allowedOutputIds: [] } });
    expect(written).toHaveLength(1);
    expect(store.getSnapshot().settings.output.primaryOutputId).toBe('spk-1');
  });

  it('notifies subscribers on change', async () => {
    const { store } = makeStore();
    const seen = vi.fn();
    const off = store.subscribe(seen);
    await store.refresh();
    expect(seen).toHaveBeenCalled();
    off();
  });
});
