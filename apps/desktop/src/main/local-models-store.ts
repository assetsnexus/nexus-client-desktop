/**
 * Persisted local model instances + routing policy.
 *
 * Plain JSON in `userData` (no secrets that matter — an instance's optional API
 * key is a token for a server the user runs on their own LAN, not a region
 * credential). Everything is validated through the same normalizer the UI uses,
 * so a hand-edited file cannot produce an unusable list.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import type { LocalModelBackend, LocalModelsRoutingPolicy } from '../shared/ipc.js';
import {
  DEFAULT_LOCAL_BACKENDS,
  normalizeLocalBackends,
  normalizeLocalBackend,
} from './local-models.js';

export type LocalModelsConfig = {
  instances: LocalModelBackend[];
  policy: LocalModelsRoutingPolicy;
};

const POLICIES: LocalModelsRoutingPolicy[] = ['first_available', 'least_busy', 'round_robin'];

export type LocalModelsStore = {
  get(): LocalModelsConfig;
  /** Add or replace one instance (by id). Returns the new config. */
  upsert(instance: unknown): LocalModelsConfig;
  remove(id: string): LocalModelsConfig;
  setPolicy(policy: unknown): LocalModelsConfig;
};

function normalizePolicy(raw: unknown, fallback: LocalModelsRoutingPolicy): LocalModelsRoutingPolicy {
  return POLICIES.includes(raw as LocalModelsRoutingPolicy)
    ? (raw as LocalModelsRoutingPolicy)
    : fallback;
}

export function createLocalModelsStore(filePath?: string): LocalModelsStore {
  const path = filePath ?? join(app.getPath('userData'), 'local-models.json');

  const read = (): LocalModelsConfig => {
    const empty: LocalModelsConfig = {
      // Seed with the loopback defaults so a fresh install works out of the box.
      instances: DEFAULT_LOCAL_BACKENDS.map((b) => ({ ...b })),
      policy: 'first_available',
    };
    if (!existsSync(path)) return empty;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      const instances = normalizeLocalBackends(raw.instances);
      return {
        // An explicitly empty list is respected (the user removed everything);
        // only a malformed/absent list falls back to the defaults.
        instances: Array.isArray(raw.instances) ? instances : empty.instances,
        policy: normalizePolicy(raw.policy, empty.policy),
      };
    } catch {
      return empty;
    }
  };

  const write = (value: LocalModelsConfig): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
  };

  return {
    get: read,
    upsert(instance) {
      const normalized = normalizeLocalBackend(instance);
      if (!normalized) throw new Error('A local model instance needs a valid base URL.');
      const current = read();
      const exists = current.instances.some((i) => i.id === normalized.id);
      const instances = exists
        ? current.instances.map((i) => (i.id === normalized.id ? normalized : i))
        : [...current.instances, normalized];
      const next = { ...current, instances };
      write(next);
      return next;
    },
    remove(id) {
      const current = read();
      const next = { ...current, instances: current.instances.filter((i) => i.id !== id) };
      write(next);
      return next;
    },
    setPolicy(policy) {
      const current = read();
      const next = { ...current, policy: normalizePolicy(policy, current.policy) };
      write(next);
      return next;
    },
  };
}
