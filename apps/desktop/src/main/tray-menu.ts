/**
 * Tray context-menu template (pure).
 *
 * Builds the plain template the main process hands to
 * `Menu.buildFromTemplate`. Kept free of Electron types so the menu shape is
 * unit-testable: the caller injects the click handlers.
 *
 * INVARIANTS (a broken tray must never strand the user):
 *  - "Show Nexus" and "Quit" are **always** present, whatever happens with the
 *    portal URL or the app list.
 *  - Only http(s) URLs become menu items; an unsafe URL is dropped.
 *  - The dynamic app list is omitted entirely (not shown empty) when the user is
 *    signed out or no app could be resolved.
 */

import {
  groupTrayApps,
  isSafeExternalUrl,
  type TrayAppItem,
} from '../shared/nexus-apps.js';

export type TrayMenuItem = {
  /** Stable id for tests / debugging; Electron ignores unknown keys. */
  id?: string;
  label?: string;
  type?: 'separator' | 'normal' | 'checkbox';
  enabled?: boolean;
  /** Present on `checkbox` items; Electron renders the tick. */
  checked?: boolean;
  /** Present on leaf items; absent on parents/separators. */
  click?: () => void;
  submenu?: TrayMenuItem[];
};

export type TrayMenuInput = {
  signedIn: boolean;
  portalUrl: string | null;
  appItems: TrayAppItem[];
  /** Master OS-notification switch (mirrors `NotificationSettings.enabled`). */
  notificationsEnabled: boolean;
  /** Whether an inbound message pops the companion (mirrors `contactOverrides`). */
  openCompanionOnMessage: boolean;
  onShow: () => void;
  onQuit: () => void;
  onOpenUrl: (url: string) => void;
  onToggleNotifications: () => void;
  onToggleOpenCompanion: () => void;
};

/**
 * Build the tray menu.
 *
 * The app section is grouped by org when more than one group exists, so a user
 * with several org memberships can tell whose installs they are looking at; a
 * single group is rendered flat to avoid a pointless submenu.
 */
export function buildTrayMenu(input: TrayMenuInput): TrayMenuItem[] {
  const items: TrayMenuItem[] = [
    { id: 'show', label: 'Show Nexus', click: input.onShow },
  ];

  if (input.portalUrl && isSafeExternalUrl(input.portalUrl)) {
    const url = input.portalUrl;
    items.push({ id: 'portal', label: 'Open portal', click: () => input.onOpenUrl(url) });
  }

  const appItems = (input.appItems ?? []).filter((item) => isSafeExternalUrl(item.url));
  // Signed out: no app section at all. Signed in but empty: also omitted, so the
  // menu degrades to "Show Nexus" + "Open portal" rather than an empty heading.
  if (input.signedIn && appItems.length > 0) {
    items.push({ type: 'separator' });
    items.push({
      id: 'apps',
      label: 'Nexus apps',
      enabled: false,
    });

    const groups = groupTrayApps(appItems);
    if (groups.length > 1) {
      for (const group of groups) {
        items.push({
          id: `apps:group:${group.key || 'personal'}`,
          label: group.label ?? 'Personal',
          submenu: group.items.map((item) => ({
            id: item.id,
            label: item.label,
            click: () => input.onOpenUrl(item.url),
          })),
        });
      }
    } else {
      for (const item of groups[0]!.items) {
        items.push({
          id: item.id,
          label: item.label,
          click: () => input.onOpenUrl(item.url),
        });
      }
    }
  }

  items.push({ type: 'separator' });
  // Quick toggles mirror the Settings switches so the user can silence OS
  // notifications or stop the companion popping over an app without a trip
  // through Settings. Checkbox items report their *next* state via `onToggle*`.
  items.push({
    id: 'toggle-notifications',
    type: 'checkbox',
    label: 'OS notifications',
    checked: input.notificationsEnabled,
    click: input.onToggleNotifications,
  });
  items.push({
    id: 'toggle-open-companion',
    type: 'checkbox',
    label: 'Open companion on message',
    checked: input.openCompanionOnMessage,
    click: input.onToggleOpenCompanion,
  });
  items.push({ type: 'separator' });
  items.push({ id: 'quit', label: 'Quit', click: input.onQuit });
  return items;
}
