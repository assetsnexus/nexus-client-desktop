import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  createGlobalPointerSource,
  createX11PointerSource,
  parseXi2RootPoint,
  parseXdotoolPoint,
  type GlobalPointerSource,
  type SpawnLike,
} from './global-pointer.js';

/** A fake `xinput test-xi2 --root` child: stdout emitter + kill/close control. */
function makeFakeChild() {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding?: (e: string) => void };
  stdout.setEncoding = () => {};
  const child = new EventEmitter() as unknown as {
    stdout: typeof stdout;
    kill: () => void;
    killed: boolean;
  };
  (child as unknown as { stdout: typeof stdout }).stdout = stdout;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return { child, stdout };
}

/** A no-op retry scheduler so tests never leave real timers pending. */
const noTimer = {
  setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
  clearTimer: () => {},
};

describe('parseXi2RootPoint', () => {
  it('parses integer root coordinates', () => {
    expect(parseXi2RootPoint('    root: 1000/500')).toEqual({ x: 1000, y: 500 });
  });

  it('rounds fractional coordinates', () => {
    expect(parseXi2RootPoint('root: 4289.86/947.37')).toEqual({ x: 4290, y: 947 });
  });

  it('ignores non-coordinate lines', () => {
    expect(parseXi2RootPoint('EVENT type 17 (RawMotion)')).toBeNull();
    expect(parseXi2RootPoint('    windows: root 0x221 event 0x221')).toBeNull();
    expect(parseXi2RootPoint('')).toBeNull();
  });
});

describe('parseXdotoolPoint', () => {
  it('parses X/Y from the --shell output', () => {
    expect(parseXdotoolPoint('X=640\nY=480\nSCREEN=0\nWINDOW=1\n')).toEqual({ x: 640, y: 480 });
  });

  it('returns null until both coordinates are present', () => {
    expect(parseXdotoolPoint('X=640\n')).toBeNull();
    expect(parseXdotoolPoint('')).toBeNull();
  });
});

describe('createX11PointerSource', () => {
  it('reports points from the xinput stream, including across split chunks', () => {
    const { child, stdout } = makeFakeChild();
    const spawnImpl = vi.fn(() => child) as unknown as SpawnLike;
    const source = createX11PointerSource({ spawnImpl, env: { DISPLAY: ':0' }, ...noTimer });
    source.start();
    expect(spawnImpl).toHaveBeenCalledWith('xinput', ['test-xi2', '--root'], {
      env: { DISPLAY: ':0' },
    });
    // Streaming only becomes true once a real event arrives.
    expect(source.streaming).toBe(false);
    expect(source.current()).toBeNull();
    // A line split across two chunks must still be parsed as one event.
    stdout.emit('data', 'root: 500/250\nEVENT type 6\n    root: 1200');
    expect(source.current()).toEqual({ x: 500, y: 250 });
    expect(source.streaming).toBe(true);
    stdout.emit('data', '/300\n');
    expect(source.current()).toEqual({ x: 1200, y: 300 });
  });

  it('does not stream without a DISPLAY', () => {
    const spawnImpl = vi.fn() as unknown as SpawnLike;
    const source = createX11PointerSource({ spawnImpl, env: {}, ...noTimer });
    source.start();
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(source.streaming).toBe(false);
    expect(source.current()).toBeNull();
  });

  it('reports not-streaming when the process dies and signals onEnd', () => {
    const { child } = makeFakeChild();
    const onEnd = vi.fn();
    const source = createX11PointerSource({
      spawnImpl: (() => child) as unknown as SpawnLike,
      env: { DISPLAY: ':0' },
      onEnd,
      pollPoint: async () => null,
      ...noTimer,
    });
    source.start();
    (child as unknown as EventEmitter).emit('close');
    expect(source.streaming).toBe(false);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('uses the non-exclusive poll fallback when the exclusive stream is down', async () => {
    // A stale holder: spawn succeeds but the process is closed immediately
    // (BadAccess makes xinput print the error and exit).
    const { child } = makeFakeChild();
    const pollPoint = vi.fn(async () => ({ x: 777, y: 333 }));
    const source = createX11PointerSource({
      spawnImpl: (() => child) as unknown as SpawnLike,
      env: { DISPLAY: ':0' },
      pollPoint,
      ...noTimer,
    });
    source.start();
    expect(source.streaming).toBe(false);
    // First read kicks the fallback poll (async); it lands on the next tick.
    expect(source.current()).toBeNull();
    await Promise.resolve();
    expect(pollPoint).toHaveBeenCalledTimes(1);
    expect(source.current()).toEqual({ x: 777, y: 333 });
  });

  it('does not stack fallback polls while one is in flight', async () => {
    const { child } = makeFakeChild();
    let resolvePoll: (p: { x: number; y: number } | null) => void = () => {};
    const pollPoint = vi.fn(
      () =>
        new Promise<{ x: number; y: number } | null>((resolve) => {
          resolvePoll = resolve;
        }),
    );
    const source = createX11PointerSource({
      spawnImpl: (() => child) as unknown as SpawnLike,
      env: { DISPLAY: ':0' },
      pollPoint,
      ...noTimer,
    });
    source.start();
    source.current();
    source.current();
    source.current();
    expect(pollPoint).toHaveBeenCalledTimes(1);
    resolvePoll({ x: 1, y: 1 });
    // Drain the promise + `.finally` microtask chain.
    await new Promise((r) => setTimeout(r, 0));
    // Once it settles, a new read may poll again.
    source.current();
    expect(pollPoint).toHaveBeenCalledTimes(2);
  });

  it('reschedules the exclusive stream after it dies', () => {
    const setTimer = vi.fn(() => 0 as unknown as ReturnType<typeof setTimeout>);
    const { child } = makeFakeChild();
    const spawnImpl = vi.fn(() => child) as unknown as SpawnLike;
    const source = createX11PointerSource({
      spawnImpl,
      env: { DISPLAY: ':0' },
      pollPoint: async () => null,
      setTimer,
      clearTimer: () => {},
    });
    source.start();
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    (child as unknown as EventEmitter).emit('close');
    expect(setTimer).toHaveBeenCalledTimes(1);
  });

  it('kills the child on stop', () => {
    const { child } = makeFakeChild();
    const source = createX11PointerSource({
      spawnImpl: (() => child) as unknown as SpawnLike,
      env: { DISPLAY: ':0' },
      ...noTimer,
    });
    source.start();
    source.stop();
    expect(child.killed).toBe(true);
    expect(source.streaming).toBe(false);
  });

  it('falls back gracefully when spawn throws', () => {
    const onEnd = vi.fn();
    const source = createX11PointerSource({
      spawnImpl: (() => {
        throw new Error('ENOENT');
      }) as unknown as SpawnLike,
      env: { DISPLAY: ':0' },
      onEnd,
      pollPoint: async () => null,
      ...noTimer,
    });
    expect(() => source.start()).not.toThrow();
    expect(source.streaming).toBe(false);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});

describe('createGlobalPointerSource', () => {
  it('prefers the native stream once it has a point', () => {
    const native: GlobalPointerSource = {
      current: () => ({ x: 800, y: 600 }),
      streaming: true,
      start: vi.fn(),
      stop: vi.fn(),
    };
    const probe = vi.fn(() => ({ x: 0, y: 0 }));
    const source = createGlobalPointerSource({ getCursorPoint: probe, createNative: () => native });
    source.start();
    expect(source.current()).toEqual({ x: 800, y: 600 });
    expect(source.native).toBe(true);
    // The Electron probe is not consulted while the native stream is live.
    expect(probe).not.toHaveBeenCalled();
  });

  it('falls back to the probe only before the native source has a reading', () => {
    const native: GlobalPointerSource = {
      current: () => null,
      streaming: true,
      start: vi.fn(),
      stop: vi.fn(),
    };
    const probe = () => ({ x: 42, y: 24 });
    const source = createGlobalPointerSource({ getCursorPoint: probe, createNative: () => native });
    expect(source.current()).toEqual({ x: 42, y: 24 });
  });

  it('reports native=false when the stream is not available', () => {
    const native: GlobalPointerSource = {
      current: () => null,
      streaming: false,
      start: vi.fn(),
      stop: vi.fn(),
    };
    const source = createGlobalPointerSource({
      getCursorPoint: () => ({ x: 1, y: 2 }),
      createNative: () => native,
    });
    expect(source.native).toBe(false);
  });
});
