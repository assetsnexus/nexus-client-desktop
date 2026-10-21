/**
 * File-backed secure store for the CLI.
 *
 * The desktop uses Electron `safeStorage`; the CLI has no OS keychain binding
 * out of the box, so secrets live in a user-only (`0600`) JSON file under the
 * config dir. This is deliberately the same {@link SecureStore} interface the
 * desktop implements, so `@nexus/node-core` code is reused unchanged.
 *
 * Security note: tokens never go to stdout and the file is created `0600`.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createMemorySecureStore, type SecureStore } from '@nexus/node-core';
import { defaultConfigPath } from './config.js';

export function defaultSecretsPath(configPath: string = defaultConfigPath()): string {
  return join(dirname(configPath), 'secrets.json');
}

export function createFileSecureStore(path: string = defaultSecretsPath()): SecureStore {
  const read = (): Record<string, string> => {
    if (!existsSync(path)) return {};
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      return raw && typeof raw === 'object' ? (raw as Record<string, string>) : {};
    } catch {
      return {};
    }
  };

  const write = (value: Record<string, string>): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      /* best effort on platforms without mode bits */
    }
  };

  return {
    async get(key) {
      const value = read()[key];
      return typeof value === 'string' ? value : null;
    },
    async set(key, value) {
      write({ ...read(), [key]: value });
    },
    async delete(key) {
      const all = read();
      delete all[key];
      write(all);
    },
  };
}

/** Pick a file store, or an in-memory one when `--ephemeral` was passed. */
export function createCliSecureStore(ephemeral: boolean, path?: string): SecureStore {
  return ephemeral ? createMemorySecureStore() : createFileSecureStore(path);
}
