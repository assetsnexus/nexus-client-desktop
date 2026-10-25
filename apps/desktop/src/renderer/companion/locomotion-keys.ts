/**
 * Companion 3D keyboard locomotion (Deliverable 4).
 *
 * The companion's walkable scene is driven by the character-kit analog input
 * (`CharacterController.setMoveInput` + `setAnalogSpeed`), the same integrator
 * the agent's `character_walk` tool uses — so keys and tools never fight over the
 * rig. This module keeps the key→input mapping **pure** (no DOM, no Three) so the
 * WASD/Shift/Space semantics are unit-testable:
 *
 *  - `W`/`A`/`S`/`D` (and the arrow keys) are strafe/forward in `[-1, 1]`;
 *  - holding `Shift` selects the run gait (`LOCO_RUN_SPEED`) over the walk gait;
 *  - `Space` is a rising-edge jump pulse (a held key must not re-fire).
 *
 * The renderer attaches the listeners and only routes key events here when the
 * user is *not* typing into the composer (see {@link isTypingTarget}).
 */

import {
  LOCO_RUN_SPEED,
  LOCO_WALK_SPEED,
  type MoveInput,
} from '@nexus/character-kit';

/** Keys we own. Everything else is left to the browser / app. */
export const LOCOMOTION_KEY_CODES = [
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ShiftLeft',
  'ShiftRight',
  'Space',
] as const;

/** Decoded key state — the shape the pure mapping reads. */
export type MoveKeys = {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  run: boolean;
};

export const IDLE_MOVE_KEYS: MoveKeys = {
  forward: false,
  back: false,
  left: false,
  right: false,
  jump: false,
  run: false,
};

/** True when a key code is one the companion scene consumes. */
export function isLocomotionKey(code: string): boolean {
  return (LOCOMOTION_KEY_CODES as readonly string[]).includes(code);
}

/**
 * Read the live pressed-key set into decoded state. Both WASD and the arrow
 * keys map to the same axes so a laptop keyboard is enough.
 */
export function readMoveKeys(pressed: ReadonlySet<string>): MoveKeys {
  return {
    forward: pressed.has('KeyW') || pressed.has('ArrowUp'),
    back: pressed.has('KeyS') || pressed.has('ArrowDown'),
    left: pressed.has('KeyA') || pressed.has('ArrowLeft'),
    right: pressed.has('KeyD') || pressed.has('ArrowRight'),
    jump: pressed.has('Space'),
    run: pressed.has('ShiftLeft') || pressed.has('ShiftRight'),
  };
}

/**
 * Decoded keys → the character-kit analog input. `x` is strafe (right positive),
 * `z` is forward (positive). The mapping is camera-relative inside the kit, so
 * the values here stay in screen-intuitive units.
 *
 * `jump` is kept as a held flag: the locomotion tick consumes it as a rising
 * edge, so a held `Space` cannot re-fire mid-air — matching the tool path.
 */
export function moveInputFromKeys(keys: MoveKeys): MoveInput {
  const x = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const z = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
  return { x, z, yaw: 0, jump: keys.jump };
}

/** Walk gait by default; `Shift` selects the run gait. */
export function moveSpeedForKeys(keys: MoveKeys): number {
  return keys.run ? LOCO_RUN_SPEED : LOCO_WALK_SPEED;
}

/** True when nothing is pressed (so the caller can skip a redundant push). */
export function isIdleMoveInput(input: MoveInput): boolean {
  return input.x === 0 && input.z === 0 && !input.jump && input.yaw === 0;
}

/**
 * Whether a key event came from a text field the user is typing into. Locomotion
 * must never steal `W`/`A`/`S`/`D` from the composer, so the handler bails on
 * inputs, textareas, selects and contenteditable hosts.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as { tagName?: unknown; isContentEditable?: unknown };
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable === true;
}
