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
  buildCompanionToolHash,
  COMPANION_DEFAULT_SIZE,
  COMPANION_MIN_SIZE,
  companionLabelCandidates,
  companionToolWindowTitle,
  companionWindowTitle,
  isReportableCompanionLabel,
  electSttOwner,
  sttOwnerMessage,
  type CompanionLaunch,
  type CompanionPresent,
  type CompanionSessionView,
  type CompanionSttOwner,
  type CompanionTitleReport,
  type CompanionToolPresence,
  type CompanionToolSnapshot,
  type CompanionToolSync,
  type SttOwnerElection,
} from '../shared/companion.js';
import { IPC, type CompanionToolId } from '../shared/ipc.js';

/** Default size of a detached companion tool window (Deliverable 3). */
const TOOL_DEFAULT_SIZE = { width: 460, height: 560 } as const;
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
  /**
   * Detached tool windows (Deliverable 3): `"<contactId>::<tool>"` → window.
   * Scoped per (contact, tool) so each agent gets its own Motion feed /
   * Gesture tester / Status motions window, and two agents never share one.
   */
  const toolWindows = new Map<string, BrowserWindow>();
  /** Which contact each open tool window belongs to (for the targeted relay). */
  const toolOwners = new Map<number, string>();
  /** Pin state per contact, so a reopen preserves the user's choice. */
  const pinned = new Map<string, boolean>();
  /**
   * The single companion that currently owns speech-to-text (the mic). At most
   * one window may capture at a time; a new primary demotes the previous one.
   */
  let sttOwner: string | null = null;
  /** Bumped on every election change so a repeat switch still re-applies. */
  let sttToken = 0;
  /**
   * The latest wake-dictation session view per contact.
   *
   * A freshly opened companion subscribes to the session channel *after* the
   * create-time push, so that first (and possibly only) view was dropped — the
   * window then showed no STT strip at all even though the session-owning window
   * was already capturing. Keeping the last view per contact and re-sending it on
   * `did-finish-load` makes the mirror independent of that mount race, exactly as
   * the STT election already is.
   */
  const lastSessions = new Map<string, CompanionSessionView>();

  /**
   * Send the **current** election to every open companion, unconditionally.
   *
   * A window that mounts *after* a push (a fresh `loadURL`, or a renderer that
   * finished loading later) never saw it. Until it hears otherwise it would
   * default to "primary" and open its own capture, competing with the elected
   * owner. Re-sending on `did-finish-load` closes that race: the late window
   * learns it is demoted before the user can touch the mic.
   */
  function broadcastElection(reason: SttOwnerElection['reason']): void {
    const election: SttOwnerElection = {
      primaryContactId: sttOwner,
      previousContactId: null,
      reason,
    };
    for (const contactId of windows.keys()) {
      const win = windows.get(contactId);
      if (!win || win.isDestroyed()) continue;
      const message: CompanionSttOwner = sttOwnerMessage(contactId, election, sttToken);
      win.webContents.send(IPC.companionSttOwner, message);
    }
  }

  /**
   * Apply an election: remember the new primary and tell **every** open
   * companion its role (the promoted one becomes primary, the demoted one
   * relinquishes the mic). Broadcasting to all keeps windows that missed an
   * earlier push (e.g. opened later) correct.
   */
  function applyElection(next: string | null, reason: SttOwnerElection['reason']): void {
    const election = electSttOwner({ current: sttOwner, next, reason });
    if (!election) return;
    sttOwner = election.primaryContactId;
    sttToken += 1;
    for (const contactId of windows.keys()) {
      const win = windows.get(contactId);
      if (!win || win.isDestroyed()) continue;
      const message: CompanionSttOwner = sttOwnerMessage(contactId, election, sttToken);
      win.webContents.send(IPC.companionSttOwner, message);
    }
  }

  /**
   * The first *reportable* candidate from a renderer's live report, or `null`.
   *
   * "Reportable" is stricter than "usable": it also drops the in-app floor literal
   * (`Companion`), which the renderer's fallback contact carries before a real
   * name resolves. Re-applying it would only produce `Nexus · Companion` — no
   * better than the neutral caption — so it is skipped and a real name may still
   * land later.
   */
  function reportableLabel(
    candidates: Array<string | null | undefined>,
  ): string | null {
    for (const candidate of candidates) {
      if (isReportableCompanionLabel(candidate)) return (candidate as string).trim();
    }
    return null;
  }

  /**
   * Apply a caption, refusing to downgrade a good one.
   *
   * The renderer reports the *live* label and may report it several times (mount,
   * then after a region fetch). A later report that resolves nothing (a transient
   * outage, an unresolved contact) must not wipe the name the window already
   * shows, so a resolution that yields nothing reportable is skipped.
   */
  function applyWindowTitle(win: BrowserWindow, candidates: Array<string | null | undefined>): void {
    if (win.isDestroyed()) return;
    const title = reportableLabel(candidates);
    if (!title) return;
    win.setTitle(companionWindowTitle(title));
  }

  /**
   * The same "never downgrade" rule for a detached tool window's caption.
   *
   * A tool window has no session of its own, so its name arrives later from the
   * companion that owns the agent. Re-applying a report that resolves nothing must
   * leave `<Tool> · <Agent>` intact rather than fall back to the bare tool label.
   */
  function applyToolWindowTitle(
    win: BrowserWindow,
    tool: string,
    candidates: Array<string | null | undefined>,
  ): void {
    if (win.isDestroyed()) return;
    const title = reportableLabel(candidates);
    if (!title) return;
    win.setTitle(companionToolWindowTitle(tool, title));
  }

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
      // Re-apply the caption on reuse. A window opened before its name was known
      // (or one whose launch title was absent) would otherwise keep the generic
      // `Nexus Companion` forever; only a *usable* title is applied, so a reopen
      // without one cannot downgrade a window the renderer has already named.
      applyWindowTitle(existing, companionLabelCandidates(launch));
      existing.focus();
      // Re-focusing an open companion makes it the active STT surface; the mic
      // follows the window the user brought forward (unless a wake later moves
      // it), so two windows never capture at once.
      applyElection(launch.contactId, 'focus');
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
      // OS window caption from the launch hint (a real room/agent name when the
      // caller knew one). The renderer re-reports the live label once the session
      // resolves, so this is deliberately still correct when the hint is absent:
      // the caption then starts app-neutral and is *corrected*, not frozen.
      title: companionWindowTitle(...companionLabelCandidates(launch)),
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
    // Bringing a companion to the front (or opening it) makes it the active STT
    // owner, so the mic follows the window the user is looking at.
    win.on('focus', () => applyElection(launch.contactId, 'focus'));
    // A renderer that (re)loads subscribes to the ownership channel *after* the
    // open-time push, so re-state the current election once it is listening — and
    // re-send the last session view for the same reason: without it a companion
    // that opened while a wake turn was already running showed no STT strip.
    win.webContents.on('did-finish-load', () => {
      broadcastElection('opened');
      const last = lastSessions.get(launch.contactId);
      if (last) win.webContents.send(IPC.companionSession, last);
    });
    // The companion runs the same preload bridge, so it needs the same guards.
    options.harden?.(win.webContents);
    win.on('closed', () => {
      windows.delete(launch.contactId);
      pinned.delete(launch.contactId);
      // The mirrored view belonged to a window that no longer exists; keeping it
      // would replay a stale turn into the next window opened for this contact.
      lastSessions.delete(launch.contactId);
      // The closed window may have owned the mic: release ownership (or hand it
      // to the next open companion) so a survivor is not left display-only.
      if (sttOwner === launch.contactId) {
        applyElection([...windows.keys()][0] ?? null, 'closed');
      }
      options.onClosed?.(launch.contactId);
    });

    const base = options.resolveRendererUrl();
    // `loadURL` accepts a hash on both file:// and http:// renderer URLs.
    void win.loadURL(`${base}${buildCompanionHash(launch)}`);
    // The freshly opened companion becomes the active STT surface (a wake that
    // opened it, or the user popping it out); any previously-primary window is
    // told to relinquish the mic.
    applyElection(launch.contactId, 'opened');
    return { opened: true, contactId: launch.contactId };
  }

  const toolKey = (contactId: string, tool: CompanionToolId): string => `${contactId}::${tool}`;

  /**
   * Close a contact's tool windows (one tool when `tool` is given, else all of
   * that contact's tools). Returns whether anything was closed.
   */
  function closeToolWindows(contactId: string, tool?: CompanionToolId): boolean {
    let closed = false;
    for (const [key, win] of [...toolWindows.entries()]) {
      const [owner, ownerTool] = key.split('::');
      if (owner !== contactId) continue;
      if (tool && ownerTool !== tool) continue;
      if (!win.isDestroyed()) win.close();
      toolOwners.delete(win.id);
      toolWindows.delete(key);
      closed = true;
    }
    if (closed) notifyToolPresence(contactId);
    return closed;
  }

  /**
   * Open (or refocus) one context-menu tool in its own `BrowserWindow`, scoped to
   * a single agent/contact. Unlike the companion window this never touches STT
   * ownership — a debug/config surface must not steal the mic — so it is a plain
   * renderer window that resolves the agent's settings from the same session.
   *
   * Fails closed (returns `null`) when the requested contact has no open
   * companion: a tool window without its agent would show global settings, which
   * is exactly the per-agent leak this deliverable forbids.
   */
  function openTool(input: {
    tool: CompanionToolId;
    contactId: string;
    agentName?: string | null;
    conversationId?: string | null;
    agentId?: string | null;
    virtualEmployeeId?: string | null;
  }): { contactId: string; tool: CompanionToolId } | null {
    if (!windows.has(input.contactId)) return null;
    const key = toolKey(input.contactId, input.tool);
    const existing = toolWindows.get(key);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      // Re-apply the caption on reuse, exactly like the companion: a tool window
      // first opened without a name must pick one up on a later reopen.
      applyToolWindowTitle(existing, input.tool, [input.agentName]);
      existing.focus();
      return { contactId: input.contactId, tool: input.tool };
    }

    const display = screen.getPrimaryDisplay().workAreaSize;
    const win = new BrowserWindow({
      width: Math.min(TOOL_DEFAULT_SIZE.width, display.width),
      height: Math.min(TOOL_DEFAULT_SIZE.height, display.height),
      backgroundColor: '#0b0f14',
      // `<Tool> · <Agent Name>`; the agent name is a live-updatable hint (the
      // companion re-titles this window once it resolves the agent), and an
      // id-shaped `agentName` is dropped by the pure title helper.
      title: companionToolWindowTitle(input.tool, input.agentName),
      skipTaskbar: true,
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    toolWindows.set(key, win);
    toolOwners.set(win.id, input.contactId);
    options.harden?.(win.webContents);
    win.on('closed', () => {
      toolOwners.delete(win.id);
      if (toolWindows.get(key) === win) toolWindows.delete(key);
      // The last tool window for this agent just closed: tell the companion it can
      // stop publishing tool snapshots.
      notifyToolPresence(input.contactId);
    });

    const base = options.resolveRendererUrl();
    void win.loadURL(`${base}${buildCompanionToolHash(input)}`);
    notifyToolPresence(input.contactId);
    return { contactId: input.contactId, tool: input.tool };
  }

  /**
   * Push a companion's tool-scoped state to **its** open tool windows only.
   * Tagged per contact so a tool window never renders another agent's config.
   */
  function publishToolSnapshot(snapshot: CompanionToolSnapshot): boolean {
    const contactId = typeof snapshot?.contactId === 'string' ? snapshot.contactId.trim() : '';
    if (!contactId) return false;
    let sent = false;
    for (const win of toolWindows.values()) {
      if (win.isDestroyed() || toolOwners.get(win.id) !== contactId) continue;
      win.webContents.send(IPC.companionToolSnapshot, snapshot);
      sent = true;
    }
    return sent;
  }

  /**
   * Relay a tool-window edit back to the agent's companion window (the window
   * whose session owns the config). Returns false when that companion is gone.
   */
  function syncToolState(sync: CompanionToolSync): boolean {
    const contactId = typeof sync?.contactId === 'string' ? sync.contactId.trim() : '';
    if (!contactId) return false;
    const win = windows.get(contactId);
    if (!win || win.isDestroyed()) return false;
    win.webContents.send(IPC.companionToolSync, sync);
    return true;
  }

  /** Set while a companion must not be relied on for live data. */
  /**
   * Tell a companion whether any of its tool windows are open, so it only runs
   * the tool-state relay loop while something is listening.
   */
  function notifyToolPresence(contactId: string): void {
    const win = windows.get(contactId);
    if (!win || win.isDestroyed()) return;
    const tools: string[] = [];
    for (const [key, toolWin] of toolWindows.entries()) {
      if (toolWin.isDestroyed() || toolOwners.get(toolWin.id) !== contactId) continue;
      const tool = key.split('::')[1];
      if (tool) tools.push(tool);
    }
    win.webContents.send(IPC.companionToolPresence, {
      contactId,
      open: tools.length > 0,
      tools,
    } satisfies CompanionToolPresence);
  }

  /**
   * Re-title a companion (or one of its tool windows) from a renderer report.
   *
   * This is the fix for the generic `Companion` caption: the launch title is only
   * a hint frozen at create time, so the renderer — which owns the live session —
   * reports the label it actually resolved here, and main applies it with
   * `setTitle`. A report with no usable label (or an id-shaped one) is ignored so
   * it cannot blank an already-correct caption. Returns whether a window was
   * found (not whether the title changed).
   */
  function retitle(report: CompanionTitleReport): boolean {
    const contactId = typeof report?.contactId === 'string' ? report.contactId.trim() : '';
    if (!contactId) return false;
    const candidates = Array.isArray(report.titles) ? [...report.titles] : [];
    const tool = typeof report.tool === 'string' ? report.tool : '';
    if (tool) {
      const win = toolWindows.get(toolKey(contactId, tool as CompanionToolId));
      if (!win || win.isDestroyed()) return false;
      applyToolWindowTitle(win, tool, candidates);
      return true;
    }
    const win = windows.get(contactId);
    if (!win || win.isDestroyed()) return false;
    applyWindowTitle(win, candidates);
    return true;
  }

  return {
    open,

    /** Open one context-menu tool in its own window, scoped to a contact. */
    openTool,

    /** Re-apply a companion/tool caption from a renderer's live label report. */
    retitle,

    /**
     * Close a contact's tool windows (one tool when `tool` is given, else all of
     * that contact's tools). Returns whether anything was closed.
     */
    closeTool: closeToolWindows,

    /** Push a companion's tool-scoped state to its own tool windows. */
    publishToolSnapshot,

    /** Relay a tool-window edit back to the agent's companion window. */
    syncToolState,

    /** Close a contact's companion (no-op when none is open). */
    close(contactId: string): boolean {
      // A tool window mirrors one agent's config; closing that agent's companion
      // removes the surface it is scoped to, so its tools close with it.
      closeToolWindows(contactId);
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

    /**
     * Deliver a live wake activation to an *open* companion without reloading it
     * (a reload would restart the live voice session). Returns false when no
     * companion is open for the contact, so the caller can fall back to opening
     * one or foregrounding the main window.
     */
    present(contactId: string, payload: CompanionPresent): boolean {
      const win = windows.get(contactId);
      if (!win || win.isDestroyed()) return false;
      // A wake addressed to this companion is the *switcher*: it makes this
      // window the one STT owner and demotes whichever window held it before.
      applyElection(contactId, 'wake');
      win.webContents.send(IPC.companionPresent, payload);
      return true;
    },

    /**
     * Make an open companion the active STT owner (e.g. the user focused it).
     * Returns false when no companion is open for the contact.
     */
    claimStt(contactId: string): boolean {
      const win = windows.get(contactId);
      if (!win || win.isDestroyed()) return false;
      applyElection(contactId, 'focus');
      return true;
    },

    /** The companion that currently owns STT (`null` when none is open). */
    sttOwnerId(): string | null {
      return sttOwner;
    },

    /**
     * Push a wake-dictation session view into an open companion so its STT
     * preview + composer reflect the live turn. No-op (false) when the companion
     * is not open.
     *
     * The view is remembered per contact so a window that (re)loads — or one that
     * opened while the turn was already running — still receives it on
     * `did-finish-load` instead of showing an empty strip.
     */
    pushSession(contactId: string, view: CompanionSessionView): boolean {
      lastSessions.set(contactId, view);
      const win = windows.get(contactId);
      if (!win || win.isDestroyed()) return false;
      win.webContents.send(IPC.companionSession, view);
      return true;
    },

    /**
     * Raise + focus a companion without a reload. Used by the companion-first
     * wake policy: a wake that resolves to companion mode foregrounds *only* the
     * companion, never the main window.
     */
    raise(contactId: string): boolean {
      const win = windows.get(contactId);
      if (!win || win.isDestroyed()) return false;
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) win.show();
      // The remembered pin is left untouched: a wake must not silently unpin (or
      // newly pin) a companion the user configured.
      win.setAlwaysOnTop(pinned.get(contactId) ?? false);
      win.focus();
      return true;
    },

    /** Close all companion windows (app shutdown). */
    closeAll(): void {
      for (const win of windows.values()) {
        if (!win.isDestroyed()) win.close();
      }
      windows.clear();
      pinned.clear();
      sttOwner = null;
    },

    /** Contact ids with an open companion. */
    openContactIds(): string[] {
      return [...windows.keys()];
    },

    /**
     * Live companion windows with their `BrowserWindow` handles, for the
     * OS-global cursor sampler (which reads per-window bounds each tick).
     */
    listWindows(): Array<{ contactId: string; window: BrowserWindow }> {
      return [...windows.entries()]
        .filter(([, win]) => !win.isDestroyed())
        .map(([contactId, window]) => ({ contactId, window }));
    },
  };
}

/** Convenience for wiring the preload path from the main entry. */
export function defaultCompanionPreloadPath(): string {
  // `__dirname` inside the bundled main is `dist-electron`; the preload is
  // emitted to dist-electron/preload/, so it is a subfolder, not a sibling.
  return join(__dirname, 'preload/preload.cjs');
}
