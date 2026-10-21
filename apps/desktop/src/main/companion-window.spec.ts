import { beforeEach, describe, expect, it, vi } from 'vitest';

const created: FakeWindow[] = [];

class FakeWindow {
  static destroyCount = 0;
  focused = false;
  closed = false;
  loadURL = vi.fn(async (_url: string) => undefined);
  private listeners: Record<string, Array<() => void>> = {};
  constructor(public options: Record<string, unknown>) {
    created.push(this);
  }
  on(event: string, listener: () => void) {
    (this.listeners[event] ??= []).push(listener);
    return this;
  }
  focus() {
    this.focused = true;
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

const { createCompanionWindowManager } = await import('./companion-window.js');

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
  it('opens a window with the companion hash and no token', () => {
    const m = manager();
    const res = m.open({ contactId: 've-1', title: 'Aria' });
    expect(res).toEqual({ opened: true, contactId: 've-1' });
    expect(created).toHaveLength(1);
    const [url] = created[0].loadURL.mock.calls[0];
    expect(url).toContain('file:///app/index.html#companion?');
    expect(url).toContain('contactId=ve-1');
    expect(url).not.toMatch(/token=/i);
  });

  it('reuses the existing window for the same contact instead of opening a second', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    const second = m.open({ contactId: 've-1' });
    expect(second.opened).toBe(false);
    expect(created).toHaveLength(1);
    expect(created[0].focused).toBe(true);
  });

  it('opens a separate window for a different contact', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    m.open({ contactId: 've-2' });
    expect(created).toHaveLength(2);
    expect(m.openContactIds().sort()).toEqual(['ve-1', 've-2']);
  });

  it('closes and forgets a companion', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    expect(m.close('ve-1')).toBe(true);
    expect(m.openContactIds()).toEqual([]);
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
