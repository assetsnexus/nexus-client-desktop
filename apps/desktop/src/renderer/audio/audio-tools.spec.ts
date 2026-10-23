import { describe, expect, it, vi } from 'vitest';
import { buildAudioToolDescriptors, executeAudioTool, registerAudioTools } from './audio-tools.js';
import { normalizeAudioSettings, type AudioOutputTarget } from '../../shared/audio.js';

function makeDeps(settingsRaw: unknown) {
  let target: AudioOutputTarget = 'primary';
  const settings = normalizeAudioSettings(settingsRaw);
  return {
    getTarget: () => target,
    setTarget: vi.fn((t: AudioOutputTarget) => {
      target = t;
    }),
    getSettings: () => settings,
    listOutputs: () => [
      { deviceId: 'spk-primary', label: 'Desk', available: true },
      { deviceId: 'spk-1', label: 'Kitchen', available: true },
      { deviceId: 'spk-3', label: 'Studio', available: true },
    ],
  };
}

describe('buildAudioToolDescriptors', () => {
  it('exposes a list and a set tool', () => {
    const names = buildAudioToolDescriptors().map((d) => d.name);
    expect(names).toEqual(['audio_list_outputs', 'audio_set_output']);
  });
});

describe('executeAudioTool', () => {
  it('lists outputs and marks permitted ones', () => {
    const deps = makeDeps({
      output: { primaryOutputId: 'spk-primary', allowedOutputIds: ['spk-1'] },
    });
    const result = executeAudioTool(deps, 'audio_list_outputs', {});
    expect(result.ok).toBe(true);
    const outputs = (result.data as { outputs: Array<{ deviceId: string; permitted: boolean }> }).outputs;
    expect(outputs.find((o) => o.deviceId === 'spk-primary')?.permitted).toBe(true);
    expect(outputs.find((o) => o.deviceId === 'spk-1')?.permitted).toBe(true);
    expect(outputs.find((o) => o.deviceId === 'spk-3')?.permitted).toBe(false);
  });

  it('accepts primary and all targets', () => {
    const deps = makeDeps({ output: { primaryOutputId: 'spk-primary', allowedOutputIds: ['spk-1'] } });
    const toPrimary = executeAudioTool(deps, 'audio_set_output', { target: 'primary' });
    expect(toPrimary.ok).toBe(true);
    const toAll = executeAudioTool(deps, 'audio_set_output', { target: 'all' });
    expect(toAll.ok).toBe(true);
    expect((toAll.data as { devices: string[] }).devices).toEqual(['spk-primary', 'spk-1']);
    expect(deps.setTarget).toHaveBeenCalledWith('all');
  });

  it('accepts a specific permitted device and refuses an unpermitted one', () => {
    const deps = makeDeps({ output: { primaryOutputId: 'spk-primary', allowedOutputIds: ['spk-1'] } });
    expect(executeAudioTool(deps, 'audio_set_output', { target: 'spk-1' }).ok).toBe(true);
    const refused = executeAudioTool(deps, 'audio_set_output', { target: 'spk-3' });
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/not permitted/i);
  });

  it('refuses any routing when the user configured nothing', () => {
    const deps = makeDeps({});
    const result = executeAudioTool(deps, 'audio_set_output', { target: 'all' });
    expect(result.ok).toBe(false);
    expect(deps.setTarget).not.toHaveBeenCalled();
  });

  it('rejects a blank target and unknown tools', () => {
    const deps = makeDeps({ output: { primaryOutputId: 'spk-primary' } });
    expect(executeAudioTool(deps, 'audio_set_output', {}).ok).toBe(false);
    expect(executeAudioTool(deps, 'audio_bogus', {}).ok).toBe(false);
  });

  it('normalizes dotted tool names', () => {
    const deps = makeDeps({ output: { primaryOutputId: 'spk-primary' } });
    expect(executeAudioTool(deps, 'audio.list_outputs', {}).ok).toBe(true);
  });
});

describe('registerAudioTools', () => {
  it('registers every descriptor and routes calls through deps', () => {
    const deps = makeDeps({ output: { primaryOutputId: 'spk-primary' } });
    const registered: string[] = [];
    const handlers: Record<string, (a: unknown) => unknown> = {};
    const names = registerAudioTools(
      () => ({
        ...deps,
        getSettings: deps.getSettings,
        listOutputs: deps.listOutputs,
        getTarget: deps.getTarget,
        setTarget: deps.setTarget,
      }),
      (descriptor, handler) => {
        registered.push(descriptor.name);
        handlers[descriptor.name] = handler;
      },
    );
    expect(names).toEqual(registered);
    const result = handlers.audio_set_output?.({ target: 'primary' }) as { ok: boolean };
    expect(result.ok).toBe(true);
  });
});
