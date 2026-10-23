/**
 * Renderer view of the preload bridge + shared types.
 * Re-exports the IPC contract so renderer code imports from one place.
 */

import type { DesktopConnectionConfig } from '@nexus/node-core';
import type { NexusBridge } from '../shared/ipc.js';

declare global {
  interface Window {
    nexus: NexusBridge;
  }
}

/** The bridge, guaranteed present in the Electron renderer. */
export const bridge: NexusBridge = window.nexus;

export * from '../shared/ipc.js';
export { stepLabel } from '../shared/logout.js';
export type { LogoutChoice, LogoutReport, LogoutStep } from '../shared/logout.js';
export { DEFAULT_APP_LOCK_SETTINGS, LOCK_TIMEOUT_CHOICES, PIN_MIN_LENGTH } from '../shared/app-lock.js';
export type { AppLockSettings, AppLockState } from '../shared/app-lock.js';
export { DEFAULT_TRAY_APP_SETTINGS, MAX_CUSTOM_TRAY_APPS, isSafeExternalUrl } from '../shared/nexus-apps.js';
export type {
  AppVisibilityMode,
  CustomTrayApp,
  InstalledNexusApp,
  TrayAppGroup,
  TrayAppItem,
  TrayAppSettings,
} from '../shared/nexus-apps.js';
export type { DesktopConnectionConfig };
