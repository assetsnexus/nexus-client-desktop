import { describe, expect, it } from 'vitest';
import {
  CPU_GPU_LOAD_SKILL,
  DEFAULT_LOCAL_COMMAND_SKILLS,
  createLocalCommandRegistry,
} from './local-commands.js';

describe('createLocalCommandRegistry', () => {
  it('seeds, lists, gets, and removes skills', () => {
    const reg = createLocalCommandRegistry(DEFAULT_LOCAL_COMMAND_SKILLS);
    expect(reg.list()).toHaveLength(1);
    expect(reg.get('system.cpu-gpu-load')?.title).toBe('CPU + GPU load');
    expect(reg.remove('system.cpu-gpu-load')).toBe(true);
    expect(reg.list()).toHaveLength(0);
  });

  it('registers a new skill', () => {
    const reg = createLocalCommandRegistry();
    reg.register({ ...CPU_GPU_LOAD_SKILL, skillId: 'x' });
    expect(reg.get('x')).toBeDefined();
  });
});

describe('CPU_GPU_LOAD_SKILL', () => {
  it('has a command for each supported OS', () => {
    expect(CPU_GPU_LOAD_SKILL.commands.map((c) => c.os).sort()).toEqual([
      'darwin',
      'linux',
      'win32',
    ]);
  });

  it('is registered read-only so it runs without approval in Plan mode', () => {
    for (const cmd of CPU_GPU_LOAD_SKILL.commands) {
      expect(cmd.access).toBe('read');
      expect(cmd.approval).toBe('auto');
    }
  });

  it('references nvidia-smi and load metrics', () => {
    const linux = CPU_GPU_LOAD_SKILL.commands.find((c) => c.os === 'linux')!;
    expect(linux.argv.join(' ')).toContain('/proc/loadavg');
    expect(linux.argv.join(' ')).toContain('nvidia-smi');
    const win = CPU_GPU_LOAD_SKILL.commands.find((c) => c.os === 'win32')!;
    expect(win.argv.join(' ')).toContain('LoadPercentage');
    expect(win.argv.join(' ')).toContain('nvidia-smi');
  });
});

describe('registry.resolve', () => {
  it('resolves the variant for a given OS', () => {
    const reg = createLocalCommandRegistry(DEFAULT_LOCAL_COMMAND_SKILLS);
    expect(reg.resolve('system.cpu-gpu-load', 'linux')?.os).toBe('linux');
    expect(reg.resolve('system.cpu-gpu-load', 'win32')?.os).toBe('win32');
    expect(reg.resolve('missing', 'linux')).toBeUndefined();
  });
});
