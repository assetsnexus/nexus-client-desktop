import { describe, expect, it, vi } from 'vitest';
import {
  createSenderGuard,
  hardenWebContents,
  installPermissionGuard,
  installSenderGuard,
  isTrustedRendererUrl,
  senderUrlOf,
} from './ipc-guard.js';

const FILE_URL = 'file:///app/dist/renderer/index.html';
const DEV_URL = 'http://localhost:5280/';

describe('isTrustedRendererUrl', () => {
  it('accepts the exact configured renderer URL', () => {
    expect(isTrustedRendererUrl(FILE_URL, [FILE_URL])).toBe(true);
    expect(isTrustedRendererUrl(DEV_URL, [DEV_URL])).toBe(true);
  });

  it('ignores the fragment so the companion route matches the app document', () => {
    expect(isTrustedRendererUrl(`${FILE_URL}#companion?contactId=ve-1`, [FILE_URL])).toBe(true);
    expect(isTrustedRendererUrl(`${DEV_URL}#/chat`, [DEV_URL])).toBe(true);
  });

  it('accepts sibling paths / module requests on the dev-server origin only', () => {
    expect(isTrustedRendererUrl('http://localhost:5280/src/main.tsx', [DEV_URL])).toBe(true);
    expect(isTrustedRendererUrl('http://localhost:5280/@vite/client', [DEV_URL])).toBe(true);
  });

  it('rejects a different origin, scheme or file path', () => {
    expect(isTrustedRendererUrl('https://evil.example/', [DEV_URL])).toBe(false);
    expect(isTrustedRendererUrl('http://localhost:5281/', [DEV_URL])).toBe(false);
    expect(isTrustedRendererUrl('file:///evil/index.html', [FILE_URL])).toBe(false);
    expect(isTrustedRendererUrl('file:///app/dist/renderer/other.html', [FILE_URL])).toBe(false);
    expect(isTrustedRendererUrl('javascript:alert(1)', [DEV_URL])).toBe(false);
  });

  it('fails closed for missing / malformed input', () => {
    expect(isTrustedRendererUrl(undefined, [FILE_URL])).toBe(false);
    expect(isTrustedRendererUrl('', [FILE_URL])).toBe(false);
    expect(isTrustedRendererUrl(FILE_URL, [])).toBe(false);
    expect(isTrustedRendererUrl('not a url', ['also not a url'])).toBe(false);
  });
});

describe('senderUrlOf', () => {
  it('prefers the sender frame URL, falling back to the webContents URL', () => {
    expect(senderUrlOf({ senderFrame: { url: DEV_URL }, sender: { getURL: () => FILE_URL } })).toBe(
      DEV_URL,
    );
    expect(senderUrlOf({ senderFrame: null, sender: { getURL: () => FILE_URL } })).toBe(FILE_URL);
  });

  it('treats a disposed frame / destroyed contents as unknown (null)', () => {
    const disposed: { senderFrame: { url?: unknown } | null; sender: { getURL?: () => string } } = {
      get senderFrame(): { url?: unknown } | null {
        throw new Error('frame is gone');
      },
      sender: {
        getURL() {
          throw new Error('contents destroyed');
        },
      },
    };
    expect(senderUrlOf(disposed)).toBeNull();
    expect(senderUrlOf(null)).toBeNull();
    expect(senderUrlOf(undefined)).toBeNull();
  });

  it('reads a bare WebContents (not an IPC event) via getURL()', () => {
    expect(senderUrlOf({ getURL: () => DEV_URL })).toBe(DEV_URL);
  });
});

describe('createSenderGuard', () => {
  const guard = createSenderGuard(() => [FILE_URL, DEV_URL]);

  it('trusts the app renderer and rejects everything else', () => {
    expect(guard.isTrustedSender({ senderFrame: { url: DEV_URL } })).toBe(true);
    expect(guard.isTrustedSender({ senderFrame: { url: 'https://evil.example/' } })).toBe(false);
  });

  it('assertTrustedSender throws on an untrusted sender and passes a trusted one through', () => {
    expect(() => guard.assertTrustedSender({ senderFrame: { url: 'https://evil.example/' } })).toThrow(
      /untrusted sender/,
    );
    expect(() => guard.assertTrustedSender({ senderFrame: { url: FILE_URL } })).not.toThrow();
  });
});

describe('installSenderGuard', () => {
  function fakeIpc() {
    const listeners = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    return {
      listeners,
      handle: vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
        listeners.set(channel, listener);
      }),
    };
  }

  it('blocks a handler when the sender is not the app renderer', () => {
    const ipc = fakeIpc();
    const guard = createSenderGuard(() => [DEV_URL]);
    installSenderGuard(ipc, guard);

    const body = vi.fn((_arg: unknown) => 'ran');
    ipc.handle('nexus:test', (_event, arg: unknown) => body(arg));

    const handler = ipc.listeners.get('nexus:test')!;
    expect(() => handler({ senderFrame: { url: 'https://evil.example/' } }, 'x')).toThrow(
      /untrusted sender/,
    );
    expect(body).not.toHaveBeenCalled();
  });

  it('runs the handler and forwards args unchanged for a trusted sender', () => {
    const ipc = fakeIpc();
    installSenderGuard(ipc, createSenderGuard(() => [DEV_URL]));

    const listener = vi.fn((_event, a: unknown, b: unknown) => [a, b]);
    ipc.handle('nexus:test', listener);

    const handler = ipc.listeners.get('nexus:test')!;
    const event = { senderFrame: { url: DEV_URL } };
    expect(handler(event, 1, 2)).toEqual([1, 2]);
    expect(listener).toHaveBeenCalledWith(event, 1, 2);
  });

  it('is idempotent so a second install cannot double-wrap', () => {
    const ipc = fakeIpc();
    installSenderGuard(ipc, createSenderGuard(() => [DEV_URL]));
    const afterFirst = ipc.handle;
    installSenderGuard(ipc, createSenderGuard(() => [DEV_URL]));
    expect(ipc.handle).toBe(afterFirst);
  });
});

describe('hardenWebContents', () => {
  type Listener = (...args: unknown[]) => void;
  function fakeContents() {
    const listeners = new Map<string, Listener>();
    const openExternal = vi.fn();
    let windowOpenHandler: ((details: { url: string }) => unknown) | null = null;
    return {
      openExternal,
      listeners,
      get windowOpenHandler() {
        return windowOpenHandler;
      },
      setWindowOpenHandler: vi.fn((h: (details: { url: string }) => unknown) => {
        windowOpenHandler = h;
      }),
      on: vi.fn((event: string, listener: Listener) => listeners.set(event, listener)),
    };
  }

  it('denies window.open and hands an http(s) target to the OS browser', () => {
    const contents = fakeContents();
    hardenWebContents(contents as never, {
      trustedUrls: () => [DEV_URL],
      openExternal: contents.openExternal,
    });
    expect(contents.windowOpenHandler!({ url: 'https://portal.example/x' })).toEqual({
      action: 'deny',
    });
    expect(contents.openExternal).toHaveBeenCalledWith('https://portal.example/x');
  });

  it('never hands a non-http(s) URL to the OS browser', () => {
    const contents = fakeContents();
    hardenWebContents(contents as never, {
      trustedUrls: () => [DEV_URL],
      openExternal: contents.openExternal,
    });
    expect(contents.windowOpenHandler!({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' });
    expect(contents.openExternal).not.toHaveBeenCalled();
  });

  it('cancels off-origin navigation but allows the app itself', () => {
    const contents = fakeContents();
    hardenWebContents(contents as never, { trustedUrls: () => [FILE_URL] });

    const navigate = contents.listeners.get('will-navigate')!;
    const blocked = { preventDefault: vi.fn() };
    navigate(blocked, 'https://evil.example/');
    expect(blocked.preventDefault).toHaveBeenCalled();

    const allowed = { preventDefault: vi.fn() };
    navigate(allowed, `${FILE_URL}#companion?contactId=ve-1`);
    expect(allowed.preventDefault).not.toHaveBeenCalled();
  });

  it('refuses to attach a <webview>', () => {
    const contents = fakeContents();
    hardenWebContents(contents as never, { trustedUrls: () => [DEV_URL] });
    const blocked = { preventDefault: vi.fn() };
    contents.listeners.get('will-attach-webview')!(blocked);
    expect(blocked.preventDefault).toHaveBeenCalled();
  });
});

describe('installPermissionGuard', () => {
  type RequestHandler = (
    contents: unknown,
    permission: string,
    callback: (granted: boolean) => void,
  ) => void;
  type CheckHandler = (contents: unknown, permission: string, origin: string) => boolean;

  function fakeSession() {
    let request: RequestHandler | null = null;
    let check: CheckHandler | null = null;
    return {
      get request() {
        return request;
      },
      get check() {
        return check;
      },
      setPermissionRequestHandler: vi.fn((h: RequestHandler | null) => {
        request = h;
      }),
      setPermissionCheckHandler: vi.fn((h: CheckHandler | null) => {
        check = h;
      }),
    };
  }

  function grant(session: ReturnType<typeof fakeSession>, contents: unknown, permission: string) {
    let granted: boolean | null = null;
    session.request!(contents, permission, (value) => {
      granted = value;
    });
    return granted;
  }

  it('grants the app renderer the permissions the app actually needs', () => {
    const session = fakeSession();
    installPermissionGuard(session as never, () => [DEV_URL]);
    const appFrame = { senderFrame: { url: DEV_URL } };
    for (const permission of ['media', 'display-capture', 'fullscreen']) {
      expect(grant(session, appFrame, permission), permission).toBe(true);
    }
  });

  it('denies permissions the app does not need, without a prompt', () => {
    const session = fakeSession();
    installPermissionGuard(session as never, () => [DEV_URL]);
    const appFrame = { senderFrame: { url: DEV_URL } };
    for (const permission of ['geolocation', 'midi', 'hid', 'usb', 'serial', 'notifications']) {
      expect(grant(session, appFrame, permission), permission).toBe(false);
    }
  });

  it('denies every permission to a non-app origin', () => {
    const session = fakeSession();
    installPermissionGuard(session as never, () => [DEV_URL]);
    expect(grant(session, { senderFrame: { url: 'https://evil.example/' } }, 'media')).toBe(false);
    expect(
      session.check!({ getURL: () => 'https://evil.example/' }, 'media', 'https://evil.example/'),
    ).toBe(false);
  });

  it('checks permissions against the requesting origin for the app only', () => {
    const session = fakeSession();
    installPermissionGuard(session as never, () => [DEV_URL]);
    const appContents = { getURL: () => DEV_URL };
    expect(session.check!(appContents, 'media', DEV_URL)).toBe(true);
    expect(session.check!(appContents, 'midi', DEV_URL)).toBe(false);
    // An empty origin with a non-trusted window is refused (fails closed).
    expect(session.check!({ getURL: () => 'https://evil.example/' }, 'media', '')).toBe(false);
  });

  it('falls back to the requesting webContents for a bare file:// origin', () => {
    const app = { getURL: () => FILE_URL };
    const foreign = { getURL: () => 'https://evil.example/' };

    const fileSession = fakeSession();
    installPermissionGuard(fileSession as never, () => [FILE_URL]);
    expect(fileSession.check!(app, 'media', 'file://')).toBe(true);
    expect(fileSession.check!(foreign, 'media', 'file://')).toBe(false);

    // A present, parseable foreign origin is never rescued by a trusted window.
    const devSession = fakeSession();
    installPermissionGuard(devSession as never, () => [DEV_URL]);
    expect(devSession.check!(app, 'media', 'https://evil.example/')).toBe(false);
  });
});
