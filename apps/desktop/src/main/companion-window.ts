/**
 * Immersive companion window (Phase 7a, main process).
 *
 * Pops a single agent conversation into its own `BrowserWindow` with the full
 * 3D/VRM avatar + live voice, like a video call. One companion per contact: a
 * second open reuses (and focuses) the existing window.
 *
 * The window is a normal renderer with the same preload bridge — the launch is
 * carried in the URL hash, resolving the live session (token, region) exactly
 * like the main window. Nothing sensitive is placed in the hash.
 */

import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { buildCompanionHash, COMPANION_DEFAULT_SIZE, type CompanionLaunch } from '../shared/companion.js';
export type CompanionWindowOptions = {
  /** Resolve the renderer base URL (dev server or file:// index.html). */
  resolveRendererUrl: () => string;
  /** Preload script path. */
  preloadPath: string;
  /** Called after a companion window closes. */
  onClosed?: (contactId: string) => void;
};

export type CompanionWindowManager = ReturnType<typeof createCompanionWindowManager>;

export function createCompanionWindowManager(options: CompanionWindowOptions) {
  const windows = new Map<string, BrowserWindow>();

  function open(launch: CompanionLaunch): { opened: boolean; contactId: string } {
    if (!launch?.contactId) throw new Error('companion launch requires a contactId');

    const existing = windows.get(launch.contactId);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return { opened: false, contactId: launch.contactId };
    }

    const { width, height } = COMPANION_DEFAULT_SIZE;
    const display = screen.getPrimaryDisplay().workAreaSize;
    const win = new BrowserWindow({
      width: Math.min(width, display.width),
      height: Math.min(height, display.height),
      minWidth: 420,
      minHeight: 520,
      backgroundColor: '#0b0f14',
      title: launch.title ? `Nexus · ${launch.title}` : 'Nexus Companion',
      // A companion is a focus surface, not a taskbar-spamming app instance.
      skipTaskbar: true,
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    windows.set(launch.contactId, win);
    win.on('closed', () => {
      windows.delete(launch.contactId);
      options.onClosed?.(launch.contactId);
    });

    const base = options.resolveRendererUrl();
    // `loadURL` accepts a hash on both file:// and http:// renderer URLs.
    void win.loadURL(`${base}${buildCompanionHash(launch)}`);
    return { opened: true, contactId: launch.contactId };
  }

  return {
    open,

    /** Close a contact's companion (no-op when none is open). */
    close(contactId: string): boolean {
      const win = windows.get(contactId);
      if (!win || win.isDestroyed()) return false;
      win.close();
      return true;
    },

    /** Close all companion windows (app shutdown). */
    closeAll(): void {
      for (const win of windows.values()) {
        if (!win.isDestroyed()) win.close();
      }
      windows.clear();
    },

    /** Contact ids with an open companion. */
    openContactIds(): string[] {
      return [...windows.keys()];
    },
  };
}

/** Convenience for wiring the preload path from the main entry. */
export function defaultCompanionPreloadPath(): string {
  // `__dirname` inside the bundled main is `dist-electron`; the preload is
  // emitted to dist-electron/preload/, so it is a subfolder, not a sibling.
  return join(__dirname, 'preload/preload.cjs');
}
