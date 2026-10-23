import { beforeEach, describe, expect, it, vi } from 'vitest';

const created: FakeWindow[] = [];

class FakeWindow {
  static destroyCount = 0;
  focused = false;
  closed = false;
  alwaysOnTop: boolean | null = null;
  loadURL = vi.fn(async (_url: string) => undefined);
  private listeners: Record<string, Array<() => void>> = {};
  constructor(public options: Record<string, unknown>) {
    created.push(this);
    this.alwaysOnTop = (options.alwaysOnTop as boolean) ?? false;
  }
  on(event: string, listener: () => void) {
    (this.listeners[event] ??= []).push(listener);
    return this;
  }
  focus() {
    this.focused = true;
  }
  setAlwaysOnTop(value: boolean) {
    this.alwaysOnTop = value;
  }
  isDestroyed() {
    return this.closed;
  }
  close() {
    this.closed = true;
    FakeWindow.destroyCount += 1;
    for (const l of this.listeners['closed'] ?? []) l();
  }
}

vi.mock('electron', () => ({
  BrowserWindow: FakeWindow,
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
}));

const { createCompanionWindowManager, defaultCompanionPreloadPath } = await import(
  './companion-window.js'
);

function manager() {
  return createCompanionWindowManager({
    resolveRendererUrl: () => 'file:///app/index.html',
    preloadPath: '/app/preload.cjs',
  });
}

beforeEach(() => {
  created.length = 0;
  FakeWindow.destroyCount = 0;
});

describe('companion window manager', () => {
  it('opens a small window with the companion hash and no token', () => {
    const m = manager();
    const res = m.open({ contactId: 've-1', title: 'Aria' });
    expect(res).toEqual({ opened: true, contactId: 've-1' });
    expect(created).toHaveLength(1);
    const [url] = created[0].loadURL.mock.calls[0];
    expect(url).toContain('file:///app/index.html#companion?');
    expect(url).toContain('contactId=ve-1');
    expect(url).not.toMatch(/token=/i);
    // Compact, album-shaped window — not the full app chrome.
    expect(created[0].options.width).toBe(560);
    expect(created[0].options.height).toBe(740);
    expect(created[0].options.skipTaskbar).toBe(true);
  });

  it('is not always-on-top unless asked', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    expect(created[0].options.alwaysOnTop).toBe(false);
    expect(m.isAlwaysOnTop('ve-1')).toBe(false);
  });

  it('opens pinned when the launch asks for it and round-trips the flag', () => {
    const m = manager();
    m.open({ contactId: 've-1', alwaysOnTop: true });
    expect(created[0].options.alwaysOnTop).toBe(true);
    const [url] = created[0].loadURL.mock.calls[0];
    expect(url).toContain('onTop=1');
    expect(m.isAlwaysOnTop('ve-1')).toBe(true);
  });

  it('reuses the existing window, focuses it, and re-applies the pin', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    const second = m.open({ contactId: 've-1', alwaysOnTop: true });
    expect(second.opened).toBe(false);
    expect(created).toHaveLength(1);
    expect(created[0].focused).toBe(true);
    expect(created[0].alwaysOnTop).toBe(true);
  });

  it('opens a separate window for a different contact', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    m.open({ contactId: 've-2' });
    expect(created).toHaveLength(2);
    expect(m.openContactIds().sort()).toEqual(['ve-1', 've-2']);
  });

  it('toggles always-on-top live and reports the state', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    expect(m.setAlwaysOnTop('ve-1', true)).toBe(true);
    expect(created[0].alwaysOnTop).toBe(true);
    expect(m.isAlwaysOnTop('ve-1')).toBe(true);
    expect(m.setAlwaysOnTop('ve-1', false)).toBe(false);
    expect(m.isAlwaysOnTop('ve-1')).toBe(false);
  });

  it('returns null from pin reads/writes for an unknown contact', () => {
    const m = manager();
    expect(m.setAlwaysOnTop('nope', true)).toBeNull();
    expect(m.isAlwaysOnTop('nope')).toBeNull();
  });

  it('closes and forgets a companion', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    expect(m.close('ve-1')).toBe(true);
    expect(m.openContactIds()).toEqual([]);
    expect(m.isAlwaysOnTop('ve-1')).toBeNull();
    // A closed window must not be reused.
    expect(m.open({ contactId: 've-1' }).opened).toBe(true);
    expect(created).toHaveLength(2);
  });

  it('ignores close for an unknown contact', () => {
    const m = manager();
    expect(m.close('nope')).toBe(false);
  });

  it('closeAll tears every window down', () => {
    const m = manager();
    m.open({ contactId: 'a' });
    m.open({ contactId: 'b' });
    m.closeAll();
    expect(m.openContactIds()).toEqual([]);
    expect(FakeWindow.destroyCount).toBe(2);
  });

  it('rejects a launch without a contactId', () => {
    const m = manager();
    expect(() => m.open({ contactId: '' })).toThrow(/contactId/);
  });
});

describe('defaultCompanionPreloadPath', () => {
  it('points at the emitted preload subfolder', () => {
    expect(defaultCompanionPreloadPath().replace(/\\/g, '/')).toMatch(/preload\/preload\.cjs$/);
  });
});
