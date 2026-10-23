/**
 * Tray "Nexus apps" list — pure, host-agnostic.
 *
 * "Installed Nexus apps" are third-party apps the user (or one of their org
 * memberships) connected through *Login with ANX* (OAuth2). The region exposes
 * them as OAuth2 **grants** (`anx.oauth2.grants.list`): each row carries the
 * client's display fields plus an optional `clientPortalLauncher`
 * (`{ enabled, label, launchUrl }`) that says where the app wants to be opened.
 *
 * This module owns two things, both unit-testable with no Electron and no
 * region:
 *  - the persisted allow/deny + custom-entry settings shape, validated here so a
 *    hand-edited `settings.json` can never inject a non-http(s) URL, and
 *  - `resolveTrayApps` / `groupTrayApps`, the pure projection of
 *    "fetched apps + settings" → the ordered list the tray menu renders.
 *
 * SECURITY: every URL that reaches the tray goes through `isSafeExternalUrl`
 * (http/https only). The main process re-checks before `shell.openExternal`.
 */

export type AppVisibilityMode = 'allow' | 'deny';

/** A user-added tray entry (label + URL). Always shown, never filtered. */
export type CustomTrayApp = {
  id: string;
  label: string;
  url: string;
};

/**
 * Tray app visibility preferences.
 *
 * `allow` is a whitelist and `deny` a blacklist; only the list matching `mode`
 * is consulted. An **empty** allow list is read as "no restriction yet" so
 * flipping to allow mode never silently blanks the tray.
 */
export type TrayAppSettings = {
  mode: AppVisibilityMode;
  /** Client ids explicitly allowed (consulted in `allow` mode). */
  allow: string[];
  /** Client ids explicitly denied (consulted in `deny` mode). */
  deny: string[];
  /** Custom entries; always appear, regardless of mode/lists. */
  custom: CustomTrayApp[];
};

export const DEFAULT_TRAY_APP_SETTINGS: TrayAppSettings = {
  // Deny-list by default: an app the user connected should show up unless they
  // deliberately hide it. Opting into a whitelist is an explicit choice.
  mode: 'deny',
  allow: [],
  deny: [],
  custom: [],
};

export const MAX_CUSTOM_TRAY_APPS = 50;
const MAX_LIST_ENTRIES = 200;
const MAX_LABEL_LENGTH = 60;

/** True only for absolute `http:`/`https:` URLs (the only schemes we open). */
export function isSafeExternalUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Host of a safe URL, used as a fallback label; empty for an unsafe one. */
export function safeHost(url: string): string {
  if (!isSafeExternalUrl(url)) return '';
  try {
    return new URL(url.trim()).host;
  } catch {
    return '';
  }
}

function normalizeIdList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || out.includes(trimmed)) continue;
    out.push(trimmed);
    if (out.length >= MAX_LIST_ENTRIES) break;
  }
  return out;
}

function normalizeCustomEntries(raw: unknown): CustomTrayApp[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomTrayApp[] = [];
  for (const row of raw) {
    if (out.length >= MAX_CUSTOM_TRAY_APPS) break;
    if (!row || typeof row !== 'object') continue;
    const value = row as Record<string, unknown>;
    const url = typeof value.url === 'string' ? value.url.trim() : '';
    // Unsafe or malformed URLs are dropped outright rather than repaired: a
    // custom entry can only ever be an http(s) link.
    if (!isSafeExternalUrl(url)) continue;
    const label =
      typeof value.label === 'string' && value.label.trim()
        ? value.label.trim().slice(0, MAX_LABEL_LENGTH)
        : safeHost(url);
    const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : `custom-${out.length}`;
    if (out.some((entry) => entry.id === id)) continue;
    out.push({ id, label, url });
  }
  return out;
}

/**
 * Coerce a persisted/patched tray-apps block to valid values, per-field.
 * Unknown keys are dropped so the settings file stays clean.
 */
export function normalizeTrayAppSettings(raw: unknown): TrayAppSettings {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    mode: value.mode === 'allow' ? 'allow' : 'deny',
    allow: normalizeIdList(value.allow),
    deny: normalizeIdList(value.deny),
    custom: normalizeCustomEntries(value.custom),
  };
}

/** A connected Nexus app as fetched from the region, ready for the tray. */
export type InstalledNexusApp = {
  /** OAuth2 client id — the stable identity of the app and the filter key. */
  clientId: string;
  label: string;
  /** Where the entry opens (launcher URL, else the client homepage). */
  url: string;
  /** Org the grant belongs to; null for a personal (individual) grant. */
  orgId: string | null;
  orgName: string | null;
};

/** One rendered tray entry. */
export type TrayAppItem = {
  id: string;
  label: string;
  url: string;
  source: 'installed' | 'custom';
  clientId: string | null;
  orgId: string | null;
  orgName: string | null;
};

/** A group of tray entries, one per org (plus a `null` group for personal). */
export type TrayAppGroup = {
  /** `orgId`, or `''` for the personal/custom group. */
  key: string;
  label: string | null;
  items: TrayAppItem[];
};

/**
 * Project fetched apps + settings into the ordered tray list.
 *
 * Order: visible installed apps (sorted by label), then custom entries in the
 * order the user added them. Custom entries are never filtered — they exist
 * precisely so a user can pin something the region does not know about.
 */
export function resolveTrayApps(input: {
  installed: InstalledNexusApp[];
  settings: TrayAppSettings;
}): TrayAppItem[] {
  const settings = normalizeTrayAppSettings(input.settings);
  const allow = new Set(settings.allow);
  const deny = new Set(settings.deny);

  const visible = (input.installed ?? []).filter((app) => {
    if (!app || typeof app.clientId !== 'string' || !app.clientId) return false;
    if (!isSafeExternalUrl(app.url)) return false;
    if (settings.mode === 'allow') return allow.size === 0 || allow.has(app.clientId);
    return !deny.has(app.clientId);
  });

  const seen = new Set<string>();
  const installed: TrayAppItem[] = [];
  for (const app of visible) {
    if (seen.has(app.clientId)) continue;
    seen.add(app.clientId);
    installed.push({
      id: `app:${app.clientId}`,
      label: app.label.trim() || app.clientId,
      url: app.url.trim(),
      source: 'installed',
      clientId: app.clientId,
      orgId: app.orgId,
      orgName: app.orgName,
    });
  }
  installed.sort((a, b) => a.label.localeCompare(b.label));

  const custom: TrayAppItem[] = settings.custom.map((entry) => ({
    id: `custom:${entry.id}`,
    label: entry.label,
    url: entry.url,
    source: 'custom',
    clientId: null,
    orgId: null,
    orgName: null,
  }));

  return [...installed, ...custom];
}

/**
 * Group entries by org. The tray only needs submenus when the user has apps
 * under more than one org; a single group is rendered flat by the caller.
 */
export function groupTrayApps(items: TrayAppItem[]): TrayAppGroup[] {
  const groups = new Map<string, TrayAppGroup>();
  for (const item of items) {
    const key = item.orgId ?? '';
    let group = groups.get(key);
    if (!group) {
      group = { key, label: item.orgName ?? (item.orgId ? item.orgId : null), items: [] };
      groups.set(key, group);
    } else if (!group.label && item.orgName) {
      group.label = item.orgName;
    }
    group.items.push(item);
  }
  return Array.from(groups.values());
}
