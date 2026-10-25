// @vitest-environment jsdom
/**
 * Companion locomotion hook — stage-swap regression cover.
 *
 * Regression: `CompanionView` captured the host input method as a bare value
 * (`const setMoveInput = host.setMoveInput`). The flat stage host is a
 * `CompanionHost` **class instance** whose `setMoveInput` is a prototype method
 * reading `this.controller`, so the capture dropped the receiver. Flipping the
 * avatar to **picture mode** unmounts the 3D canvas -> `avatarHost` becomes
 * `null` -> the effect dependency changes -> React runs the previous cleanup,
 * which calls `clear()` -> the detached method -> `this.controller` on
 * `undefined` -> `Cannot read properties of undefined (reading 'controller')`.
 *
 * The hook must (a) route every input call with the host as receiver, and
 * (b) degrade to a clean no-op when no host is mounted (picture mode).
 */

// `@nexus/character-kit` (pulled in transitively via `locomotion-keys` for the
// gait-speed constants) imports `wlipsync`, whose module body subclasses
// `AudioWorkletNode` at import time. That global only exists in a browser, so a
// minimal stub keeps this spec loadable. Hoisted so it lands before the imports
// below are evaluated (same guard `locomotion-keys.spec.ts` uses).
vi.hoisted(() => {
  const g = globalThis as unknown as { AudioWorkletNode?: unknown };
  if (typeof g.AudioWorkletNode !== 'function') {
    g.AudioWorkletNode = class AudioWorkletNodeStub {};
  }
});

import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanionStageHost } from './character-tools.js';
import { useCompanionLocomotion } from './use-companion-locomotion.js';

/**
 * Stands in for `@nexus/character-kit`'s `CompanionHost`: `setMoveInput` is a
 * prototype method that dereferences `this.controller`, and the stage has no
 * `setAnalogSpeed` (the flat canvas), so the optional call must stay optional.
 */
type MoveInputLike = { x?: number; z?: number; yaw?: number; jump?: boolean };

class FakeCompanionController {
  readonly moveInputs: MoveInputLike[] = [];
  setMoveInput(input: MoveInputLike): void {
    this.moveInputs.push(input);
  }
}

class FakeCompanionHost {
  readonly controller = new FakeCompanionController();
  /** Mirrors the contract's `| null` (a host clears its input with `null`). */
  setMoveInput(input: MoveInputLike | null): void {
    if (!input) return;
    this.controller.setMoveInput(input); // companion-host.ts:744 — reads `this`
  }
}

/**
 * Mounts the hook exactly as `CompanionView` does: the live host is also written
 * into a ref (`hostGetterRef`) so the key handlers can detect a stage swap.
 */
function Harness({
  host,
  enabled = true,
}: {
  host: CompanionStageHost | null;
  enabled?: boolean;
}) {
  const hostRef = useRef<CompanionStageHost | null>(null);
  hostRef.current = host;
  useCompanionLocomotion({ host, hostRef, enabled });
  return null;
}

let container: HTMLDivElement;
let root: Root;
const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  consoleError.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function consoleErrorsMatching(pattern: RegExp): string[] {
  return consoleError.mock.calls
    .map((args) => args.map(String).join(' '))
    .filter((line) => pattern.test(line));
}

describe('useCompanionLocomotion', () => {
  it('does not throw when the stage swaps to picture mode after mount', () => {
    const host = new FakeCompanionHost();
    // Mount the 3D stage: the hook attaches its listeners. Nothing is pushed to
    // the rig until a key is pressed.
    act(() => {
      root.render(<Harness host={host} />);
    });
    expect(host.controller.moveInputs).toEqual([]);

    // Picture mode: the 3D canvas unmounts, so `avatarHost` -> null. React runs
    // the previous effect's cleanup, which clears the input one last time on the
    // (still-alive) host that was driving the rig.
    expect(() =>
      act(() => {
        root.render(<Harness host={null} />);
      }),
    ).not.toThrow();
    expect(host.controller.moveInputs).toEqual([{ x: 0, z: 0, yaw: 0, jump: false }]);

    // React reports a passive-cleanup throw to `console.error` instead of
    // rethrowing from `act` — assert against the reported error text too.
    expect(
      consoleErrorsMatching(/Cannot read properties of undefined \(reading 'controller'\)/),
    ).toEqual([]);
  });

  it('degrade to a no-op with no host mounted (picture mode from the start)', () => {
    expect(() =>
      act(() => {
        root.render(<Harness host={null} />);
      }),
    ).not.toThrow();
    expect(consoleErrorsMatching(/controller/)).toEqual([]);
  });

  it('installs no listeners when disabled (room mode)', () => {
    const host = new FakeCompanionHost();
    act(() => {
      root.render(<Harness host={host} enabled={false} />);
    });
    // No clear() on mount, and a WASD keypress does nothing.
    expect(host.controller.moveInputs).toEqual([]);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    });
    expect(host.controller.moveInputs).toEqual([]);
  });

  it('pushes WASD input to the controller while the stage is live', () => {
    const host = new FakeCompanionHost();
    act(() => {
      root.render(<Harness host={host} />);
    });
    consoleError.mockClear();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    });
    // The trailing entry is the forward input; the leading clear came from mount.
    expect(host.controller.moveInputs.at(-1)).toEqual({ x: 0, z: 1, yaw: 0, jump: false });
    expect(consoleErrorsMatching(/controller/)).toEqual([]);
  });

  it('does not reinstall on an unrelated re-render (a stable ref, not an inline getter)', () => {
    const host = new FakeCompanionHost();
    act(() => {
      root.render(<Harness host={host} />);
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    });
    const pushedBefore = host.controller.moveInputs.length;
    consoleError.mockClear();

    // An unrelated parent re-render (e.g. a transcript update) must not re-run
    // the effect: otherwise the cleanup's clear() would drop the held walk key,
    // and the rig would stutter on every render.
    act(() => {
      root.render(<Harness host={host} />);
    });

    expect(host.controller.moveInputs).toHaveLength(pushedBefore);
    expect(consoleErrorsMatching(/controller/)).toEqual([]);
  });

  it('clears the input on blur so a held key does not walk forever', () => {
    const host = new FakeCompanionHost();
    act(() => {
      root.render(<Harness host={host} />);
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    });
    consoleError.mockClear();
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(host.controller.moveInputs.at(-1)).toEqual({ x: 0, z: 0, yaw: 0, jump: false });
    expect(consoleErrorsMatching(/controller/)).toEqual([]);
  });
});
