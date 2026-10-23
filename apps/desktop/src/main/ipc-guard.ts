/**
 * IPC bridge hardening (main process).
 *
 * `contextIsolation` + `sandbox` keep Node out of the renderer, and the preload
 * exposes a narrow, typed surface. Two gaps remain on the *transport* itself:
 *
 *  1. **Sender validation.** `ipcMain.handle` runs for any frame that can reach
 *     `ipcRenderer` — currently only the app's own renderer, but nothing enforces
 *     that. `installSenderGuard` wraps every `ipcMain.handle` so a message that
 *     did not originate from the app's own renderer URL is refused before any
 *     handler body runs.
 *  2. **Navigation.** The preload (and therefore `window.nexus`) is re-injected on
 *     every top-level navigation of a `webContents`. Without a guard, a renderer
 *     that navigates — or is navigated — to a remote page would hand that page
 *     the whole bridge. `hardenWebContents` blocks off-origin navigation and
 *     window opens, and routes http(s) opens to the OS browser instead.
 *
 * Everything here is dependency-free apart from electron *types*, so the logic is
 * unit-testable without a running Electron (see `ipc-guard.spec.ts`).
 */

import type { WebContents } from 'electron';
import { isSafeExternalUrl } from '../shared/nexus-apps.js';

/** Resolve the URLs the app's own renderer is served from (dev server / file://). */
export type TrustedUrlResolver = () => readonly string[];

/** Strip a URL's fragment so `app.html#companion?...` matches `app.html`. */
function withoutHash(url: string): string {
  const hashAt = url.indexOf('#');
  return hashAt === -1 ? url : url.slice(0, hashAt);
}

function tryUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * True when `url` is one of `allowed` (fragment ignored), or the same **http(s)**
 * origin as an allowed URL. The origin allowance exists only for the Vite dev
 * server, whose module/asset requests share its origin; a `file://` app is
 * matched by exact path so a `file://` page from anywhere else is refused.
 */
export function isTrustedRendererUrl(url: unknown, allowed: readonly string[]): boolean {
  if (typeof url !== 'string' || !url) return false;
  const candidate = withoutHash(url);
  for (const entry of allowed) {
    if (typeof entry !== 'string' || !entry) continue;
    const expected = withoutHash(entry);
    if (candidate === expected) return true;
    const candidateUrl = tryUrl(candidate);
    const expectedUrl = tryUrl(expected);
    if (!candidateUrl || !expectedUrl) continue;
    const httpish = expectedUrl.protocol === 'http:' || expectedUrl.protocol === 'https:';
    if (httpish && candidateUrl.origin === expectedUrl.origin) return true;
  }
  return false;
}

/** Minimal shape of an IPC invoke event we read a sender URL from. */
export type SenderLike = {
  senderFrame?: { url?: unknown } | null;
  sender?: { getURL?: () => string } | null;
  /** Present when the object *is* a `WebContents` (e.g. a permission handler arg). */
  getURL?: () => string;
};

/**
 * Best-effort sender URL. Handles all three shapes Electron hands us:
 * an IPC invoke event's `senderFrame.url` (the authoritative per-frame URL), its
 * fallback `sender.getURL()`, and a bare `WebContents` (permission handlers).
 */
export function senderUrlOf(event: SenderLike | null | undefined): string | null {
  if (!event) return null;
  try {
    const frameUrl = event.senderFrame?.url;
    if (typeof frameUrl === 'string' && frameUrl) return frameUrl;
  } catch {
    // A frame disposed mid-call can throw on the *property access* itself.
  }
  for (const candidate of [event.sender, event]) {
    try {
      const url = candidate?.getURL?.();
      if (typeof url === 'string' && url) return url;
    } catch {
      // A destroyed webContents throws; fall through.
    }
  }
  return null;
}

export type SenderGuard = {
  /** True when the event came from the app's own renderer. */
  isTrustedSender(event: SenderLike | null | undefined): boolean;
  /** Throw unless the event came from the app's own renderer. */
  assertTrustedSender(event: SenderLike | null | undefined): void;
};

/**
 * Build a sender guard over a (possibly dynamic) allowlist of renderer URLs.
 * Fails closed: a missing/unknown sender URL is never trusted.
 */
export function createSenderGuard(
  trustedUrls: TrustedUrlResolver,
  message = 'refused IPC from an untrusted sender',
): SenderGuard {
  const isTrustedSender = (event: SenderLike | null | undefined): boolean =>
    isTrustedRendererUrl(senderUrlOf(event), trustedUrls());

  return {
    isTrustedSender,
    assertTrustedSender(event) {
      if (!isTrustedSender(event)) throw new Error(message);
    },
  };
}

/** Structural view of `ipcMain.handle` — enough to wrap it, easy to fake in tests. */
export type IpcMainHandleLike = {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): unknown;
};

const GUARDED = Symbol.for('nexus.ipcSenderGuarded');

/**
 * Wrap every `ipcMain.handle` listener so the sender is validated before the
 * handler body runs. Call **once**, before handlers are registered; a second call
 * is a no-op so a hot restart cannot double-wrap.
 */
export function installSenderGuard(ipc: IpcMainHandleLike, guard: SenderGuard): void {
  const target = ipc as IpcMainHandleLike & { [GUARDED]?: boolean };
  if (target[GUARDED]) return;
  const original = ipc.handle;
  target[GUARDED] = true;
  ipc.handle = (channel, listener) =>
    original.call(ipc, channel, (event, ...args) => {
      guard.assertTrustedSender(event as SenderLike);
      return listener(event, ...args);
    });
}

export type HardenWebContentsOptions = {
  trustedUrls: TrustedUrlResolver;
  /** Open an http(s) URL in the OS browser (usually `shell.openExternal`). */
  openExternal?: (url: string) => void;
};

/**
 * Apply the navigation guards to one `webContents`:
 * - `window.open` / `target=_blank` is denied, and an http(s) target is handed to
 *   the OS browser instead of a new Electron window.
 * - a top-level navigation away from the app's own origin is cancelled (the
 *   preload — hence `window.nexus` — is re-injected on every navigation).
 * - attaching a `<webview>` is refused (defense in depth; `webviewTag` is off).
 */
export function hardenWebContents(contents: WebContents, options: HardenWebContentsOptions): void {
  const trusted = () => options.trustedUrls();

  contents.setWindowOpenHandler(({ url }) => {
    if (options.openExternal && isSafeExternalUrl(url)) options.openExternal(url);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url, trusted())) event.preventDefault();
  });

  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

/** The only Session permission types the renderer may use (calls + screen share). */
export const ALLOWED_SESSION_PERMISSIONS: readonly string[] = [
  'media',
  'display-capture',
  'fullscreen',
  'clipboard-sanitized-write',
];

/** Minimal shape of `session` we configure (keeps this Electron-free-testable). */
export type PermissionRequestHandlerLike = (
  webContents: unknown,
  permission: string,
  callback: (granted: boolean) => void,
) => void;
export type PermissionCheckHandlerLike = (
  webContents: unknown,
  permission: string,
  requestingOrigin: string,
) => boolean;

export type SessionLike = {
  setPermissionRequestHandler(handler: PermissionRequestHandlerLike | null): void;
  setPermissionCheckHandler(handler: PermissionCheckHandlerLike | null): void;
};

/**
 * Deny every session permission the app does not need, without a prompt.
 *
 * Chromium answers an unhandled permission request with a user prompt or, worse,
 * an automatic grant for some types. The app only ever needs microphone/camera
 * (`media`), screen share (`display-capture`) and fullscreen, so everything else
 * (geolocation, MIDI, HID, USB, serial, notifications, …) is refused outright —
 * and only for the app's own renderer origin.
 */
export function installPermissionGuard(
  target: SessionLike,
  trustedUrls: TrustedUrlResolver,
  allowed: readonly string[] = ALLOWED_SESSION_PERMISSIONS,
): void {
  const allowSet = new Set(allowed);

  target.setPermissionRequestHandler((event, permission, callback) => {
    const fromApp = isTrustedRendererUrl(senderUrlOf(event as SenderLike), trustedUrls());
    callback(fromApp && allowSet.has(permission));
  });

  target.setPermissionCheckHandler((window, permission, requestingOrigin) => {
    // `requestingOrigin` can be absent or a bare `file://` (no path) for a
    // file-backed app, so fall back to the requesting webContents when it is
    // unhelpful. A present-and-parseable origin is authoritative — a foreign
    // origin is never rescued by a trusted webContents.
    const origin = typeof requestingOrigin === 'string' ? requestingOrigin : '';
    const originNamed = Boolean(origin) && origin !== 'file://';
    const fromApp = originNamed
      ? isTrustedRendererUrl(origin, trustedUrls())
      : isTrustedRendererUrl(senderUrlOf(window as SenderLike), trustedUrls());
    return fromApp && allowSet.has(permission);
  });
}
