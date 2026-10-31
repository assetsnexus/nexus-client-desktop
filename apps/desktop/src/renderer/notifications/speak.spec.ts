import { describe, expect, it, vi } from 'vitest';
import { createMessageSpeaker, type SpeakController } from './speak.js';

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
  return { factory, byAgent };
}

describe('createMessageSpeaker', () => {
  it('speaks the text through a per-agent controller', async () => {
    const { factory, byAgent } = factoryOf();
    const speaker = createMessageSpeaker({ createSpeakTurn: factory });
    speaker.speak('hello', 'agent-1');
    await Promise.resolve();
    await Promise.resolve();
    expect(factory).toHaveBeenCalledWith({ agentId: 'agent-1' });
    expect(byAgent.get('agent-1')?.speak).toHaveBeenCalledWith('hello');
  });

  it('reuses one controller per agent', async () => {
    const { factory } = factoryOf();
    const speaker = createMessageSpeaker({ createSpeakTurn: factory });
    speaker.speak('one', 'agent-1');
    await Promise.resolve();
    await Promise.resolve();
    speaker.speak('two', 'agent-1');
    await Promise.resolve();
    await Promise.resolve();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('ignores empty text', async () => {
    const { factory } = factoryOf();
    const speaker = createMessageSpeaker({ createSpeakTurn: factory });
    speaker.speak('   ', 'agent-1');
    await Promise.resolve();
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
    await Promise.resolve();
    speaker.speak('second', 'a');
    speaker.cancel();
    resolveFirst();
    await Promise.resolve();
    await Promise.resolve();
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
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    speaker.speak('second', 'a');
    await Promise.resolve();
    await Promise.resolve();
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
    await Promise.resolve();
    expect(speaker.isBusy()).toBe(true);
    resolveFirst();
    await Promise.resolve();
    await Promise.resolve();
    expect(speaker.isBusy()).toBe(false);
  });
});
