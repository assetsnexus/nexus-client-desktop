// @vitest-environment jsdom
/**
 * Rendering spec for the storage-hub Access-audit section.
 *
 * The audit surface's contract is a filter + page + revoke one, with two rules
 * that must not regress:
 *  - a **failed** request renders its own retry state, never the "no accesses"
 *    empty state (which would read as "nothing ever happened");
 *  - a revoke is only ever dispatched **after** a confirm dialog that names what
 *    is being revoked — never on a single click.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  send: vi.fn(),
  getConnectionConfig: vi.fn(),
  getAuthState: vi.fn(),
  getUiSettings: vi.fn(),
  setUiSettings: vi.fn(),
}));

vi.mock('../../bridge.js', () => ({
  bridge: {
    getConnectionConfig: () => h.getConnectionConfig(),
    getAuthState: () => h.getAuthState(),
    getUiSettings: () => h.getUiSettings(),
    setUiSettings: (patch: unknown) => h.setUiSettings(patch),
  },
}));

vi.mock('../settings/desktopCommandClient.js', () => ({
  createDesktopCommandClient: () => ({ send: h.send }),
}));

import { I18nProvider } from '../../i18n/index.js';
import { AuditSection } from './AuditSection.js';

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

/** Click a button that lives inside the open confirm dialog. */
function clickInDialog(label: string): void {
  const dialog = container!.querySelector('[role="dialog"]');
  expect(dialog, 'confirm dialog').toBeTruthy();
  const target = Array.from(dialog!.querySelectorAll('button')).find(
    (button) => (button.textContent ?? '').trim() === label,
  );
  expect(target, `dialog button "${label}"`).toBeTruthy();
  act(() => {
    target!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function dialogText(): string {
  return container!.querySelector('[role="dialog"]')?.textContent ?? '';
}

/** Route `send` by command name so a section's calls each answer. */
function routeSend(map: Record<string, unknown>): void {
  h.send.mockImplementation(async (command: string) => map[command] ?? { ok: false });
}

/** The last payload sent for a given command. */
function lastPayload(command: string): Record<string, unknown> | undefined {
  const calls = h.send.mock.calls.filter((call) => call[0] === command);
  return calls.length ? (calls[calls.length - 1][1] as Record<string, unknown>) : undefined;
}

const SAMPLE_ROW = {
  id: 'row-1',
  timestamp: '2026-01-02T03:04:05.000Z',
  operation: 'read_text',
  operationClass: 'read',
  accessor: { kind: 'agent', id: 'agent-abcdef0123456789', label: 'Selene' },
  path: '/clients/acme/contract.pdf',
  workspaceId: 'ws-1',
};

describe('AuditSection', () => {
  it('lists accesses with a resolved accessor label and a human timestamp', async () => {
    routeSend({
      'anx.storage.access-audit.list': {
        ok: true,
        responseCode: 200,
        data: { items: [SAMPLE_ROW] },
      },
    });
    await mount(createElement(AuditSection));
    const body = text();
    expect(body).toContain('Selene');
    expect(body).toContain('/clients/acme/contract.pdf');
    // The timestamp is formatted, not the raw ISO string.
    expect(body).not.toContain('2026-01-02T03:04:05.000Z');
    expect(h.send).toHaveBeenCalledWith(
      'anx.storage.access-audit.list',
      expect.objectContaining({ group: 'none', limit: 50 }),
    );
  });

  it('flags an unattributed service access explicitly instead of a bare id', async () => {
    routeSend({
      'anx.storage.access-audit.list': {
        ok: true,
        responseCode: 200,
        data: { items: [{ id: 'row-2', operation: 'read', accessorUnattributed: true }] },
      },
    });
    await mount(createElement(AuditSection));
    expect(text()).toContain('Unattributed service access');
  });

  it('renders the empty state when the region returns nothing', async () => {
    routeSend({
      'anx.storage.access-audit.list': { ok: true, responseCode: 200, data: { items: [] } },
    });
    await mount(createElement(AuditSection));
    expect(text()).toContain('No accesses match these filters.');
  });

  it('surfaces a region error with a retry and never the empty state', async () => {
    routeSend({
      'anx.storage.access-audit.list': { ok: false, responseCode: 403, responseObject: { error: 'Forbidden' } },
    });
    await mount(createElement(AuditSection));
    expect(text()).toContain('Could not load: Forbidden');
    expect(text()).not.toContain('No accesses match these filters.');
    expect(text()).toContain('Retry');

    // Retry re-issues the request.
    const before = h.send.mock.calls.length;
    clickByText('Retry');
    await settle();
    expect(h.send.mock.calls.length).toBeGreaterThan(before);
  });

  it('switches the direction filter and restarts from the first page', async () => {
    routeSend({
      'anx.storage.access-audit.list': {
        ok: true,
        responseCode: 200,
        data: { items: [SAMPLE_ROW], nextCursor: 'c1' },
      },
    });
    await mount(createElement(AuditSection));
    clickByText('Next');
    await settle();
    expect(lastPayload('anx.storage.access-audit.list')?.cursor).toBe('c1');

    clickByText('Write');
    await settle();
    // A changed filter must drop the keyset cursor and ask for a direction.
    const payload = lastPayload('anx.storage.access-audit.list');
    expect(payload?.direction).toBe('write');
    expect(payload).not.toHaveProperty('cursor');
  });

  it('pages with a keyset cursor and returns to the exact previous page', async () => {
    routeSend({
      'anx.storage.access-audit.list': {
        ok: true,
        responseCode: 200,
        data: { items: [SAMPLE_ROW], nextCursor: 'c1' },
      },
    });
    await mount(createElement(AuditSection));
    clickByText('Next');
    await settle();
    expect(lastPayload('anx.storage.access-audit.list')?.cursor).toBe('c1');

    clickByText('Previous');
    await settle();
    // Back on page one: no cursor, never a recomputed offset.
    expect(lastPayload('anx.storage.access-audit.list')).not.toHaveProperty('cursor');
  });

  it('opens a confirm dialog and only revokes after confirmation', async () => {
    routeSend({
      'anx.storage.access-audit.list': {
        ok: true,
        responseCode: 200,
        data: {
          items: [{ ...SAMPLE_ROW, grantKind: 'share', grantId: 'g-1' }],
        },
      },
      'anx.storage.access-audit.revoke-grant': {
        ok: true,
        responseCode: 200,
        data: { revoked: true, grantKind: 'share', grantId: 'g-1' },
      },
    });
    await mount(createElement(AuditSection));

    clickByText('Revoke access');
    await settle();
    // The dialog names what will be revoked...
    expect(dialogText()).toContain('share link');
    // ...and nothing has been sent yet.
    expect(h.send).not.toHaveBeenCalledWith(
      'anx.storage.access-audit.revoke-grant',
      expect.anything(),
    );

    clickInDialog('Revoke access');
    await settle();
    expect(h.send).toHaveBeenCalledWith('anx.storage.access-audit.revoke-grant', {
      grantKind: 'share',
      grantId: 'g-1',
    });
    expect(text()).toContain('Access revoked.');
  });

  it('can cancel the confirm dialog without revoking', async () => {
    routeSend({
      'anx.storage.access-audit.list': {
        ok: true,
        responseCode: 200,
        data: { items: [{ ...SAMPLE_ROW, grantKind: 'data_room_share', grantId: 'g-2' }] },
      },
    });
    await mount(createElement(AuditSection));
    clickByText('Revoke access');
    await settle();
    clickInDialog('Cancel');
    await settle();
    expect(container!.querySelector('[role="dialog"]')).toBeNull();
    expect(h.send).not.toHaveBeenCalledWith(
      'anx.storage.access-audit.revoke-grant',
      expect.anything(),
    );
  });

  it("shows the region's refusal inside the confirm dialog", async () => {
    routeSend({
      'anx.storage.access-audit.list': {
        ok: true,
        responseCode: 200,
        data: { items: [{ ...SAMPLE_ROW, grantKind: 'share', grantId: 'g-1' }] },
      },
      'anx.storage.access-audit.revoke-grant': {
        ok: false,
        responseCode: 403,
        responseObject: { error: 'Not the owner' },
      },
    });
    await mount(createElement(AuditSection));
    clickByText('Revoke access');
    await settle();
    clickInDialog('Revoke access');
    await settle();
    expect(dialogText()).toContain('Not the owner');
  });

  it('does not offer revoke on a row without a grant', async () => {
    routeSend({
      'anx.storage.access-audit.list': {
        ok: true,
        responseCode: 200,
        data: { items: [SAMPLE_ROW] },
      },
    });
    await mount(createElement(AuditSection));
    const buttons = Array.from(container!.querySelectorAll('button'));
    const revokeButtons = buttons.filter(
      (button) => (button.textContent ?? '').trim() === 'Revoke access',
    );
    expect(revokeButtons).toHaveLength(0);
  });

  it('renders the signed-out hint when there is no session', async () => {
    h.getAuthState.mockResolvedValue({ status: 'signed_out' });
    await mount(createElement(AuditSection));
    expect(text()).toContain('Sign in to see your collections.');
    expect(h.send).not.toHaveBeenCalled();
  });
});
