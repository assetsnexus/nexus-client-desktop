/**
 * Renderer hook: the connected region's environment (sandbox vs production).
 *
 * Wraps the public `authRegionEnvironment` bridge call (the same
 * `anx.config.environment` command the portal uses). Best-effort and
 * non-blocking: while loading, or when the region cannot be read, the value is
 * null and the UI must fail closed (no sandbox badge) rather than guess.
 *
 * The preload bridge is read defensively (never imported statically) so the
 * hook is safe when `window` / `window.nexus` is absent — tests and any
 * renderer context without the bridge simply get `null`.
 */

import { useEffect, useState } from 'react';
import type { NexusBridge } from '../../shared/ipc.js';
import type { RegionEnvironment } from '../../shared/sandbox-environment.js';

/** The preload bridge, or undefined outside Electron / in tests. */
function getBridge(): NexusBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.nexus;
}

export function useRegionEnvironment(): RegionEnvironment | null {
  const [environment, setEnvironment] = useState<RegionEnvironment | null>(null);

  useEffect(() => {
    const bridge = getBridge();
    if (typeof bridge?.authRegionEnvironment !== 'function') return;
    let cancelled = false;
    void bridge
      .authRegionEnvironment()
      .then((env) => {
        if (!cancelled) setEnvironment(env);
      })
      .catch(() => {
        /* unknown -> fail closed (never falsely claim sandbox) */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return environment;
}
