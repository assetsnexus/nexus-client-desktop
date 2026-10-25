/**
 * Companion WASD / Shift / Space locomotion (Deliverable 4).
 *
 * Attaches the window key listeners that drive the walkable scene through the
 * shared analog-input integrator, and owns the pressed-key refs the handlers
 * read. Extracted from `CompanionView` so the stage-swap guard (the host is a
 * *class instance* whose methods read `this`) is unit-testable without
 * rendering the whole immersive companion window.
 *
 * The keyboard only drives this companion's own walkable scene; the flat avatar
 * stage has no ground plane, so the listeners are inert without `setMoveInput`,
 * and room mode passes `enabled: false` because the shared room stage owns the
 * camera build. Key events are filtered so the composer keeps typing (`W` in a
 * text field must not walk the rig) and so a held key does not keep walking
 * after the window loses focus.
 *
 * `Space` stays a held flag: the locomotion tick consumes it as a rising edge
 * and the animator plays the `jump` clip on the edge, so a held key cannot
 * re-fire or leave the rig stuck airborne.
 *
 * ## Why the input method is bound
 *
 * The stage host is a `CompanionHost` instance (`@nexus/character-kit`) whose
 * `setMoveInput` is a prototype method that dereferences `this.controller`.
 * Capturing it as a bare value (`const setMoveInput = host.setMoveInput`) drops
 * its receiver, so a later call — including this effect's **cleanup**, which runs
 * the moment the stage swaps to picture mode and the host becomes `null` —
 * dereferences `this.controller` on `undefined` and throws
 * `Cannot read properties of undefined (reading 'controller')`.
 *
 * The fix is `host.setMoveInput.bind(host)`: it preserves the
 * intended semantics (capture the guarded method, no re-narrowing per keypress)
 * without swallowing genuine 3D errors. A no-op stub host was rejected — it would
 * mask real controller failures.
 */

import { useEffect, useRef } from 'react';
import type { CompanionStageHost } from './character-tools.js';
import {
  IDLE_MOVE_KEYS,
  isIdleMoveInput,
  isLocomotionKey,
  isTypingTarget,
  moveInputFromKeys,
  moveSpeedForKeys,
  readMoveKeys,
  type MoveKeys,
} from './locomotion-keys.js';

export type UseCompanionLocomotionArgs = {
  /**
   * The mounted 3D host (`roomHost ?? avatarHost`). `null` in picture mode, so
   * the hook installs no listeners at all — nothing to clear, nothing to throw.
   */
  host: CompanionStageHost | null;
  /**
   * The same host behind a **stable ref**. Pass the ref itself, not a fresh
   * getter arrow: a new function identity each render would re-run the effect
   * every render, and the cleanup's `clear()` would drop a held walk key
   * mid-motion. A key event that races a stage swap is dropped by comparing
   * `hostRef.current` against the host the listeners were installed for.
   */
  hostRef: { readonly current: CompanionStageHost | null };
  /**
   * Whether keyboard locomotion should be active at all. Room mode passes `false`
   * because the shared room stage drives its occupants through `ClusterRoomViewer`
   * (build/party camera); a companion window must not steer a shared avatar.
   */
  enabled: boolean;
};

/**
 * Attach / detach the locomotion listeners. Returns nothing; the pressed-key
 * state lives inside the hook so a swap fully resets it.
 */
export function useCompanionLocomotion({
  host,
  hostRef,
  enabled,
}: UseCompanionLocomotionArgs): void {
  /** Decoded key state, kept in a ref so the handlers do not re-render per keypress. */
  const moveKeysRef = useRef<MoveKeys>({ ...IDLE_MOVE_KEYS });
  /** Live pressed key codes, cleared on blur. */
  const pressedKeysRef = useRef<Set<string>>(new Set());
  /** Whether a non-idle input is currently pushed (skips redundant no-op pushes). */
  const moveInputPushedRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    if (!host?.setMoveInput) return;
    // Capture the guarded method **bound to its receiver**: `setMoveInput` reads
    // `this.controller`, and `clear()` below is also reachable from the effect
    // cleanup (the 3D -> picture stage swap), so an unbound capture throws.
    const setMoveInput = host.setMoveInput.bind(host);
    const push = () => {
      if (hostRef.current !== host) return;
      const keys = moveKeysRef.current;
      host.setAnalogSpeed?.(moveSpeedForKeys(keys));
      const input = moveInputFromKeys(keys);
      // Skip a redundant no-op push (every frame of a held idle key).
      if (isIdleMoveInput(input) && !moveInputPushedRef.current) return;
      moveInputPushedRef.current = !isIdleMoveInput(input);
      setMoveInput(input);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isLocomotionKey(e.code) || isTypingTarget(e.target)) return;
      // Keep Space from scrolling and WASD from any default page pan.
      e.preventDefault();
      moveKeysRef.current = readMoveKeys(pressedKeysRef.current.add(e.code));
      push();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!isLocomotionKey(e.code)) return;
      pressedKeysRef.current.delete(e.code);
      moveKeysRef.current = readMoveKeys(pressedKeysRef.current);
      push();
    };
    // Losing focus clears the input so a held key does not walk the rig forever.
    const clear = () => {
      pressedKeysRef.current.clear();
      moveKeysRef.current = { ...IDLE_MOVE_KEYS };
      setMoveInput({ x: 0, z: 0, yaw: 0, jump: false });
      moveInputPushedRef.current = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', clear);
      clear();
    };
  }, [host, hostRef, enabled]);
}
