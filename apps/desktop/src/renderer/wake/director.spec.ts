import { describe, expect, it, vi } from 'vitest';
import { createWakeDirector, smoothLevel, type WakeDirectorBridge } from './director.js';
import type { WakeSettings, WakeBindingResolution } from '../../shared/ipc.js';
import { DEFAULT_WAKE_BEHAVIOR, type WakeAgentRow, type WakeWordBinding } from '../../shared/wake.js';
import type { WakeDetector } from './engine.js';
import type { WakeMicSource } from './mic.js';

/** A settings object with the behavior defaults filled in. */
function settings(over: Partial<WakeSettings> = {}): WakeSettings {
  return { enabled: false, bindings: [], ...DEFAULT_WAKE_BEHAVIOR, ...over };
}

function binding(id: string, extra: Partial<WakeSettings['bindings'][number]> = {}) {
  return {
    id,
    phrase: `phrase-${id}`,
    agentId: `agent-${id}`,
    agentName: `Agent ${id}`,
    modelId: 'catalog:desktop/wake-hey-jarvis',
    sensitivity: 0.5,
    enabled: true,
    sampleRef: null,
    sampleFingerprint: null,
    ...extra,
  };
}

function makeMic() {
  let handler: ((frame: Float32Array) => void) | null = null;
  let active = false;
  const mic: WakeMicSource & { feed: (rms: number) => void } = {
    get active() {
      return active;
    },
    message: null,
    sampleRate: 16_000,
    async start(next) {
      handler = next;
      active = true;
      return true;
    },
    stop() {
      active = false;
      handler = null;
    },
    feed(rms) {
      const frame = new Float32Array(64).fill(rms);
      handler?.(frame);
    },
  };
  return mic;
}

/** A detector that fires when fed a non-silent frame. */
function firingDetector(id: string): WakeDetector {
  return {
    id,
    detecting: true,
    reset: vi.fn(),
    push: ({ frame }) => ({ fired: frame.some((v) => v > 0.5), confidence: 0.9 }),
  };
}

function makeDirector(opts: {
  settings: WakeSettings;
  detectors?: Record<string, WakeDetector | null>;
  resolutions?: Record<string, WakeBindingResolution | null>;
  agents?: WakeAgentRow[];
}) {
  const states: unknown[] = [];
  const activated: Array<{ phrase: string; agentId: string | null }> = [];
  const saved = [] as WakeSettings[];
  let current = opts.settings;
  const mic = makeMic();
  const bridge: WakeDirectorBridge = {
    wakeGetSettings: vi.fn(async () => current),
    wakeListAgents: vi.fn(async () => opts.agents ?? []),
    wakeSetSettings: vi.fn(async (next) => {
      current = next;
      saved.push(next);
      return next;
    }),
    wakeResolveBinding: vi.fn(async (binding) => {
      const id = typeof binding === 'string' ? binding : binding.id;
      return (
        opts.resolutions?.[id] ??
        defaultResolution(
          id,
          typeof binding === 'string' ? undefined : binding,
        )
      );
    }),
    wakeReportState: vi.fn(async (s) => {
      states.push(s);
    }),
    wakeActivated: vi.fn(async (p) => {
      activated.push(p);
    }),
  };
  function defaultResolution(id: string, passed?: WakeWordBinding): WakeBindingResolution {
    const b = current.bindings.find((x) => x.id === id) ?? passed;
    return {
      binding: b ?? binding(id),
      engineKind: 'builtin',
      armed: true,
      modelBytes: new Uint8Array([1]),
      customSampleFingerprint: null,
      transcribeLocally: false,
      unavailableReason: null,
    };
  }
  const director = createWakeDirector({
    bridge,
    buildDetector: async (res) => opts.detectors?.[res.binding.id] ?? firingDetector(res.binding.id),
    createMic: () => mic,
    onStateChange: (s) => states.push(s),
  });
  return { director, mic, states, activated, saved, bridge };
}

describe('smoothLevel', () => {
  it('eases toward the sample', () => {
    expect(smoothLevel(0, 1, 0.5)).toBeCloseTo(0.5);
    expect(smoothLevel(0.5, 1, 0.5)).toBeCloseTo(0.75);
  });
  it('clamps inputs', () => {
    expect(smoothLevel(1, 5, 1)).toBe(1);
    expect(smoothLevel(0, -3, 1)).toBe(0);
  });
});

describe('createWakeDirector', () => {
  it('stays idle when disabled', async () => {
    const { director, mic } = makeDirector({ settings: settings({ enabled: false, bindings: [binding('a')] }) });
    await director.start();
    expect(director.getState().enabled).toBe(false);
    expect(director.getState().listening).toBe(false);
    expect(mic.active).toBe(false);
  });

  it('arms enabled bindings and reports listening', async () => {
    const { director, mic } = makeDirector({ settings: settings({ enabled: true, bindings: [binding('a')] }) });
    await director.start();
    expect(director.getState().listening).toBe(true);
    expect(director.getState().activePhrases).toEqual(['phrase-a']);
    expect(mic.active).toBe(true);
  });

  it('fires once per phrase and reports the mapped agent', async () => {
    const { director, mic, activated } = makeDirector({
      settings: settings({ enabled: true, bindings: [binding('a')] }),
    });
    await director.start();
    mic.feed(0.9);
    mic.feed(0.9);
    // Allow the async fire() chain to settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(activated).toHaveLength(1);
    expect(activated[0]).toEqual({ phrase: 'phrase-a', agentId: 'agent-a' });
    expect(director.getState().lastDetection?.phrase).toBe('phrase-a');
  });

  it('reports a reason when a binding cannot be armed', async () => {
    const { director } = makeDirector({
      settings: settings({ enabled: true, bindings: [binding('a')] }),
      resolutions: {
        a: {
          binding: binding('a'),
          engineKind: 'builtin',
          armed: false,
          modelBytes: null,
          customSampleFingerprint: null,
          transcribeLocally: false,
          unavailableReason: 'The selected wake-word model is not installed yet.',
        },
      },
    });
    await director.start();
    expect(director.getState().listening).toBe(false);
    expect(director.getState().message).toMatch(/not installed/);
  });

  it('reconciles when settings change via saveSettings', async () => {
    const { director, mic } = makeDirector({ settings: settings({ enabled: true, bindings: [binding('a')] }) });
    await director.start();
    await director.saveSettings(settings({ enabled: false, bindings: [binding('a')] }));
    expect(director.getState().enabled).toBe(false);
    expect(mic.active).toBe(false);
  });

  it('stops listening on stop()', async () => {
    const { director, mic } = makeDirector({ settings: settings({ enabled: true, bindings: [binding('a')] }) });
    await director.start();
    director.stop();
    expect(mic.active).toBe(false);
    expect(director.getState().listening).toBe(false);
    expect(director.getState().level).toBe(0);
  });

  it('arms an auto-mapped binding derived from an agent name', async () => {
    const agents: WakeAgentRow[] = [
      { contactId: 've-bob', virtualEmployeeId: 've-bob', agentId: null, name: 'Bob', canConfigure: true },
    ];
    const { director } = makeDirector({
      settings: settings({ enabled: true, bindings: [], autoMapAgents: true }),
      agents,
    });
    await director.start();
    // The derived phrase comes from the agent's chat name.
    expect(director.getState().activePhrases).toEqual(['Bob']);
    expect(director.getState().listening).toBe(true);
  });

  it('honours the auto-map blocklist', async () => {
    const agents: WakeAgentRow[] = [
      { contactId: 've-bob', virtualEmployeeId: 've-bob', agentId: null, name: 'Bob', canConfigure: true },
      { contactId: 've-eve', virtualEmployeeId: 've-eve', agentId: null, name: 'Eve', canConfigure: true },
    ];
    const { director } = makeDirector({
      settings: settings({
        enabled: true,
        bindings: [],
        autoMapAgents: true,
        autoMapMode: 'blocklist',
        autoMapIds: ['ve-bob'],
      }),
      agents,
    });
    await director.start();
    expect(director.getState().activePhrases).toEqual(['Eve']);
  });

  it('does not arm auto-mapped agents when no agent can be listed', async () => {
    const { director } = makeDirector({
      settings: settings({ enabled: true, bindings: [], autoMapAgents: true }),
      agents: [],
    });
    await director.start();
    expect(director.getState().listening).toBe(false);
    expect(director.getState().activePhrases).toEqual([]);
  });
});
