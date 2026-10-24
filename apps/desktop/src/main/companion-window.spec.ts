import { beforeEach, describe, expect, it, vi } from 'vitest';

const created: FakeWindow[] = [];

class FakeWindow {
  static destroyCount = 0;
  focused = false;
  closed = false;
  alwaysOnTop: boolean | null = null;
  visible = true;
  minimized = false;
  sent: Array<{ channel: string; payload: unknown }> = [];
  loadURL = vi.fn(async (_url: string) => undefined);
  webContents = {
    send: (channel: string, payload: unknown) => {
      this.sent.push({ channel, payload });
    },
    on: (event: string, listener: () => void) => {
      (this.contentsListeners[event] ??= []).push(listener);
    },
  };
  private listeners: Record<string, Array<() => void>> = {};
  /** Mirrors `BrowserWindow#webContents`' own emitter (e.g. did-finish-load). */
  private contentsListeners: Record<string, Array<() => void>> = {};
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
  isVisible() {
    return this.visible;
  }
  isMinimized() {
    return this.minimized;
  }
  show() {
    this.visible = true;
  }
  restore() {
    this.minimized = false;
  }
  close() {
    this.closed = true;
    FakeWindow.destroyCount += 1;
    for (const l of this.listeners['closed'] ?? []) l();
  }
  /** Test hook: drive a `webContents` event the manager listens to. */
  emitContents(event: string) {
    for (const l of this.contentsListeners[event] ?? []) l();
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

  it('presents a live wake activation into an open companion without reloading', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    const loadCalls = created[0].loadURL.mock.calls.length;
    const payload = {
      contactId: 've-1',
      conversationId: 'conv-9',
      agentId: 'agent-3',
      phrase: 'Aria',
      dictate: true,
      token: 7,
    };
    expect(m.present('ve-1', payload)).toBe(true);
    // No reload (which would tear down a live call).
    expect(created[0].loadURL.mock.calls.length).toBe(loadCalls);
    expect(created[0].sent.at(-1)).toEqual({
      channel: 'nexus:companion:present',
      payload,
    });
  });

  it('returns false from present for an unknown contact', () => {
    const m = manager();
    expect(m.present('nope', {
      contactId: 'nope',
      conversationId: null,
      agentId: null,
      phrase: null,
      dictate: true,
      token: 1,
    })).toBe(false);
  });

  it('pushes a session view into an open companion (and false when none)', () => {
    const m = manager();
    expect(
      m.pushSession('ve-1', {
        contactId: 've-1',
        status: 'listening',
        preview: 'hello',
        buffer: '',
        cloudTranscription: false,
        batchDurationMs: 0,
        batchAvailable: false,
        sendingAudio: false,
        message: null,
        engineLabel: 'On-device',
        agentName: 'Aria',
      }),
    ).toBe(false);
    m.open({ contactId: 've-1' });
    expect(
      m.pushSession('ve-1', {
        contactId: 've-1',
        status: 'listening',
        preview: 'hello',
        buffer: '',
        cloudTranscription: false,
        batchDurationMs: 0,
        batchAvailable: false,
        sendingAudio: false,
        message: null,
        engineLabel: 'On-device',
        agentName: 'Aria',
      }),
    ).toBe(true);
    expect(created[0].sent.at(-1)?.channel).toBe('nexus:companion:session');
  });

  it('raise shows + focuses a minimized companion and restores focus', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    created[0].visible = false;
    created[0].minimized = true;
    created[0].focused = false;
    expect(m.raise('ve-1')).toBe(true);
    expect(created[0].visible).toBe(true);
    expect(created[0].minimized).toBe(false);
    expect(created[0].focused).toBe(true);
    // A wake must not silently (un)pin the companion.
    expect(m.isAlwaysOnTop('ve-1')).toBe(false);
  });

  it('raise returns false for an unknown contact', () => {
    const m = manager();
    expect(m.raise('nope')).toBe(false);
  });

  it('makes the newest companion the single STT owner and demotes the rest', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    expect(m.sttOwnerId()).toBe('ve-1');
    m.open({ contactId: 've-2' });
    expect(m.sttOwnerId()).toBe('ve-2');
    // Both windows were told their role; only ve-2 is primary.
    const lastFor = (index: number) =>
      created[index].sent.filter((s) => s.channel === 'nexus:companion:stt-owner').at(-1);
    expect(lastFor(0)?.payload).toMatchObject({ contactId: 've-1', primary: false });
    expect(lastFor(1)?.payload).toMatchObject({ contactId: 've-2', primary: true });
  });

  it('a wake switches STT ownership to the addressed companion', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    m.open({ contactId: 've-2' });
    expect(m.sttOwnerId()).toBe('ve-2');
    m.present('ve-1', {
      contactId: 've-1',
      conversationId: null,
      agentId: null,
      phrase: 'Aria',
      dictate: true,
      token: 1,
    });
    expect(m.sttOwnerId()).toBe('ve-1');
    const owner = created[0].sent.filter((s) => s.channel === 'nexus:companion:stt-owner').at(-1);
    expect(owner?.payload).toMatchObject({ primary: true, reason: 'wake' });
  });

  it('hands STT ownership to a survivor when the owner closes', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    m.open({ contactId: 've-2' });
    expect(m.sttOwnerId()).toBe('ve-2');
    m.close('ve-2');
    expect(m.sttOwnerId()).toBe('ve-1');
    const survivor = created[0].sent.filter((s) => s.channel === 'nexus:companion:stt-owner').at(-1);
    expect(survivor?.payload).toMatchObject({ contactId: 've-1', primary: true });
  });

  it('never re-broadcasts for a redundant switch (no call restart)', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    const before = created[0].sent.filter((s) => s.channel === 'nexus:companion:stt-owner').length;
    m.present('ve-1', {
      contactId: 've-1',
      conversationId: null,
      agentId: null,
      phrase: 'Aria',
      dictate: true,
      token: 2,
    });
    const after = created[0].sent.filter((s) => s.channel === 'nexus:companion:stt-owner').length;
    expect(after).toBe(before);
  });

  it('claimStt refocuses ownership and reports unknown contacts', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    m.open({ contactId: 've-2' });
    expect(m.claimStt('ve-1')).toBe(true);
    expect(m.sttOwnerId()).toBe('ve-1');
    expect(m.claimStt('nope')).toBe(false);
  });

  it('re-states the election when a window finishes loading late', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    m.open({ contactId: 've-2' });
    // A (re)load of the already-open, now-demoted window would leave it believing
    // it owns the mic — the did-finish-load push must correct it.
    const sttMessages = () =>
      created[0].sent.filter((s) => s.channel === 'nexus:companion:stt-owner').length;
    const before = sttMessages();
    created[0].emitContents('did-finish-load');
    expect(sttMessages()).toBeGreaterThan(before);
    const latest = created[0].sent
      .filter((s) => s.channel === 'nexus:companion:stt-owner')
      .at(-1);
    expect(latest?.payload).toMatchObject({ contactId: 've-1', primary: false });
    const ownerLatest = created[1].sent
      .filter((s) => s.channel === 'nexus:companion:stt-owner')
      .at(-1);
    expect(ownerLatest?.payload).toMatchObject({ contactId: 've-2', primary: true });
  });
});

describe('defaultCompanionPreloadPath', () => {
  it('points at the emitted preload subfolder', () => {
    expect(defaultCompanionPreloadPath().replace(/\\/g, '/')).toMatch(/preload\/preload\.cjs$/);
  });
});
