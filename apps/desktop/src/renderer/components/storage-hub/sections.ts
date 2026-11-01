/**
 * Storage-hub navigation metadata.
 *
 * One entry per section in the hub's left nav. `labelKey`/`helpKey` are i18n keys
 * (see `locales-storage.ts`); the icon is a plain emoji so the nav needs no icon
 * dependency. Kept separate from the section components so the nav renders before
 * any section is opened, mirroring `settings/sections.ts`.
 */

import { createContext, useContext } from 'react';
import type { MessageKey } from '../../i18n/index.js';
import type { StorageHubSectionId } from '../../../shared/ipc.js';

export type { StorageHubSectionId };

export type StorageNavEntry = {
  id: StorageHubSectionId;
  labelKey: MessageKey;
  icon: string;
  /** Optional one-line summary rendered under the section title. */
  helpKey?: MessageKey;
};

/**
 * Nav order is deliberate: the everyday file surfaces first (browse, mounts,
 * sync), then the more technical agent-access surfaces (folders, access) last —
 * the "advanced" half of the normal/advanced split.
 */
export const STORAGE_NAV: readonly StorageNavEntry[] = [
  { id: 'browse', labelKey: 'storage.nav.browse', icon: '🗂️', helpKey: 'storage.browse.help' },
  { id: 'mounts', labelKey: 'storage.nav.mounts', icon: '💽', helpKey: 'storage.mounts.help' },
  { id: 'sync', labelKey: 'storage.nav.sync', icon: '🔄', helpKey: 'storage.sync.help' },
  { id: 'folders', labelKey: 'storage.nav.folders', icon: '📁', helpKey: 'storage.folders.help' },
  { id: 'access', labelKey: 'storage.nav.access', icon: '🔑', helpKey: 'storage.access.help' },
];

export const DEFAULT_STORAGE_SECTION: StorageHubSectionId = 'browse';

/**
 * Lets a section deep-link to another (e.g. Access → "Grant access…" jumps to
 * Agent folders with the path prefilled). The shell provides the setter; a
 * section rendered without a provider gets a no-op, so it still renders.
 */
export type StorageNavTarget = {
  section: StorageHubSectionId;
  /** Optional prefill carried across a jump (e.g. a path to grant). */
  path?: string;
};

export const StorageNavContext = createContext<(target: StorageNavTarget) => void>(() => {});

/** The section-navigation callback, safe to call without a provider. */
export function useStorageNav(): (target: StorageNavTarget) => void {
  return useContext(StorageNavContext);
}

/**
 * Human label for a workspace in a `<select>`: personal rows read "My Storage",
 * org rows read "Org Storage — Acme Corp" so two orgs with the same default
 * workspace name are still distinguishable.
 */
export function workspaceOptionLabel(w: {
  name: string;
  isOrg?: boolean;
  orgName?: string | null;
}): string {
  if (w.isOrg && w.orgName) return `${w.name} — ${w.orgName}`;
  return w.name;
}
