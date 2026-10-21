/**
 * JSON persistence for the multi-identity store (Phase 9).
 *
 * Deliberately file-based and injectable so the Electron main process can point
 * it at `userData` while tests use a temp dir. Tokens live in the secure store on
 * a real install; this file keeps the account/identity *index* (which is what the
 * switcher UI renders) and accepts a redaction callback so a caller can strip
 * tokens before persisting if it prefers to keep only the index on disk.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  createIdentityStoreState,
  pruneExpired,
  type IdentityStoreState,
} from './store.js';

export type IdentityPersistenceOptions = {
  filePath: string;
  /** Transform the state before it is written (e.g. strip tokens). */
  redact?: (state: IdentityStoreState) => IdentityStoreState;
  /** Injected clock for expiry pruning on load. */
  now?: () => Date;
};

export type IdentityPersistence = ReturnType<typeof createIdentityPersistence>;

export function createIdentityPersistence(options: IdentityPersistenceOptions) {
  const now = options.now ?? (() => new Date());

  function load(): IdentityStoreState {
    if (!existsSync(options.filePath)) return createIdentityStoreState();
    try {
      const raw = JSON.parse(readFileSync(options.filePath, 'utf8')) as Partial<IdentityStoreState>;
      return pruneExpired(createIdentityStoreState(raw), now());
    } catch {
      return createIdentityStoreState();
    }
  }

  function save(state: IdentityStoreState): IdentityStoreState {
    const value = options.redact ? options.redact(state) : state;
    mkdirSync(dirname(options.filePath), { recursive: true });
    writeFileSync(options.filePath, JSON.stringify(value, null, 2), 'utf8');
    return value;
  }

  return { load, save };
}
