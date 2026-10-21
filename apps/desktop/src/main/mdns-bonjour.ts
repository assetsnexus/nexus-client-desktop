/**
 * `bonjour-service` mDNS backend (Phase 10).
 *
 * Adapts the `bonjour-service` package (pure-JS, no native build) to the
 * `MdnsBackend` shape `@nexus/asset-agent-discovery` expects. Loaded lazily so a
 * missing optional dependency degrades to "discovery unavailable" instead of
 * breaking app startup.
 */

import type { MdnsBackend, MdnsService } from '@nexus/asset-agent-discovery';

type BonjourInstance = {
  find: (opts: { type: string }, onUp: (service: BonjourService) => void) => unknown;
  destroy?: () => void;
};

type BonjourService = {
  name: string;
  host: string;
  port: number;
  txt?: Record<string, string>;
};

/**
 * Create a live mDNS backend over `bonjour-service`.
 *
 * The module is imported dynamically; if it is not installed the returned
 * backend throws on `browse`, which the discovery manager treats as "no peers".
 */
export function createBonjourBackend(): MdnsBackend {
  let instance: BonjourInstance | null = null;

  return {
    browse(serviceType, onService) {
      // bonjour-service speaks `_anx._tcp` (without the trailing `.local.`).
      const type = serviceType.replace(/\.local\.?$/i, '');
      let cancelled = false;

      void (async () => {
        try {
          const mod = (await import('bonjour-service')) as unknown as {
            Bonjour?: new () => BonjourInstance;
            default?: new () => BonjourInstance;
          };
          const Ctor = mod.Bonjour ?? mod.default;
          if (!Ctor) throw new Error('bonjour-service export missing');
          instance = new Ctor();
          instance.find({ type }, (service: BonjourService) => {
            if (cancelled) return;
            const mapped: MdnsService = {
              name: service.name,
              host: service.host,
              port: service.port,
              txt: service.txt ?? {},
            };
            onService(mapped);
          });
        } catch {
          // No backend: discovery simply yields nothing.
        }
      })();

      return () => {
        cancelled = true;
        try {
          instance?.destroy?.();
        } catch {
          /* ignore teardown errors */
        }
        instance = null;
      };
    },
  };
}
