import { describe, expect, it, vi } from 'vitest';

// `@nexus/character-kit` pulls in `wlipsync`, whose module body subclasses
// `AudioWorkletNode` at import time. That global only exists in a browser, so a
// minimal stub keeps this pure-node spec loadable. Hoisted so it lands before the
// (hoisted) imports below are evaluated.
vi.hoisted(() => {
  const g = globalThis as unknown as { AudioWorkletNode?: unknown };
  if (typeof g.AudioWorkletNode !== 'function') {
    g.AudioWorkletNode = class AudioWorkletNodeStub {};
  }
});

import { LOCO_RUN_SPEED, LOCO_WALK_SPEED } from '@nexus/character-kit';
import {
  IDLE_MOVE_KEYS,
  isIdleMoveInput,
  isLocomotionKey,
  isTypingTarget,
  moveInputFromKeys,
  moveSpeedForKeys,
  readMoveKeys,
} from './locomotion-keys.js';

describe('isLocomotionKey', () => {
  it('owns WASD, the arrow keys, Shift and Space', () => {
    for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ShiftLeft', 'Space']) {
      expect(isLocomotionKey(code)).toBe(true);
    }
  });

  it('leaves typing and shortcuts to the app', () => {
    for (const code of ['KeyQ', 'KeyE', 'Enter', 'Escape', 'MetaLeft', 'Tab']) {
      expect(isLocomotionKey(code)).toBe(false);
    }
  });
});

describe('readMoveKeys', () => {
  it('treats WASD and the matching arrow keys as the same axis', () => {
    expect(readMoveKeys(new Set(['KeyW']))).toEqual({ ...IDLE_MOVE_KEYS, forward: true });
    expect(readMoveKeys(new Set(['ArrowUp']))).toEqual({ ...IDLE_MOVE_KEYS, forward: true });
    expect(readMoveKeys(new Set(['KeyA']))).toEqual({ ...IDLE_MOVE_KEYS, left: true });
    expect(readMoveKeys(new Set(['KeyD']))).toEqual({ ...IDLE_MOVE_KEYS, right: true });
  });

  it('reads either Shift as run and Space as jump', () => {
    expect(readMoveKeys(new Set(['ShiftLeft'])).run).toBe(true);
    expect(readMoveKeys(new Set(['ShiftRight'])).run).toBe(true);
    expect(readMoveKeys(new Set(['Space'])).jump).toBe(true);
  });
});

describe('moveInputFromKeys', () => {
  it('cancels opposite keys on an axis', () => {
    expect(moveInputFromKeys({ ...IDLE_MOVE_KEYS, left: true, right: true })).toMatchObject({
      x: 0,
    });
    expect(moveInputFromKeys({ ...IDLE_MOVE_KEYS, forward: true, back: true })).toMatchObject({
      z: 0,
    });
  });

  it('maps forward to +z and right to +x', () => {
    expect(moveInputFromKeys({ ...IDLE_MOVE_KEYS, forward: true })).toMatchObject({ x: 0, z: 1 });
    expect(moveInputFromKeys({ ...IDLE_MOVE_KEYS, right: true })).toMatchObject({ x: 1, z: 0 });
  });

  it('keeps jump as a held flag (the tick consumes the rising edge)', () => {
    expect(moveInputFromKeys({ ...IDLE_MOVE_KEYS, jump: true })).toMatchObject({ jump: true });
  });
});

describe('moveSpeedForKeys', () => {
  it('walks by default and runs while Shift is held', () => {
    expect(moveSpeedForKeys(IDLE_MOVE_KEYS)).toBe(LOCO_WALK_SPEED);
    expect(moveSpeedForKeys({ ...IDLE_MOVE_KEYS, run: true })).toBe(LOCO_RUN_SPEED);
  });
});

describe('isIdleMoveInput', () => {
  it('is true only for a fully neutral input', () => {
    expect(isIdleMoveInput(moveInputFromKeys(IDLE_MOVE_KEYS))).toBe(true);
    expect(isIdleMoveInput(moveInputFromKeys({ ...IDLE_MOVE_KEYS, jump: true }))).toBe(false);
    expect(isIdleMoveInput({ x: 0, z: 0, yaw: 0, jump: false })).toBe(true);
  });
});

describe('isTypingTarget', () => {
  it('bails on input, textarea, select and contenteditable hosts', () => {
    expect(isTypingTarget({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'textarea' } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'SELECT' } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ isContentEditable: true } as unknown as EventTarget)).toBe(true);
  });

  it('allows the scene and a plain div', () => {
    expect(isTypingTarget({ tagName: 'CANVAS' } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget({ tagName: 'DIV' } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
