/**
 * Bridge compatibility helpers.
 *
 * The renderer bundle and the Electron **preload** are built separately and live
 * on different lifecycles: the preload is read by the main process at startup,
 * while the renderer can be re-served (dev HMR) or re-read from disk on a reload
 * without restarting the app. When the renderer is newer than the running preload,
 * a bridge method it calls does not exist yet, and an *unguarded* call throws
 * inside a React effect / render — which unmounts the whole tree behind the
 * `ErrorBoundary` ("bridge.onCompanionActionRelay is not a function").
 *
 * Every bridge method added after the initial release must therefore be reached
 * through these helpers: a preload that predates the feature then only disables
 * that feature, and never the app. A restart still enables it (the fresh preload
 * exposes the method); the helpers just make the interim state harmless.
 */

/** The shape of `window.nexus` as far as these helpers care. */
type BridgeLike = Record<string, unknown>;

/** True when the running preload actually exposes `method` as a function. */
export function hasBridgeMethod(bridge: unknown, method: string): boolean {
  return typeof (bridge as BridgeLike | null | undefined)?.[method] === 'function';
}

/**
 * Subscribe to a bridge event only when the preload exposes it. Returns a no-op
 * unsubscribe otherwise, so effect cleanup can call the result unconditionally
 * and an older preload can never throw here.
 */
export function onBridge<L>(
  bridge: unknown,
  method: string,
  listener: (payload: L) => void,
): () => void {
  const fn = (bridge as BridgeLike | null | undefined)?.[method];
  if (typeof fn !== 'function') return () => {};
  const off = (fn as (l: (payload: L) => void) => unknown).call(bridge, listener);
  return typeof off === 'function' ? (off as () => void) : () => {};
}

/**
 * Invoke a bridge method when the preload exposes it, resolving `fallback` when
 * it does not (an older preload) or when the handler is momentarily unavailable
 * (e.g. no companion window is open). Always resolves, never throws.
 */
export function callBridge<T>(
  bridge: unknown,
  method: string,
  fallback: T,
  ...args: unknown[]
): Promise<T> {
  const fn = (bridge as BridgeLike | null | undefined)?.[method];
  if (typeof fn !== 'function') return Promise.resolve(fallback);
  try {
    return Promise.resolve((fn as (...a: unknown[]) => unknown).apply(bridge, args) as Promise<T>).catch(
      () => fallback,
    );
  } catch {
    return Promise.resolve(fallback);
  }
}
