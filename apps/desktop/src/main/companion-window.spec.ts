import { beforeEach, describe, expect, it, vi } from 'vitest';

const created: FakeWindow[] = [];

class FakeWindow {
  static destroyCount = 0;
  private static nextId = 1;
  /** Stable window handle id (the manager keys tool owners by it). */
  id = FakeWindow.nextId++;
  focused = false;
  closed = false;
  alwaysOnTop: boolean | null = null;
  visible = true;
  minimized = false;
  /** OS window caption, seeded from the create-time title and mutated by setTitle. */
  title: string;
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
    this.title = (options.title as string) ?? '';
  }
  setTitle(title: string) {
    this.title = title;
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
        retranscribing: false,
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
        retranscribing: false,
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

describe('detached companion tool windows (Deliverable 3)', () => {
  it('opens one window per (contact, tool) with the scoped hash', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    const tool = m.openTool({ tool: 'motion-feed', contactId: 've-1', agentName: 'Aria' });
    expect(tool).toEqual({ contactId: 've-1', tool: 'motion-feed' });
    const url = created.at(-1)!.loadURL.mock.calls[0][0];
    expect(url).toContain('#companion-tool?');
    expect(url).toContain('tool=motion-feed');
    expect(url).toContain('contactId=ve-1');
    // A tool window must never be treated as a companion (it holds no session).
    expect(m.openContactIds()).toEqual(['ve-1']);
  });

  it('refocuses an existing tool window instead of duplicating it', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    m.openTool({ tool: 'gestures', contactId: 've-1' });
    const first = created.at(-1)!;
    const count = created.length;
    m.openTool({ tool: 'gestures', contactId: 've-1' });
    expect(created).toHaveLength(count);
    expect(first.focused).toBe(true);
  });

  it('keeps each agent\'s tool windows separate', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    m.open({ contactId: 've-2' });
    m.openTool({ tool: 'motion-feed', contactId: 've-1' });
    m.openTool({ tool: 'motion-feed', contactId: 've-2' });
    expect(created).toHaveLength(4);
  });

  it('fails closed when the contact has no open companion', () => {
    const m = manager();
    expect(m.openTool({ tool: 'motion-feed', contactId: 've-9' })).toBeNull();
  });

  it('carries the conversation binding into the tool hash when one is known', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    m.openTool({
      tool: 'motion-feed',
      contactId: 've-1',
      agentName: 'Aria',
      conversationId: 'conv-9',
      agentId: 'agent-3',
      virtualEmployeeId: 've-1',
    });
    const url = created.at(-1)!.loadURL.mock.calls[0][0];
    // The tool window resolves the same live session as its companion, so the
    // address must ride the hash rather than being guessed at runtime.
    expect(url).toContain('conversationId=conv-9');
    expect(url).toContain('agentId=agent-3');
    expect(url).toContain('virtualEmployeeId=ve-1');
  });

  it('omits the conversation binding when it is unknown (never invents one)', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    m.openTool({ tool: 'motion-feed', contactId: 've-1' });
    const url = created.at(-1)!.loadURL.mock.calls[0][0];
    expect(url).not.toContain('conversationId=');
    expect(url).not.toContain('agentId=');
  });

  it('reports which tools are open to the owning companion, per contact', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    m.open({ contactId: 've-2' });
    m.openTool({ tool: 'gestures', contactId: 've-1' });
    const presences = (index: number) =>
      created[index].sent.filter((s) => s.channel === 'nexus:companion:tool-presence');
    expect(presences(0).at(-1)?.payload).toMatchObject({
      contactId: 've-1',
      open: true,
      tools: ['gestures'],
    });
    // Only the owner is told; a contact with no tool window hears nothing (its
    // menu simply starts with nothing open rather than a redundant push).
    expect(presences(1)).toHaveLength(0);
  });

  it('relays a snapshot only to the owner\'s windows, tagged by contact', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    m.open({ contactId: 've-2' });
    m.openTool({ tool: 'motion-feed', contactId: 've-1' });
    const mine = created.at(-1)!;
    const otherTool = (() => {
      m.openTool({ tool: 'motion-feed', contactId: 've-2' });
      return created.at(-1)!;
    })();
    const snapshot = { contactId: 've-1', statusMotions: null, gestures: ['wave'], actionFeed: [] };
    expect(m.publishToolSnapshot(snapshot)).toBe(true);
    expect(mine.sent.some((s) => s.channel === 'nexus:companion:tool-snapshot')).toBe(true);
    expect(otherTool.sent.some((s) => s.channel === 'nexus:companion:tool-snapshot')).toBe(false);
  });

  it('relays a tool edit back to the owning companion window', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    m.openTool({ tool: 'status-motions', contactId: 've-1' });
    const sync = { contactId: 've-1', statusMotions: { thinking: { clip: 'think' } } };
    expect(m.syncToolState(sync)).toBe(true);
    expect(created[0].sent.at(-1)).toEqual({ channel: 'nexus:companion:tool-sync', payload: sync });
  });

  it('returns false syncing to a contact with no companion', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    m.openTool({ tool: 'status-motions', contactId: 've-1' });
    expect(m.syncToolState({ contactId: 've-9', statusMotions: null })).toBe(false);
  });

  it('closes tool windows with their companion', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    m.openTool({ tool: 'motion-feed', contactId: 've-1' });
    const tool = created.at(-1)!;
    m.close('ve-1');
    expect(tool.closed).toBe(true);
    expect(m.openContactIds()).toEqual([]);
  });

  it('closeTool closes one tool and reports nothing when none matches', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    m.openTool({ tool: 'motion-feed', contactId: 've-1' });
    expect(m.closeTool('ve-1', 'gestures')).toBe(false);
    expect(m.closeTool('ve-1', 'motion-feed')).toBe(true);
  });
});

describe('companion window titles', () => {
  /**
   * The bug this pins: the caption was computed once from the launch hint. A
   * companion opened without a usable title showed `Nexus Companion` forever,
   * because nothing re-applied the caption after the renderer resolved the live
   * contact/room name. `retitle` is that missing path.
   */
  it('starts app-neutral without a usable title, then adopts the reported agent name', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    expect(created[0].title).toBe('Nexus Companion');

    expect(m.retitle({ contactId: 've-1', titles: [null, 'Aria'] })).toBe(true);
    expect(created[0].title).toBe('Nexus · Aria');
  });

  it('titles the window from the launch hint when one is usable', () => {
    const m = manager();
    m.open({ contactId: 've-1', title: 'Aria' });
    expect(created[0].title).toBe('Nexus · Aria');
  });

  it('refreshes the title when an already-open companion is reopened', () => {
    const m = manager();
    // Opened before the name was known — the caption starts generic.
    m.open({ contactId: 've-1' });
    expect(created[0].title).toBe('Nexus Companion');

    // Reopening from the header now carries the resolved name: the reuse branch
    // must correct the existing caption without reloading (a reload would restart
    // the live voice session).
    const second = m.open({ contactId: 've-1', title: 'Aria' });
    expect(second.opened).toBe(false);
    expect(created).toHaveLength(1);
    expect(created[0].loadURL).toHaveBeenCalledTimes(1);
    expect(created[0].title).toBe('Nexus · Aria');
  });

  it('rejects an id-shaped reported title and keeps the good name', () => {
    const m = manager();
    m.open({ contactId: 've-1', title: 'Aria' });
    expect(created[0].title).toBe('Nexus · Aria');

    // A raw region id is an address, not a name: it must not replace the caption.
    expect(m.retitle({ contactId: 've-1', titles: ['1792316062792-nm26u6zve'] })).toBe(true);
    expect(created[0].title).toBe('Nexus · Aria');
    expect(created[0].title).not.toContain('1792316062792');
  });

  it('does not downgrade a named window when a report resolves nothing', () => {
    const m = manager();
    m.open({ contactId: 've-1', title: 'Aria' });
    // A transient failed lookup resolves to no label; the caption must survive.
    expect(m.retitle({ contactId: 've-1', titles: [null, ''] })).toBe(true);
    expect(created[0].title).toBe('Nexus · Aria');
  });

  it('ignores the in-app floor literal so it never becomes `Nexus · Companion`', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    expect(created[0].title).toBe('Nexus Companion');
    // The companion renderer's fallback contact carries the literal `Companion`
    // before a real name resolves; reporting it must not pin a faux name.
    expect(m.retitle({ contactId: 've-1', titles: ['Companion'] })).toBe(true);
    expect(created[0].title).toBe('Nexus Companion');
    // ...and a real name arriving later still wins.
    m.retitle({ contactId: 've-1', titles: ['Aria'] });
    expect(created[0].title).toBe('Nexus · Aria');
  });

  it('titles a room companion with the room name, not the focused agent', () => {
    const m = manager();
    m.open({ contactId: 've-1', roomId: 'room-1', roomTitle: 'Writers', title: 'Aria' });
    expect(created[0].title).toBe('Nexus · Writers');
  });

  it('falls back to the focused agent when the room has no usable name', () => {
    const m = manager();
    m.open({ contactId: 've-1', roomId: 'room-1', title: 'Aria' });
    expect(created[0].title).toBe('Nexus · Aria');
  });

  it('re-titles a room companion from a live report', () => {
    const m = manager();
    m.open({ contactId: 've-1', roomId: 'room-1' });
    expect(created[0].title).toBe('Nexus Companion');
    m.retitle({ contactId: 've-1', titles: ['Writers'] });
    expect(created[0].title).toBe('Nexus · Writers');
  });

  it('reports false for an unknown contact or a closed window', () => {
    const m = manager();
    expect(m.retitle({ contactId: 'nope', titles: ['Aria'] })).toBe(false);
    m.open({ contactId: 've-1' });
    m.close('ve-1');
    expect(m.retitle({ contactId: 've-1', titles: ['Aria'] })).toBe(false);
  });

  it('re-titles a detached tool window from a report addressed to it', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    // Opened without a name: the caption is the bare tool label.
    m.openTool({ tool: 'motion-feed', contactId: 've-1' });
    const tool = created.at(-1)!;
    expect(tool.title).toBe('Motion feed');

    expect(m.retitle({ contactId: 've-1', titles: ['Aria'], tool: 'motion-feed' })).toBe(true);
    expect(tool.title).toBe('Motion feed · Aria');
  });

  it('refreshes a tool window caption when it is reopened with a name', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    m.openTool({ tool: 'gestures', contactId: 've-1' });
    const tool = created.at(-1)!;
    expect(tool.title).toBe('Gesture tester');
    m.openTool({ tool: 'gestures', contactId: 've-1', agentName: 'Aria' });
    expect(tool.title).toBe('Gesture tester · Aria');
  });

  it('never renders an id-shaped agent name in a tool caption', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    m.openTool({ tool: 'gestures', contactId: 've-1', agentName: '1792316062792-nm26u6zve' });
    expect(created.at(-1)!.title).toBe('Gesture tester');
  });

  it('reports false re-titling a tool window that is not open', () => {
    const m = manager();
    m.open({ contactId: 've-1' });
    expect(m.retitle({ contactId: 've-1', titles: ['Aria'], tool: 'motion-feed' })).toBe(false);
  });
});

describe('defaultCompanionPreloadPath', () => {
  it('points at the emitted preload subfolder', () => {
    expect(defaultCompanionPreloadPath().replace(/\\/g, '/')).toMatch(/preload\/preload\.cjs$/);
  });
});
