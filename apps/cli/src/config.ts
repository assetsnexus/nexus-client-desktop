/**
 * CLI connection config — a small JSON file (`$XDG_CONFIG_HOME/nexus/config.json`
 * or `~/.config/nexus/config.json`). Mirrors the desktop settings store but
 * without Electron. All three connection points are user-overridable and fall
 * back to the shared sandbox defaults in `@nexus/node-core`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  resolveConnectionConfig,
  type DesktopConnectionConfig,
  type ResolvedConnectionConfig,
} from '@nexus/node-core';

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(base, 'nexus', 'config.json');
}

export type ConfigStore = {
  path: string;
  read(): Partial<DesktopConnectionConfig>;
  /** Resolved config with defaults applied. */
  get(): ResolvedConnectionConfig;
  set(patch: Partial<DesktopConnectionConfig>): ResolvedConnectionConfig;
};

export function createConfigStore(path: string = defaultConfigPath()): ConfigStore {
  const read = (): Partial<DesktopConnectionConfig> => {
    if (!existsSync(path)) return {};
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      return raw && typeof raw === 'object' ? (raw as Partial<DesktopConnectionConfig>) : {};
    } catch {
      return {};
    }
  };

  const write = (value: Partial<DesktopConnectionConfig>): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
  };

  return {
    path,
    read,
    get: () => resolveConnectionConfig(read()),
    set(patch) {
      const merged = { ...read(), ...patch };
      write(merged);
      return resolveConnectionConfig(merged);
    },
  };
}
