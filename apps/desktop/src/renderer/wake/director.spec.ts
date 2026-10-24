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
    aliases: [] as string[],
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
  /** Extra wake-listening microphones, keyed by device id. */
  extraMics?: Record<string, ReturnType<typeof makeMic>>;
  wakeInputIds?: string[];
}) {
  const states: unknown[] = [];
  const activated: Array<{ phrase: string; agentId: string | null }> = [];
  const saved = [] as WakeSettings[];
  /** groupKey → the binding ids built for that stream (per-stream isolation). */
  const builtPerGroup: Record<string, string[]> = {};
  const disposedGroups: string[] = [];
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
    buildDetector: async (res, groupKey) => {
      (builtPerGroup[groupKey] ??= []).push(res.binding.id);
      return opts.detectors?.[res.binding.id] ?? firingDetector(`${groupKey}:${res.binding.id}`);
    },
    createMic: () => mic,
    createMicForDevice: opts.extraMics
      ? (deviceId) => opts.extraMics![deviceId] ?? makeMic()
      : undefined,
    getWakeInputIds: opts.wakeInputIds ? () => opts.wakeInputIds! : undefined,
    disposeGroup: (groupKey) => disposedGroups.push(groupKey),
    onStateChange: (s) => states.push(s),
  });
  return { director, mic, states, activated, saved, bridge, builtPerGroup, disposedGroups };
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

  it('re-fires the same phrase after the cooldown (re-arms, no one-shot lock)', async () => {
    let clock = 1_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      const { director, mic, activated } = makeDirector({
        settings: settings({ enabled: true, bindings: [binding('a')] }),
      });
      await director.start();
      mic.feed(0.9);
      await Promise.resolve();
      await Promise.resolve();
      expect(activated).toHaveLength(1);
      // Same utterance on a second microphone within the cooldown stays collapsed…
      mic.feed(0.9);
      await Promise.resolve();
      expect(activated).toHaveLength(1);
      // …but after the cooldown the user can wake the same agent again. Without
      // clearing the old permanent set the agent window only ever opened once.
      clock += 5_000;
      mic.feed(0.9);
      await Promise.resolve();
      await Promise.resolve();
      expect(activated).toHaveLength(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('arms one detector per alias and reports the spoken alias phrase', async () => {
    const { director, mic, activated, builtPerGroup } = makeDirector({
      settings: settings({
        enabled: true,
        bindings: [binding('a', { phrase: 'Xeni', aliases: ['Zeni'], modelId: 'stt:1' })],
      }),
      resolutions: {
        a: {
          binding: binding('a', { phrase: 'Xeni', aliases: ['Zeni'], modelId: 'stt:1' }),
          engineKind: 'stt_phrase',
          armed: true,
          modelBytes: null,
          customSampleFingerprint: null,
          transcribeLocally: true,
          unavailableReason: null,
        },
      },
    });
    await director.start();
    // Both the primary phrase and the alias are armed (text matching), and the
    // bar lists both.
    expect(builtPerGroup.primary!.filter((id) => id === 'a')).toHaveLength(2);
    expect(director.getState().activePhrases).toEqual(['Xeni', 'Zeni']);
    mic.feed(0.9);
    await Promise.resolve();
    await Promise.resolve();
    // The reported phrase is the exact one that fired (the alias is distinct),
    // while both route to the same agent.
    expect(new Set(activated.map((a) => a.phrase))).toEqual(new Set(['Xeni', 'Zeni']));
    expect(activated.every((a) => a.agentId === 'agent-a')).toBe(true);
  });

  it('arms a global alias configured for a phrase, with no binding-level alias', async () => {
    // The alias lives only in `agentAliases` (the shape an auto-mapped agent
    // uses), so the binding itself carries no aliases.
    const xeni = binding('a', { phrase: 'Xeni', aliases: [], modelId: 'stt:1' });
    const { director, builtPerGroup } = makeDirector({
      settings: settings({
        enabled: true,
        bindings: [xeni],
        agentAliases: { xeni: ['Zeni'] },
      }),
      resolutions: {
        a: {
          binding: xeni,
          engineKind: 'stt_phrase',
          armed: true,
          modelBytes: null,
          customSampleFingerprint: null,
          transcribeLocally: true,
          unavailableReason: null,
        },
      },
    });
    await director.start();
    expect(builtPerGroup.primary!.filter((id) => id === 'a')).toHaveLength(2);
    expect(director.getState().activePhrases).toEqual(['Xeni', 'Zeni']);
  });

  it('does not arm aliases for a fixed keyword (non-STT) binding', async () => {
    const { director, builtPerGroup } = makeDirector({
      settings: settings({
        enabled: true,
        bindings: [binding('a', { phrase: 'Hey Jarvis', aliases: ['Jarvis'] })],
      }),
      // default resolution is `builtin`
    });
    await director.start();
    // Only the primary phrase is armed: a keyword model fires on its own phrase.
    expect(builtPerGroup.primary).toEqual(['a']);
    expect(director.getState().activePhrases).toEqual(['Hey Jarvis']);
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

  it('streams the latest on-device transcript into live state', async () => {
    const { director } = makeDirector({
      settings: settings({ enabled: true, bindings: [binding('a')] }),
    });
    await director.start();
    expect(director.getState().transcript).toBeNull();
    director.noteTranscript('  hey jarvis open the door  ');
    expect(director.getState().transcript).toBe('hey jarvis open the door');
    // Blank updates are ignored so the caption is not wiped by noise.
    director.noteTranscript('   ');
    expect(director.getState().transcript).toBe('hey jarvis open the door');
  });

  it('clears the transcript when listening stops', async () => {
    const { director } = makeDirector({
      settings: settings({ enabled: true, bindings: [binding('a')] }),
    });
    await director.start();
    director.noteTranscript('hello there');
    expect(director.getState().transcript).toBe('hello there');
    director.stop();
    expect(director.getState().transcript).toBeNull();
  });
});

describe('multiple wake microphones', () => {
  const twoMic = () => ({
    settings: settings({ enabled: true, bindings: [binding('a'), binding('b')] }),
    extraMics: { 'mic-2': makeMic(), 'mic-3': makeMic() },
    wakeInputIds: ['mic-2', 'mic-3'],
  });

  it('lists each armed phrase once, not once per microphone', async () => {
    const { director, builtPerGroup } = makeDirector(twoMic());
    await director.start();
    // Three streams (primary + 2 extras) each arm both bindings...
    expect(Object.keys(builtPerGroup).sort()).toEqual(['device:mic-2', 'device:mic-3', 'primary']);
    expect(builtPerGroup.primary).toEqual(['a', 'b']);
    // ...but the bar must not show the duplicates.
    expect(director.getState().activePhrases).toEqual(['phrase-a', 'phrase-b']);
  });

  it('builds detectors per stream so per-stream state is never shared', async () => {
    const { director, builtPerGroup } = makeDirector(twoMic());
    await director.start();
    // Every group was asked to build the same bindings — the point is that the
    // builder was called with a distinct groupKey each time (see the engine hub).
    for (const key of ['primary', 'device:mic-2', 'device:mic-3']) {
      expect(builtPerGroup[key]).toEqual(['a', 'b']);
    }
  });

  it('releases per-stream resources when a group is torn down', async () => {
    const { director, disposedGroups } = makeDirector(twoMic());
    await director.start();
    disposedGroups.length = 0;
    await director.reconcileNow();
    expect(disposedGroups.sort()).toEqual(['device:mic-2', 'device:mic-3', 'primary']);
  });

  it('fires once even when two microphones hear the same phrase', async () => {
    const second = makeMic();
    const { director, mic, activated } = makeDirector({
      settings: settings({ enabled: true, bindings: [binding('a')] }),
      extraMics: { 'mic-2': second },
      wakeInputIds: ['mic-2'],
    });
    await director.start();
    // Both streams hear the phrase; the de-dupe must collapse it to one fire.
    mic.feed(0.9);
    second.feed(0.9);
    await Promise.resolve();
    await Promise.resolve();
    expect(activated.filter((a) => a.phrase === 'phrase-a')).toHaveLength(1);
  });

  it('drops a group whose microphone fails to start', async () => {
    const failing = makeMic();
    failing.start = async () => false;
    const { director, disposedGroups, builtPerGroup } = makeDirector({
      settings: settings({ enabled: true, bindings: [binding('a')] }),
      extraMics: { 'mic-bad': failing },
      wakeInputIds: ['mic-bad'],
    });
    await director.start();
    // The primary still listens; the failed group's detectors are disposed.
    expect(director.getState().listening).toBe(true);
    expect(disposedGroups).toContain('device:mic-bad');
    expect(builtPerGroup['device:mic-bad']).toEqual(['a']);
  });
});
