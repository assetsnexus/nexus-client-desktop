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
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings } from '../shared/ipc.js';
import { DEFAULT_APP_LOCK_SETTINGS, normalizeAppLockSettings, type AppLockSettings } from '../shared/app-lock.js';

/**
 * Desktop UI preferences that are not secrets. `locale` is a BCP-47-ish tag
 * (`en`, `de`, …); the renderer validates it against the locales it ships and
 * falls back to the OS locale when it does not recognise the value.
 * `notifications` is validated here so a hand-edited settings file can never
 * produce an invalid card mode.
 */
export type UiSettings = {
  locale: string | null;
  notifications: NotificationSettings;
  /** Last picked home country on the login screen (ISO 3166-1 alpha-2). */
  loginCountry: string | null;
  /** App PIN inactivity-lock preferences (the PIN itself lives in the secure store). */
  appLock: AppLockSettings;
};

export { DEFAULT_NOTIFICATION_SETTINGS };

export type SettingsStore = {
  getConnectionConfig(): DesktopConnectionConfig;
  setConnectionConfig(patch: Partial<DesktopConnectionConfig>): DesktopConnectionConfig;
  getUiSettings(): UiSettings;
  setUiSettings(patch: Partial<UiSettings>): UiSettings;
};

type PersistedSettings = Partial<DesktopConnectionConfig> & { ui?: Partial<UiSettings> };

export function createSettingsStore(filePath?: string): SettingsStore {
  const path = filePath ?? join(app.getPath('userData'), 'settings.json');

  const read = (): PersistedSettings => {
    if (!existsSync(path)) return {};
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      return raw && typeof raw === 'object' ? (raw as PersistedSettings) : {};
    } catch {
      return {};
    }
  };

  const write = (value: PersistedSettings): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
  };

  const readUi = (raw: PersistedSettings): UiSettings => {
    const ui = raw.ui ?? {};
    return {
      locale: typeof ui.locale === 'string' && ui.locale.trim() ? ui.locale.trim() : null,
      notifications: readNotificationSettings(ui.notifications),
      loginCountry:
        typeof ui.loginCountry === 'string' && /^[A-Za-z]{2}$/.test(ui.loginCountry.trim())
          ? ui.loginCountry.trim().toUpperCase()
          : null,
      appLock: normalizeAppLockSettings(ui.appLock ?? DEFAULT_APP_LOCK_SETTINGS),
    };
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
    getUiSettings() {
      return readUi(read());
    },
    setUiSettings(patch) {
      const current = read();
      const merged: UiSettings = { ...readUi(current), ...patch };
      // Re-validate: the patch may come from a renderer with a bad value.
      const next = readUi({ ...current, ui: merged });
      write({ ...current, ui: next });
      return next;
    },
  };
}

/**
 * Coerce a persisted/patched notifications block to valid values, falling back
 * per-field to the defaults. Unknown keys are dropped so the file stays clean.
 */
export function readNotificationSettings(raw: unknown): NotificationSettings {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const bool = (key: keyof NotificationSettings): boolean =>
    typeof value[key] === 'boolean'
      ? (value[key] as boolean)
      : (DEFAULT_NOTIFICATION_SETTINGS[key] as boolean);
  return {
    enabled: bool('enabled'),
    cardMode: value.cardMode === 'title_only' ? 'title_only' : 'full',
    showSender: bool('showSender'),
    showPreview: bool('showPreview'),
    sound: bool('sound'),
    suppressWhenLocked: bool('suppressWhenLocked'),
  };
}
