/**
 * OS-global pointer source for companion gaze.
 *
 * Why this exists: on X11, Electron's `screen.getCursorScreenPoint()` only
 * refreshes while one of the app's own windows is **focused**. The moment focus
 * moves to any other application, Electron stops receiving motion events and
 * every subsequent read returns the *last* coordinate — so the avatar's gaze
 * freezes the instant the mouse leaves the app. That defeats the whole point of
 * an always-on-screen companion that should follow the pointer everywhere.
 *
 * The X server, by contrast, always knows the true pointer position. `xinput
 * test-xi2 --root` streams raw/absolute motion events for the whole screen,
 * independent of focus, window, or which app is active. We run it once, keep the
 * last known position, and read it at the sampler cadence.
 *
 * This is deliberately dependency-free and injectable so it can be unit tested
 * without spawning a real process, and it always falls back to Electron's own
 * cursor probe when the stream is unavailable (non-X11, missing `xinput`, or a
 * spawn failure) so nothing regresses on platforms where Electron already works.
 *
 * IMPORTANT — the XI2 root selection is **exclusive**: only one client at a time
 * may select raw-motion events on the root window, and a *stale* `xinput
 * test-xi2 --root` left behind by a previous run (e.g. a crashed/killed app)
 * makes every new spawn fail with `BadAccess`. That silently downgrades gaze to
 * the freezing Electron probe. To stay reliable:
 *   1. If the stream dies, retry it on a backoff instead of giving up forever.
 *   2. If it keeps failing, fall back to a focus-independent `xdotool` poll
 *      (used by the sampler itself), which is not exclusive.
 *   3. Never leave a child holding the selection when we stop.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export type PointerPoint = { x: number; y: number };

/** A running native pointer stream that can be read synchronously. */
export type GlobalPointerSource = {
  /** Latest known pointer position, or null before the first event. */
  current(): PointerPoint | null;
  /** True when the native stream is live (not the fallback probe). */
  readonly streaming: boolean;
  start(): void;
  stop(): void;
};

/**
 * Parse one `root: X/Y` line from `xinput test-xi2 --root`.
 *
 * XI2 prints absolute (root) coordinates for Motion and RawMotion events; either
 * can carry fractional values. Returns null for any other line (event headers,
 * `windows:` detail lines, etc.).
 */
export function parseXi2RootPoint(line: string): PointerPoint | null {
  const match = /^\s*root:\s*(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\s*$/.exec(line);
  if (!match) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options?: { env?: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams;

/**
 * Parse the stdout of `xdotool getmouselocation --shell`, which prints one
 * `KEY=VALUE` per line (`X=..`, `Y=..`, `SCREEN=..`, `WINDOW=..`). Returns null
 * until both coordinates are present.
 */
export function parseXdotoolPoint(output: string): PointerPoint | null {
  const xm = /(?:^|\n)\s*X=(-?\d+)/.exec(output);
  const ym = /(?:^|\n)\s*Y=(-?\d+)/.exec(output);
  if (!xm || !ym) return null;
  const x = Number(xm[1]);
  const y = Number(ym[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

export type X11PointerSourceOptions = {
  /** Overridable for tests; defaults to `node:child_process`'s `spawn`. */
  spawnImpl?: SpawnLike;
  /** Overridable for tests; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Notified once if the stream ends/dies so callers can fall back. */
  onEnd?: () => void;
  /**
   * Read the pointer without the exclusive XI2 selection (defaults to
   * `xdotool getmouselocation --shell`). Returns null when unavailable. The
   * sampler uses this while the XI2 stream is down so gaze keeps tracking even
   * when a stale holder blocks `xinput`.
   */
  pollPoint?: () => Promise<PointerPoint | null>;
  /** Retry delay for the XI2 stream after it dies (ms). Defaults to 2000. */
  retryDelayMs?: number;
  /** Overridable for tests; defaults to `setTimeout` / `clearTimeout`. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
};

/** One-shot `xdotool getmouselocation`, used as a non-exclusive fallback read. */
function xdotoolPoll(spawnImpl: SpawnLike, env: NodeJS.ProcessEnv): Promise<PointerPoint | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (point: PointerPoint | null) => {
      if (settled) return;
      settled = true;
      resolve(point);
    };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnImpl('xdotool', ['getmouselocation', '--shell'], { env });
    } catch {
      done(null);
      return;
    }
    let out = '';
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on?.('data', (data: string | Buffer) => {
      out += typeof data === 'string' ? data : data.toString('utf8');
    });
    child.once?.('error', () => done(null));
    child.once?.('close', () => done(parseXdotoolPoint(out)));
    // A wedged xdotool must not stall the sampler.
    const t = setTimeout(() => {
      try {
        child.kill?.();
      } catch {
        /* ignore */
      }
      done(null);
    }, 250);
    if (typeof (t as { unref?: () => void }).unref === 'function') {
      ;(t as { unref: () => void }).unref();
    }
  });
}

/**
 * Build an X11 pointer source backed by `xinput test-xi2 --root` with a
 * non-exclusive `xdotool` fallback.
 *
 * The stream is started lazily. If it cannot start (no `DISPLAY`, missing tool,
 * spawn error, or the exclusive selection already held) it retries on a backoff
 * while `current()` returns a fresh `xdotool` reading, so gaze never silently
 * degrades to the freezing Electron probe. Callers still keep their own probe as
 * the last resort.
 */
export function createX11PointerSource(options: X11PointerSourceOptions = {}): GlobalPointerSource {
  const spawnImpl = options.spawnImpl ?? (spawn as unknown as SpawnLike);
  const env = options.env ?? process.env;
  const onEnd = options.onEnd;
  const pollPoint = options.pollPoint ?? (() => xdotoolPoll(spawnImpl, env));
  const retryDelayMs = options.retryDelayMs ?? 2000;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h));

  let child: ChildProcessWithoutNullStreams | null = null;
  let last: PointerPoint | null = null;
  let streaming = false;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  /** In-flight fallback poll, so a slow sampler doesn't stack process spawns. */
  let pollInFlight = false;
  /** Tail of the line currently being assembled (chunks split mid-line). */
  let pending = '';

  const consume = (chunk: string): void => {
    pending += chunk;
    let index = pending.indexOf('\n');
    while (index !== -1) {
      const point = parseXi2RootPoint(pending.slice(0, index));
      if (point) {
        last = point;
        streaming = true;
      }
      pending = pending.slice(index + 1);
      index = pending.indexOf('\n');
    }
    // Guard against unbounded growth if the tool never newlines.
    if (pending.length > 4096) pending = pending.slice(-64);
  };

  const scheduleRetry = (): void => {
    if (stopped || retry) return;
    retry = setTimer(() => {
      retry = null;
      startStream();
    }, retryDelayMs);
    if (typeof (retry as { unref?: () => void }).unref === 'function') {
      ;(retry as { unref: () => void }).unref();
    }
  };

  function startStream(): void {
    if (child || stopped) return;
    // Only meaningful where an X server is reachable.
    if (!env.DISPLAY) {
      streaming = false;
      return;
    }
    let spawned: ChildProcessWithoutNullStreams;
    try {
      spawned = spawnImpl('xinput', ['test-xi2', '--root'], { env });
    } catch {
      streaming = false;
      onEnd?.();
      scheduleRetry();
      return;
    }
    child = spawned;
    pending = '';
    spawned.stdout?.setEncoding?.('utf8');
    spawned.stdout?.on?.('data', (data: string | Buffer) => {
      consume(typeof data === 'string' ? data : data.toString('utf8'));
    });
    // A dead/rejected stream must not be treated as authoritative: retry it, and
    // until it is live the sampler reads the non-exclusive `xdotool` fallback.
    const finish = () => {
      if (child !== spawned) return;
      child = null;
      streaming = false;
      onEnd?.();
      scheduleRetry();
    };
    spawned.once?.('error', finish);
    spawned.once?.('close', finish);
    spawned.once?.('exit', finish);
  }

  return {
    get streaming() {
      return streaming;
    },
    current() {
      // While the exclusive stream is live it is authoritative. Otherwise kick a
      // non-exclusive `xdotool` read (returning the previous reading until it
      // lands) so gaze keeps tracking under a stale XI2 holder.
      if (streaming) return last;
      if (!stopped && !pollInFlight) {
        pollInFlight = true;
        void pollPoint()
          .then((point) => {
            if (!stopped && point) last = point;
          })
          .catch(() => {
            /* fallback read is best-effort */
          })
          .finally(() => {
            pollInFlight = false;
          });
      }
      return last;
    },
    start() {
      startStream();
    },
    stop() {
      stopped = true;
      if (retry) {
        clearTimer(retry);
        retry = null;
      }
      const dying = child;
      child = null;
      streaming = false;
      last = null;
      pending = '';
      try {
        dying?.kill?.();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Resolve the best available pointer source: the native X11 stream when it can
 * run, otherwise the supplied Electron cursor probe. The returned source is a
 * stable object — it flips to the probe automatically if the stream later dies.
 */
export function createGlobalPointerSource(options: {
  /** Electron scan fallback (e.g. `screen.getCursorScreenPoint`). */
  getCursorPoint: () => PointerPoint;
  /** Overridable for tests; defaults to {@link createX11PointerSource}. */
  createNative?: () => GlobalPointerSource;
}): { current(): PointerPoint; start(): void; stop(): void; readonly native: boolean } {
  const native = (options.createNative ?? (() => createX11PointerSource()))();

  return {
    get native() {
      return native.streaming;
    },
    current() {
      // Before the first native event (or after the stream died) fall back to
      // Electron, which is correct at least while one of our windows has focus.
      return native.current() ?? options.getCursorPoint();
    },
    start() {
      native.start();
    },
    stop() {
      native.stop();
    },
  };
}
