import { describe, expect, it, vi } from 'vitest';
import { createMessageSpeaker, type SpeakController, type SpeakTurnFactory } from './speak.js';

function controllerOf(overrides: Partial<SpeakController> = {}): SpeakController {
  return {
    speak: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    ...overrides,
  };
}

/** Build a factory that records the controllers it mints, keyed by agent. */
function factoryOf(impl?: SpeakController) {
  const byAgent = new Map<string, SpeakController>();
  const factory = vi.fn((input: { agentId: string | null }) => {
    const key = input.agentId ?? '__default__';
    if (!byAgent.has(key)) byAgent.set(key, impl ?? controllerOf());
    return byAgent.get(key) as SpeakController;
  });
  return { factory: factory as unknown as SpeakTurnFactory, byAgent };
}

/** Flush the microtask chain a speak() pass walks (controller creation awaits). */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

describe('createMessageSpeaker', () => {
  it('speaks the text through a per-agent controller', async () => {
    const { factory, byAgent } = factoryOf();
    const speaker = createMessageSpeaker({ createSpeakTurn: factory });
    speaker.speak('hello', 'agent-1');
    await flush();
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        fallbackModelId: null,
        fallbackVoiceId: null,
      }),
    );
    expect(byAgent.get('agent-1')?.speak).toHaveBeenCalledWith('hello');
  });

  it('reuses one controller per agent', async () => {
    const { factory } = factoryOf();
    const speaker = createMessageSpeaker({ createSpeakTurn: factory });
    speaker.speak('one', 'agent-1');
    await flush();
    speaker.speak('two', 'agent-1');
    await flush();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('ignores empty text', async () => {
    const { factory } = factoryOf();
    const speaker = createMessageSpeaker({ createSpeakTurn: factory });
    speaker.speak('   ', 'agent-1');
    await flush();
    expect(factory).not.toHaveBeenCalled();
  });

  it('drops a queued message once cancelled', async () => {
    let resolveFirst: () => void = () => undefined;
    const first = controllerOf({
      speak: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve;
          }),
      ),
    });
    const { factory, byAgent } = factoryOf(first);
    const speaker = createMessageSpeaker({ createSpeakTurn: factory });
    speaker.speak('first', 'a');
    await flush();
    speaker.speak('second', 'a');
    speaker.cancel();
    resolveFirst();
    await flush();
    // The replaced text never reached the controller (cancel cleared the queue).
    expect(byAgent.get('a')?.speak).toHaveBeenCalledTimes(1);
    expect(byAgent.get('a')?.speak).toHaveBeenCalledWith('first');
  });

  it('continues to the next message after a failed turn', async () => {
    const failing = controllerOf({
      speak: vi.fn(async () => {
        throw new Error('no TTS model');
      }),
    });
    const { factory, byAgent } = factoryOf(failing);
    const speaker = createMessageSpeaker({ createSpeakTurn: factory });
    speaker.speak('first', 'a');
    await flush();
    speaker.speak('second', 'a');
    await flush();
    expect(byAgent.get('a')?.speak).toHaveBeenCalledTimes(2);
  });

  it('reports busy while a turn is queued or running', async () => {
    let resolveFirst: () => void = () => undefined;
    const first = controllerOf({
      speak: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve;
          }),
      ),
    });
    const { factory } = factoryOf(first);
    const speaker = createMessageSpeaker({ createSpeakTurn: factory });
    speaker.speak('one', 'a');
    await flush();
    expect(speaker.isBusy()).toBe(true);
    resolveFirst();
    await flush();
    expect(speaker.isBusy()).toBe(false);
  });

  it('passes the app-default model + voice to a new agent controller', async () => {
    const { factory } = factoryOf();
    const speaker = createMessageSpeaker({
      createSpeakTurn: factory,
      resolveFallback: () => ({ modelId: 'fish-s1', voiceId: 'ref-42' }),
    });
    speaker.speak('hi', 'agent-7');
    await flush();
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-7',
        fallbackModelId: 'fish-s1',
        fallbackVoiceId: 'ref-42',
      }),
    );
  });

  it('carries the app-default clone sample onto a new agent controller', async () => {
    const { factory } = factoryOf();
    const speaker = createMessageSpeaker({
      createSpeakTurn: factory,
      resolveFallback: () => ({
        modelId: 'fish-s1',
        voiceId: null,
        voiceSampleRef: { bucketId: 'ws', objectKey: 'a.wav' },
        voiceSampleTranscript: 'words',
      }),
    });
    speaker.speak('hi', 'agent-7');
    await flush();
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        fallbackVoiceSampleRef: { bucketId: 'ws', objectKey: 'a.wav' },
        fallbackVoiceSampleTranscript: 'words',
      }),
    );
  });

  it('resolves the fallback fresh per new agent (settings change applies)', async () => {
    const { factory } = factoryOf();
    let fallback: { modelId: string; voiceId: string | null } = { modelId: 'm1', voiceId: 'v1' };
    const speaker = createMessageSpeaker({
      createSpeakTurn: factory,
      resolveFallback: () => fallback,
    });
    speaker.speak('one', 'a');
    await flush();
    fallback = { modelId: 'm2', voiceId: 'v2' };
    speaker.speak('two', 'b');
    await flush();
    expect(factory).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        agentId: 'a',
        fallbackModelId: 'm1',
        fallbackVoiceId: 'v1',
      }),
    );
    expect(factory).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        agentId: 'b',
        fallbackModelId: 'm2',
        fallbackVoiceId: 'v2',
      }),
    );
  });

  it('forgets a cached fallback across reset() (identity switch)', async () => {
    const { factory } = factoryOf();
    let fallback: { modelId: string; voiceId: string | null } = { modelId: 'm1', voiceId: 'v1' };
    const speaker = createMessageSpeaker({
      createSpeakTurn: factory,
      resolveFallback: () => fallback,
    });
    speaker.speak('one', 'a');
    await flush();
    speaker.reset();
    fallback = { modelId: 'm2', voiceId: null };
    speaker.speak('two', 'a');
    await flush();
    expect(factory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        agentId: 'a',
        fallbackModelId: 'm2',
        fallbackVoiceId: null,
      }),
    );
  });

  it('still speaks when the fallback read fails', async () => {
    const { factory } = factoryOf();
    const speaker = createMessageSpeaker({
      createSpeakTurn: factory,
      resolveFallback: () => {
        throw new Error('settings unavailable');
      },
    });
    speaker.speak('hello', 'a');
    await flush();
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'a',
        fallbackModelId: null,
        fallbackVoiceId: null,
      }),
    );
  });
});

describe('createMessageSpeaker.interrupt (barge-in on send)', () => {
  it('skip_current stops the playing controller but leaves queued work', async () => {
    const gate: { resolve?: () => void } = {};
    const first = controllerOf({
      speak: vi.fn(
        () =>
          new Promise<void>((res) => {
            gate.resolve = res;
          }),
      ),
    });
    const second = controllerOf();
    const byAgent = new Map<string, SpeakController>([
      ['a', first],
      ['b', second],
    ]);
    const speaker = createMessageSpeaker({
      createSpeakTurn: ((input: { agentId: string | null }) =>
        byAgent.get(input.agentId ?? '') as SpeakController) as unknown as SpeakTurnFactory,
    });
    speaker.speak('one', 'a');
    speaker.speak('two', 'b');
    await flush();
    speaker.interrupt('skip_current');
    expect(first.cancel).toHaveBeenCalledTimes(1);
    // Resolve the first turn so the drain loop proceeds to the queued reply.
    gate.resolve?.();
    await flush();
    expect(second.speak).toHaveBeenCalledWith('two');
  });

  it('clear_queue stops everything and drops the queue', async () => {
    const gate: { resolve?: () => void } = {};
    const first = controllerOf({
      speak: vi.fn(
        () =>
          new Promise<void>((res) => {
            gate.resolve = res;
          }),
      ),
    });
    const second = controllerOf();
    const byAgent = new Map<string, SpeakController>([
      ['a', first],
      ['b', second],
    ]);
    const speaker = createMessageSpeaker({
      createSpeakTurn: ((input: { agentId: string | null }) =>
        byAgent.get(input.agentId ?? '') as SpeakController) as unknown as SpeakTurnFactory,
    });
    speaker.speak('one', 'a');
    speaker.speak('two', 'b');
    await flush();
    speaker.interrupt('clear_queue');
    gate.resolve?.();
    await flush();
    expect(first.cancel).toHaveBeenCalledTimes(1);
    expect(second.speak).not.toHaveBeenCalled();
  });
});
