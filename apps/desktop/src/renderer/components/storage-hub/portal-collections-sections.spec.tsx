// @vitest-environment jsdom
/**
 * Rendering spec for the two portal-managed collection sections.
 *
 * The requirement for these surfaces is deliberately narrow: **list** what the
 * caller can see (with the counts the portal shows), render an honest empty state,
 * and hand management to the portal. So the assertions here cover exactly that —
 * rows render with their counts, the empty state renders when the region returns
 * nothing, a region error surfaces its message rather than looking like "you have
 * none", and the manage/new buttons open the portal deep-link instead of
 * pretending to build CRUD in the desktop.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  send: vi.fn(),
  getConnectionConfig: vi.fn(),
  getAuthState: vi.fn(),
  openExternal: vi.fn(),
  getUiSettings: vi.fn(),
  setUiSettings: vi.fn(),
}));

vi.mock('../../bridge.js', () => ({
  bridge: {
    getConnectionConfig: () => h.getConnectionConfig(),
    getAuthState: () => h.getAuthState(),
    openExternal: (url: string) => h.openExternal(url),
    getUiSettings: () => h.getUiSettings(),
    setUiSettings: (patch: unknown) => h.setUiSettings(patch),
  },
}));

vi.mock('../settings/desktopCommandClient.js', () => ({
  createDesktopCommandClient: () => ({ send: h.send }),
}));

import { I18nProvider } from '../../i18n/index.js';
import { CloudWorkspacesSection } from './CloudWorkspacesSection.js';
import { DataRoomsSection } from './DataRoomsSection.js';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const SIGNED_IN = {
  status: 'signed_in' as const,
  token: 'tok',
  identity: { userId: 'u1', orgId: 'org-acme', role: 'member', deviceId: 'd1' },
};

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  for (const fn of Object.values(h)) fn.mockReset();
  h.getConnectionConfig.mockResolvedValue({
    regionUrl: 'https://region.test',
    portalUrl: 'https://portal.test',
  });
  h.getAuthState.mockResolvedValue(SIGNED_IN);
  h.getUiSettings.mockResolvedValue({ locale: 'en' });
  h.setUiSettings.mockResolvedValue({ locale: 'en' });
  h.openExternal.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
});

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(element: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root!.render(createElement(I18nProvider, null, element));
  });
  await settle();
}

function text(): string {
  return container!.textContent ?? '';
}

function clickByText(label: string): void {
  const buttons = Array.from(container!.querySelectorAll('button'));
  const target = buttons.find((button) => (button.textContent ?? '').trim() === label);
  expect(target, `button "${label}"`).toBeTruthy();
  act(() => {
    target!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Route `send` by command name so a section's multiple calls each answer. */
function routeSend(map: Record<string, unknown>): void {
  h.send.mockImplementation(async (command: string) => map[command] ?? { ok: false });
}

describe('DataRoomsSection', () => {
  it('lists rooms with item, share and view counts', async () => {
    routeSend({
      'anx.data-room.list': {
        ok: true,
        responseCode: 200,
        data: {
          items: [
            {
              id: 'dr-1',
              name: 'Series A',
              ownerScope: 'org',
              orgId: 'org-acme',
              visibility: 'org',
              itemCount: 4,
              activeShareCount: 2,
            },
          ],
          total: 1,
        },
      },
      'anx.data-room.analytics.summary': {
        ok: true,
        responseCode: 200,
        data: { visits: 7, uniqueViewers: 5 },
      },
    });
    await mount(createElement(DataRoomsSection));
    const body = text();
    expect(body).toContain('Series A');
    expect(body).toContain('4 items');
    expect(body).toContain('2 live shares');
    expect(body).toContain('7 views');
    expect(body).toContain('1 total');
    // The default filter is "Mine" and the request carries it.
    expect(h.send).toHaveBeenCalledWith('anx.data-room.list', expect.objectContaining({ filter: 'mine' }));
  });

  it('renders the empty state when the region returns no rooms', async () => {
    routeSend({
      'anx.data-room.list': { ok: true, responseCode: 200, data: { items: [], total: 0 } },
    });
    await mount(createElement(DataRoomsSection));
    expect(text()).toContain('No data rooms yet');
    expect(text()).not.toContain('live shares');
  });

  it('surfaces a region error instead of an empty list', async () => {
    routeSend({
      'anx.data-room.list': { ok: false, responseCode: 403, responseObject: { error: 'Forbidden' } },
    });
    await mount(createElement(DataRoomsSection));
    expect(text()).toContain('Could not load: Forbidden');
    expect(text()).not.toContain('No data rooms yet');
  });

  it('leaves the views column unavailable when the summary is refused', async () => {
    routeSend({
      'anx.data-room.list': {
        ok: true,
        responseCode: 200,
        data: { items: [{ id: 'dr-1', name: 'Series A', itemCount: 1 }], total: 1 },
      },
      'anx.data-room.analytics.summary': { ok: false, responseCode: 403, responseObject: { error: 'Forbidden' } },
    });
    await mount(createElement(DataRoomsSection));
    expect(text()).toContain('views unavailable');
  });

  it('switches to the shared-with-me filter', async () => {
    routeSend({
      'anx.data-room.list': { ok: true, responseCode: 200, data: { items: [], total: 0 } },
    });
    await mount(createElement(DataRoomsSection));
    clickByText('Shared with me');
    await settle();
    expect(h.send).toHaveBeenCalledWith(
      'anx.data-room.list',
      expect.objectContaining({ filter: 'shared_with_me' }),
    );
  });

  it('opens the portal list for management instead of building CRUD here', async () => {
    routeSend({
      'anx.data-room.list': { ok: true, responseCode: 200, data: { items: [], total: 0 } },
    });
    await mount(createElement(DataRoomsSection));
    clickByText('New data room');
    await settle();
    expect(h.openExternal).toHaveBeenCalledWith('https://portal.test/b2b/data-rooms');
  });

  it('opens the personal portal list for a user without an org', async () => {
    h.getAuthState.mockResolvedValue({
      status: 'signed_in',
      token: 'tok',
      identity: { userId: 'u1', orgId: null, role: null, deviceId: 'd1' },
    });
    routeSend({
      'anx.data-room.list': { ok: true, responseCode: 200, data: { items: [], total: 0 } },
    });
    await mount(createElement(DataRoomsSection));
    clickByText('Manage in portal');
    await settle();
    expect(h.openExternal).toHaveBeenCalledWith('https://portal.test/user/data-rooms');
  });

  it('opens a room detail in the portal', async () => {
    routeSend({
      'anx.data-room.list': {
        ok: true,
        responseCode: 200,
        data: { items: [{ id: 'dr-9', name: 'Board', ownerScope: 'personal' }], total: 1 },
      },
      'anx.data-room.analytics.summary': { ok: false, responseCode: 403 },
    });
    await mount(createElement(DataRoomsSection));
    clickByText('Open');
    await settle();
    expect(h.openExternal).toHaveBeenCalledWith('https://portal.test/user/data-rooms/dr-9');
  });

  it('renders the signed-out hint when there is no session', async () => {
    h.getAuthState.mockResolvedValue({ status: 'signed_out' });
    await mount(createElement(DataRoomsSection));
    expect(text()).toContain('Sign in to see your collections.');
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe('CloudWorkspacesSection', () => {
  it('lists workspaces with item, member and people counts', async () => {
    routeSend({
      'anx.workspace.list': {
        ok: true,
        responseCode: 200,
        data: {
          items: [
            {
              id: 'ws-1',
              name: 'Client A',
              ownerScope: 'org',
              orgId: 'org-acme',
              accessMode: 'shared',
              itemCount: 3,
              memberCount: 2,
              humanUserCount: 2,
            },
          ],
          total: 1,
          hiddenCount: 4,
        },
      },
    });
    await mount(createElement(CloudWorkspacesSection));
    const body = text();
    expect(body).toContain('Client A');
    expect(body).toContain('3 items');
    expect(body).toContain('2 members');
    expect(body).toContain('2 people');
    expect(body).toContain('4 hidden');
    expect(h.send).toHaveBeenCalledWith('anx.workspace.list', expect.objectContaining({ visibility: 'shared' }));
  });

  it('renders the empty state when the region returns no workspaces', async () => {
    routeSend({
      'anx.workspace.list': { ok: true, responseCode: 200, data: { items: [], total: 0 } },
    });
    await mount(createElement(CloudWorkspacesSection));
    expect(text()).toContain('No cloud workspaces yet');
  });

  it('surfaces a region error instead of an empty list', async () => {
    routeSend({
      'anx.workspace.list': { ok: false, responseCode: 400, responseObject: { error: 'Bad request' } },
    });
    await mount(createElement(CloudWorkspacesSection));
    expect(text()).toContain('Could not load: Bad request');
    expect(text()).not.toContain('No cloud workspaces yet');
  });

  it('switches to the "all" visibility filter', async () => {
    routeSend({
      'anx.workspace.list': { ok: true, responseCode: 200, data: { items: [], total: 0 } },
    });
    await mount(createElement(CloudWorkspacesSection));
    clickByText('All');
    await settle();
    expect(h.send).toHaveBeenCalledWith('anx.workspace.list', expect.objectContaining({ visibility: 'all' }));
  });

  it('opens the org portal list for an org member', async () => {
    routeSend({
      'anx.workspace.list': { ok: true, responseCode: 200, data: { items: [], total: 0 } },
    });
    await mount(createElement(CloudWorkspacesSection));
    clickByText('New workspace');
    await settle();
    // The signed-in identity carries an orgId, so management lands on the /b2b
    // console even though the list came back empty.
    expect(h.openExternal).toHaveBeenCalledWith('https://portal.test/b2b/workspaces');
  });

  it('opens the personal portal list for a user without an org', async () => {
    h.getAuthState.mockResolvedValue({
      status: 'signed_in',
      token: 'tok',
      identity: { userId: 'u1', orgId: null, role: null, deviceId: 'd1' },
    });
    routeSend({
      'anx.workspace.list': { ok: true, responseCode: 200, data: { items: [], total: 0 } },
    });
    await mount(createElement(CloudWorkspacesSection));
    clickByText('New workspace');
    await settle();
    expect(h.openExternal).toHaveBeenCalledWith('https://portal.test/user/workspaces');
  });

  it('opens a workspace detail in the portal', async () => {
    routeSend({
      'anx.workspace.list': {
        ok: true,
        responseCode: 200,
        data: { items: [{ id: 'ws-9', name: 'Client B', orgId: 'org-acme' }], total: 1 },
      },
    });
    await mount(createElement(CloudWorkspacesSection));
    clickByText('Open');
    await settle();
    expect(h.openExternal).toHaveBeenCalledWith('https://portal.test/b2b/workspaces/ws-9');
  });

  it('renders the signed-out hint when there is no session', async () => {
    h.getAuthState.mockResolvedValue({ status: 'signed_out' });
    await mount(createElement(CloudWorkspacesSection));
    expect(text()).toContain('Sign in to see your collections.');
    expect(h.send).not.toHaveBeenCalled();
  });
});
