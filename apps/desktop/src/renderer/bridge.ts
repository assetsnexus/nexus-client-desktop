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
export type { DesktopConnectionConfig };
