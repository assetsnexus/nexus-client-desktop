import { describe, expect, it, vi } from 'vitest';
import { createVoiceLifecycle, type LocalEngine } from '../lifecycle.js';

function makeEngine(id: string, kind: 'stt' | 'tts' = 'stt'): LocalEngine & {
  load: ReturnType<typeof vi.fn>;
  unload: ReturnType<typeof vi.fn>;
} {
  return {
    id,
    kind,
    load: vi.fn(async () => {}),
    unload: vi.fn(async () => {}),
  };
}

describe('createVoiceLifecycle', () => {
  it('loads on acquire and unloads after the idle timeout', async () => {
    let now = 1_000;
    const engine = makeEngine('whisper');
    const lc = createVoiceLifecycle({
      engines: [engine],
      policy: { idleTimeoutMs: 100, minLoadedMs: 0 },
      now: () => now,
    });

    const afterAcquire = await lc.acquire('whisper');
    expect(afterAcquire.state).toBe('ready');
    expect(engine.load).toHaveBeenCalledTimes(1);
    expect(afterAcquire.unloadAtMs).toBe(1_100);

    // Not idle yet.
    now = 1_050;
    let ticked = await lc.tick();
    expect(engine.unload).not.toHaveBeenCalled();
    expect(ticked[0].state).toBe('ready');

    now = 1_101;
    ticked = await lc.tick();
    expect(engine.unload).toHaveBeenCalledTimes(1);
    expect(ticked[0].state).toBe('unloaded');
  });

  it('touch resets the idle timer without reloading', async () => {
    let now = 0;
    const engine = makeEngine('whisper');
    const lc = createVoiceLifecycle({
      engines: [engine],
      policy: { idleTimeoutMs: 100, minLoadedMs: 0 },
      now: () => now,
    });
    await lc.acquire('whisper');
    now = 90;
    lc.touch('whisper');
    now = 150; // past the original deadline, before the touched one
    await lc.tick();
    expect(engine.unload).not.toHaveBeenCalled();
    expect(engine.load).toHaveBeenCalledTimes(1); // acquiring an already-ready engine is a touch
  });

  it('reuses a ready engine on re-acquire', async () => {
    const engine = makeEngine('whisper');
    const lc = createVoiceLifecycle({ engines: [engine] });
    await lc.acquire('whisper');
    await lc.acquire('whisper');
    expect(engine.load).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent acquires', async () => {
    const engine = makeEngine('whisper');
    let resolveLoad!: () => void;
    engine.load.mockImplementation(() => new Promise<void>((r) => (resolveLoad = r)));
    const lc = createVoiceLifecycle({ engines: [engine] });
    const p1 = lc.acquire('whisper');
    const p2 = lc.acquire('whisper');
    resolveLoad();
    const [a, b] = await Promise.all([p1, p2]);
    expect(a.state).toBe('ready');
    expect(b.state).toBe('ready');
    expect(engine.load).toHaveBeenCalledTimes(1);
  });

  it('surfaces load failures as an error state and does not schedule unload', async () => {
    const engine = makeEngine('whisper');
    engine.load.mockRejectedValue(new Error('CUDA out of memory'));
    const lc = createVoiceLifecycle({ engines: [engine] });
    const snap = await lc.acquire('whisper');
    expect(snap.state).toBe('error');
    expect(snap.error).toBe('CUDA out of memory');
    expect(snap.unloadAtMs).toBeNull();
  });

  it('returns an error snapshot for an unknown engine instead of throwing', async () => {
    const lc = createVoiceLifecycle({ engines: [] });
    const snap = await lc.acquire('ghost');
    expect(snap.state).toBe('error');
    expect(snap.error).toMatch(/Unknown/);
    expect(lc.get('ghost')).toBeNull();
  });

  it('release unloads immediately; releaseAll unloads everything', async () => {
    const stt = makeEngine('stt', 'stt');
    const tts = makeEngine('tts', 'tts');
    const lc = createVoiceLifecycle({ engines: [stt, tts] });
    await lc.acquire('stt');
    await lc.acquire('tts');
    const released = await lc.releaseAll();
    expect(released.every((s) => s.state === 'unloaded')).toBe(true);
    expect(stt.unload).toHaveBeenCalledTimes(1);
    expect(tts.unload).toHaveBeenCalledTimes(1);
  });

  it('respects the minimum loaded duration to avoid thrashing', async () => {
    let now = 1_000;
    const engine = makeEngine('whisper');
    const lc = createVoiceLifecycle({
      engines: [engine],
      policy: { idleTimeoutMs: 10, minLoadedMs: 10_000 },
      now: () => now,
    });
    await lc.acquire('whisper');
    now = 1_100; // idle past the timeout, but loaded only 100ms
    await lc.tick();
    expect(engine.unload).not.toHaveBeenCalled();
    now = 11_100;
    await lc.tick();
    expect(engine.unload).toHaveBeenCalledTimes(1);
  });

  it('snapshot exposes all engine states', async () => {
    const lc = createVoiceLifecycle({ engines: [makeEngine('stt', 'stt'), makeEngine('tts', 'tts')] });
    await lc.acquire('stt');
    const ids = lc.snapshot().map((s) => s.id);
    expect(ids).toEqual(['stt', 'tts']);
  });
});
