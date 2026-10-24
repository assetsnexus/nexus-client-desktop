/**
 * Bridge compatibility helpers spec.
 *
 * These exist because the renderer and the Electron preload have different
 * lifecycles: a newer renderer can run against an older preload (an update that
 * did not restart the app), where a bridge method it calls does not exist yet.
 * An unguarded call used to throw inside a React effect and blank the window
 * ("bridge.onCompanionActionRelay is not a function"), so the guards must:
 *  - never throw when the method is missing (or the bridge itself is);
 *  - pass through to the real method and preserve its unsubscribe/return value;
 *  - swallow a method that returns a rejected promise.
 */

import { describe, expect, it, vi } from 'vitest';
import { callBridge, hasBridgeMethod, onBridge } from './bridge-compat.js';

describe('hasBridgeMethod', () => {
  it('is true only for a function on the bridge', () => {
    const bridge = { fn: () => {}, value: 1, notFn: null };
    expect(hasBridgeMethod(bridge, 'fn')).toBe(true);
    expect(hasBridgeMethod(bridge, 'value')).toBe(false);
    expect(hasBridgeMethod(bridge, 'notFn')).toBe(false);
    expect(hasBridgeMethod(bridge, 'missing')).toBe(false);
  });

  it('tolerates a missing / malformed bridge', () => {
    expect(hasBridgeMethod(undefined, 'fn')).toBe(false);
    expect(hasBridgeMethod(null, 'fn')).toBe(false);
    expect(hasBridgeMethod('nope', 'fn')).toBe(false);
  });
});

describe('onBridge', () => {
  it('subscribes and returns the real unsubscribe', () => {
    const off = vi.fn();
    const listener = vi.fn();
    const bridge = { onThing: vi.fn(() => off) };

    const unsub = onBridge<{ n: number }>(bridge, 'onThing', listener);
    expect(bridge.onThing).toHaveBeenCalledWith(listener);
    unsub();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it('returns a no-op unsubscribe when the preload predates the channel', () => {
    // The exact regression: an older preload has no `onCompanionActionRelay`.
    const bridge = { companionAction: () => {} };
    let unsub: () => void = () => {};
    expect(() => {
      unsub = onBridge(bridge, 'onCompanionActionRelay', () => {});
    }).not.toThrow();
    expect(() => unsub()).not.toThrow();
  });

  it('still returns a callable unsubscribe when the real one returns undefined', () => {
    const bridge = { onThing: vi.fn(() => undefined) };
    const unsub = onBridge(bridge, 'onThing', () => {});
    expect(() => unsub()).not.toThrow();
  });

  it('delivers events to the listener', () => {
    const listeners: Array<(p: { ok: boolean }) => void> = [];
    const bridge = {
      onThing: (l: (p: { ok: boolean }) => void) => {
        listeners.push(l);
        return () => {};
      },
    };
    const seen: boolean[] = [];
    onBridge<{ ok: boolean }>(bridge, 'onThing', (p) => seen.push(p.ok));
    listeners[0]!({ ok: true });
    expect(seen).toEqual([true]);
  });
});

describe('callBridge', () => {
  it('passes through args and resolves the real result', async () => {
    const bridge = { doThing: vi.fn(async (a: number, b: string) => `${a}-${b}`) };
    await expect(callBridge(bridge, 'doThing', 'fallback', 7, 'x')).resolves.toBe('7-x');
    expect(bridge.doThing).toHaveBeenCalledWith(7, 'x');
  });

  it('resolves the fallback when the method is missing', async () => {
    await expect(callBridge({}, 'companionPresent', false, {})).resolves.toBe(false);
    await expect(callBridge(undefined, 'companionPushSession', false, {})).resolves.toBe(false);
  });

  it('resolves the fallback when the method rejects, instead of throwing', async () => {
    const bridge = {
      companionPresent: async () => {
        throw new Error('no companion window');
      },
    };
    await expect(callBridge(bridge, 'companionPresent', false, {})).resolves.toBe(false);
  });

  it('resolves the fallback when the method throws synchronously', async () => {
    const bridge = {
      companionAction: () => {
        throw new Error('boom');
      },
    };
    await expect(callBridge(bridge, 'companionAction', false, {})).resolves.toBe(false);
  });
});
