/**
 * Persisted connection settings.
 *
 * Stored as plain JSON in `userData` (no secrets here — tokens and device keys
 * live in the secure store). All three connection points are user-overridable.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import { resolveConnectionConfig, type DesktopConnectionConfig } from '@nexus/node-core';

export type SettingsStore = {
  getConnectionConfig(): DesktopConnectionConfig;
  setConnectionConfig(patch: Partial<DesktopConnectionConfig>): DesktopConnectionConfig;
};

export function createSettingsStore(filePath?: string): SettingsStore {
  const path = filePath ?? join(app.getPath('userData'), 'settings.json');

  const read = (): Partial<DesktopConnectionConfig> => {
    if (!existsSync(path)) return {};
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
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
    getConnectionConfig() {
      return resolveConnectionConfig(read());
    },
    setConnectionConfig(patch) {
      const merged = { ...read(), ...patch };
      write(merged);
      return resolveConnectionConfig(merged);
    },
  };
}
