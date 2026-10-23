/**
 * Immersive companion window (Phase 7a, main process).
 *
 * Pops a single agent conversation into its own `BrowserWindow` with the full
 * 3D/VRM avatar + live voice, like a small always-on-top side companion. One
 * companion per contact: a second open reuses (and focuses) the existing window
 * and re-applies the requested stage mode / always-on-top so re-opening from the
 * chat never spawns a duplicate.
 *
 * The window is a normal renderer with the same preload bridge — the launch is
 * carried in the URL hash, resolving the live session (token, region) exactly
 * like the main window. Nothing sensitive is placed in the hash.
 */

import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import {
  buildCompanionHash,
  COMPANION_DEFAULT_SIZE,
  COMPANION_MIN_SIZE,
  type CompanionLaunch,
} from '../shared/companion.js';
export type CompanionWindowOptions = {
  /** Resolve the renderer base URL (dev server or file:// index.html). */
  resolveRendererUrl: () => string;
  /** Preload script path. */
  preloadPath: string;
  /**
   * Apply the shared navigation guards (off-origin navigation + `window.open`
   * denial) to the new window's `webContents`. Wired to `hardenWebContents` from
   * main so a companion cannot navigate the bridge script to a remote page.
   */
  harden?: (contents: Electron.WebContents) => void;
  /** Called after a companion window closes. */
  onClosed?: (contactId: string) => void;
};

export type CompanionWindowManager = ReturnType<typeof createCompanionWindowManager>;

export function createCompanionWindowManager(options: CompanionWindowOptions) {
  const windows = new Map<string, BrowserWindow>();
  /** Pin state per contact, so a reopen preserves the user's choice. */
  const pinned = new Map<string, boolean>();

  function open(launch: CompanionLaunch): { opened: boolean; contactId: string } {
    if (!launch?.contactId) throw new Error('companion launch requires a contactId');

    const alwaysOnTop = launch.alwaysOnTop === true;
    const existing = windows.get(launch.contactId);
    if (existing && !existing.isDestroyed()) {
      // Reuse: refocus and re-apply the requested column semantics. We do NOT
      // reload the URL (that would restart the live voice session); the renderer
      // receives the mode via a dedicated channel when it changes.
      pinned.set(launch.contactId, alwaysOnTop);
      if (typeof existing.setAlwaysOnTop === 'function') existing.setAlwaysOnTop(alwaysOnTop);
      existing.focus();
      return { opened: false, contactId: launch.contactId };
    }

    const { width, height } = COMPANION_DEFAULT_SIZE;
    const display = screen.getPrimaryDisplay().workAreaSize;
    const win = new BrowserWindow({
      width: Math.min(width, display.width),
      height: Math.min(height, display.height),
      minWidth: COMPANION_MIN_SIZE.width,
      minHeight: COMPANION_MIN_SIZE.height,
      backgroundColor: '#0b0f14',
      title: launch.title ? `Nexus · ${launch.title}` : 'Nexus Companion',
      // A companion is a focus surface, not a taskbar-spamming app instance.
      skipTaskbar: true,
      alwaysOnTop,
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    windows.set(launch.contactId, win);
    pinned.set(launch.contactId, alwaysOnTop);
    // The companion runs the same preload bridge, so it needs the same guards.
    options.harden?.(win.webContents);
    win.on('closed', () => {
      windows.delete(launch.contactId);
      pinned.delete(launch.contactId);
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

    /**
     * Pin / unpin a companion above other windows. Returns the applied state, or
     * `null` when no companion is open for that contact.
     */
    setAlwaysOnTop(contactId: string, onTop: boolean): boolean | null {
      const win = windows.get(contactId);
      if (!win || win.isDestroyed()) return null;
      pinned.set(contactId, onTop);
      if (typeof win.setAlwaysOnTop === 'function') win.setAlwaysOnTop(onTop);
      return onTop;
    },

    /** Whether a contact's companion is pinned above other windows. */
    isAlwaysOnTop(contactId: string): boolean | null {
      if (!windows.has(contactId)) return null;
      return pinned.get(contactId) ?? false;
    },

    /** Close all companion windows (app shutdown). */
    closeAll(): void {
      for (const win of windows.values()) {
        if (!win.isDestroyed()) win.close();
      }
      windows.clear();
      pinned.clear();
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
