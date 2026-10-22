/**
 * Renderer hook: the connected region's environment (sandbox vs production).
 *
 * Wraps the public `authRegionEnvironment` bridge call (the same
 * `anx.config.environment` command the portal uses). Best-effort and
 * non-blocking: while loading, or when the region cannot be read, the value is
 * null and the UI must fail closed (no sandbox badge) rather than guess.
 */

import { useEffect, useState } from 'react';
import { bridge } from '../bridge.js';
import type { RegionEnvironment } from '../../shared/sandbox-environment.js';

export function useRegionEnvironment(): RegionEnvironment | null {
  const [environment, setEnvironment] = useState<RegionEnvironment | null>(null);

  useEffect(() => {
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
