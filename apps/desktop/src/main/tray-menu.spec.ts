import { describe, expect, it, vi } from 'vitest';
import { buildTrayMenu, type TrayMenuItem } from './tray-menu.js';
import type { TrayAppItem } from '../shared/nexus-apps.js';

/**
 * A tray item as `resolveTrayApps` would emit it: the id is namespaced by source
 * (`app:<clientId>` / `custom:<entryId>`), which is what the menu renders.
 */
function item(over: Partial<TrayAppItem> & { key: string; url: string }): TrayAppItem {
  const source = over.source ?? 'installed';
  const { key, ...rest } = over;
  return {
    id: source === 'custom' ? `custom:${key}` : `app:${key}`,
    label: key,
    source,
    clientId: source === 'custom' ? null : key,
    orgId: null,
    orgName: null,
    ...rest,
  };
}

/**
 * The id of every *item* in order. Separators carry no id, so they are dropped:
 * they are structural padding and are asserted separately where it matters.
 */
function ids(menu: TrayMenuItem[]): string[] {
  return menu.flatMap((m) => (m.id === undefined ? [] : [m.id]));
}

/** True when `menu` has a separator immediately before the item with `id`. */
function separatorBefore(menu: TrayMenuItem[], id: string): boolean {
  const index = menu.findIndex((m) => m.id === id);
  return index > 0 && menu[index - 1]!.type === 'separator';
}

function base(over: Partial<Parameters<typeof buildTrayMenu>[0]> = {}) {
  return {
    signedIn: false,
    portalUrl: null as string | null,
    appItems: [] as TrayAppItem[],
    onShow: vi.fn(),
    onQuit: vi.fn(),
    onOpenUrl: vi.fn(),
    ...over,
  };
}

describe('buildTrayMenu', () => {
  it('always keeps Show Nexus and Quit, even signed out with no portal', () => {
    const menu = buildTrayMenu(base());
    expect(ids(menu)).toEqual(['show', 'quit']);
    expect(menu[0]!.click).toBeTypeOf('function');
    expect(menu[menu.length - 1]!.click).toBeTypeOf('function');
  });

  it('adds Open portal only for a safe url, and opens it on click', () => {
    const input = base({ portalUrl: 'https://portal.example.com' });
    const menu = buildTrayMenu(input);
    const portal = menu.find((m) => m.id === 'portal')!;
    expect(portal.label).toBe('Open portal');
    portal.click!();
    expect(input.onOpenUrl).toHaveBeenCalledWith('https://portal.example.com');
  });

  it('drops an unsafe portal url but keeps the essential items', () => {
    const menu = buildTrayMenu(base({ portalUrl: 'javascript:alert(1)' }));
    expect(ids(menu)).toEqual(['show', 'quit']);
  });

  it('shows no app section when signed out', () => {
    const menu = buildTrayMenu(base({ appItems: [item({ key: 'xcamp', url: 'https://x.example.com' })] }));
    expect(ids(menu)).toEqual(['show', 'quit']);
  });

  it('shows no app section when signed in but the list is empty', () => {
    const menu = buildTrayMenu(base({ signedIn: true }));
    expect(ids(menu)).toEqual(['show', 'quit']);
  });

  it('lists apps flat when they all share one (personal) group', () => {
    const input = base({
      signedIn: true,
      appItems: [
        item({ key: 'xcamp', label: 'Xcamp', url: 'https://xcamp.example.com' }),
        item({ key: 'docs', label: 'Docs', url: 'https://docs.example.com', source: 'custom', clientId: null }),
      ],
    });
    const menu = buildTrayMenu(input);
    expect(ids(menu)).toEqual(['show', 'apps', 'app:xcamp', 'custom:docs', 'quit']);
    // The app section is visually separated from "Show Nexus" and "Quit".
    expect(separatorBefore(menu, 'apps')).toBe(true);
    expect(separatorBefore(menu, 'quit')).toBe(true);
    const xcamp = menu.find((m) => m.id === 'app:xcamp')!;
    xcamp.click!();
    expect(input.onOpenUrl).toHaveBeenCalledWith('https://xcamp.example.com');
  });

  it('nests apps under an org submenu when there is more than one group', () => {
    const menu = buildTrayMenu(
      base({
        signedIn: true,
        appItems: [
          item({ key: 'a', label: 'A', url: 'https://a.example.com', orgId: 'o1', orgName: 'Acme' }),
          item({ key: 'b', label: 'B', url: 'https://b.example.com', orgId: 'o2', orgName: 'Beta' }),
        ],
      }),
    );
    const groupIds = menu.filter((m) => m.submenu).map((m) => m.id).sort();
    expect(groupIds).toEqual(['apps:group:o1', 'apps:group:o2']);
  });

  it('never renders an app item whose url is unsafe', () => {
    const menu = buildTrayMenu(
      base({
        signedIn: true,
        appItems: [item({ key: 'evil', url: 'javascript:alert(1)' })],
      }),
    );
    expect(ids(menu)).toEqual(['show', 'quit']);
  });
});
