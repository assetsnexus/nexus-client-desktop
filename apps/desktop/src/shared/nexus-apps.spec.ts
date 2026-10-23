import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRAY_APP_SETTINGS,
  MAX_CUSTOM_TRAY_APPS,
  groupTrayApps,
  isSafeExternalUrl,
  normalizeTrayAppSettings,
  resolveTrayApps,
  safeHost,
  type InstalledNexusApp,
} from './nexus-apps.js';

function app(over: Partial<InstalledNexusApp> & { clientId: string }): InstalledNexusApp {
  return {
    label: over.clientId,
    url: `https://${over.clientId}.example.com`,
    orgId: null,
    orgName: null,
    ...over,
  };
}

describe('isSafeExternalUrl', () => {
  it('accepts only absolute http(s) urls', () => {
    expect(isSafeExternalUrl('https://app.example.com/x')).toBe(true);
    expect(isSafeExternalUrl('http://localhost:3000')).toBe(true);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeExternalUrl('data:text/html,x')).toBe(false);
    expect(isSafeExternalUrl('example.com')).toBe(false);
    expect(isSafeExternalUrl('')).toBe(false);
    expect(isSafeExternalUrl(null)).toBe(false);
    expect(isSafeExternalUrl(42)).toBe(false);
  });

  it('reports the host for a safe url only', () => {
    expect(safeHost('https://xcamp.example.com/app')).toBe('xcamp.example.com');
    expect(safeHost('not-a-url')).toBe('');
  });
});

describe('normalizeTrayAppSettings', () => {
  it('defaults to a deny list with no entries', () => {
    expect(normalizeTrayAppSettings(undefined)).toEqual(DEFAULT_TRAY_APP_SETTINGS);
  });

  it('keeps only allow/deny mode and de-duplicates ids', () => {
    const out = normalizeTrayAppSettings({
      mode: 'allow',
      allow: ['a', 'a', ' b ', '', 3, 'c'],
      deny: 'nope',
    });
    expect(out.mode).toBe('allow');
    expect(out.allow).toEqual(['a', 'b', 'c']);
    expect(out.deny).toEqual([]);
  });

  it('falls back to deny for an unknown mode', () => {
    expect(normalizeTrayAppSettings({ mode: 'bogus' }).mode).toBe('deny');
  });

  it('drops custom entries with a non-http(s) url', () => {
    const out = normalizeTrayAppSettings({
      custom: [
        { id: 'c1', label: 'Good', url: 'https://good.example.com' },
        { id: 'c2', label: 'Evil', url: 'javascript:alert(1)' },
        { id: 'c3', url: 'http://plain.example.com' },
      ],
    });
    expect(out.custom.map((c) => c.id)).toEqual(['c1', 'c3']);
    // A missing label falls back to the host, never an empty string.
    expect(out.custom[1]!.label).toBe('plain.example.com');
  });

  it('caps the number of custom entries', () => {
    const custom = Array.from({ length: MAX_CUSTOM_TRAY_APPS + 10 }, (_, i) => ({
      id: `c${i}`,
      label: `c${i}`,
      url: `https://c${i}.example.com`,
    }));
    expect(normalizeTrayAppSettings({ custom }).custom).toHaveLength(MAX_CUSTOM_TRAY_APPS);
  });
});

describe('resolveTrayApps', () => {
  const installed = [
    app({ clientId: 'xcamp', label: 'Xcamp', orgId: 'o1', orgName: 'Acme' }),
    app({ clientId: 'bookforge', label: 'Bookforge', orgId: 'o1', orgName: 'Acme' }),
    app({ clientId: 'personal', label: 'Personal App', orgId: null }),
  ];

  it('shows every installed app in deny mode when nothing is denied', () => {
    const items = resolveTrayApps({ installed, settings: DEFAULT_TRAY_APP_SETTINGS });
    expect(items.map((i) => i.clientId)).toEqual(['bookforge', 'personal', 'xcamp']);
  });

  it('hides denied apps in deny mode', () => {
    const items = resolveTrayApps({
      installed,
      settings: { mode: 'deny', allow: [], deny: ['xcamp'], custom: [] },
    });
    expect(items.map((i) => i.clientId)).toEqual(['bookforge', 'personal']);
  });

  it('treats an empty allow list as no restriction (never blanks the tray)', () => {
    const items = resolveTrayApps({
      installed,
      settings: { mode: 'allow', allow: [], deny: [], custom: [] },
    });
    expect(items).toHaveLength(3);
  });

  it('shows only allowed apps in allow mode (the deny list is ignored)', () => {
    const items = resolveTrayApps({
      installed,
      settings: { mode: 'allow', allow: ['xcamp'], deny: ['xcamp'], custom: [] },
    });
    expect(items.map((i) => i.clientId)).toEqual(['xcamp']);
  });

  it('appends custom entries after installed apps, unfiltered', () => {
    const items = resolveTrayApps({
      installed,
      settings: {
        mode: 'allow',
        allow: ['xcamp'],
        deny: [],
        custom: [{ id: 'c1', label: 'Docs', url: 'https://docs.example.com' }],
      },
    });
    expect(items.map((i) => i.source)).toEqual(['installed', 'custom']);
    expect(items[1]).toMatchObject({ id: 'custom:c1', label: 'Docs', clientId: null });
  });

  it('drops an installed app whose url is missing or unsafe', () => {
    const items = resolveTrayApps({
      installed: [
        app({ clientId: 'ok' }),
        app({ clientId: 'bad', url: 'javascript:alert(1)' }),
        app({ clientId: 'empty', url: '' }),
      ],
      settings: DEFAULT_TRAY_APP_SETTINGS,
    });
    expect(items.map((i) => i.clientId)).toEqual(['ok']);
  });

  it('de-duplicates the same app across orgs, keeping the first', () => {
    const items = resolveTrayApps({
      installed: [
        app({ clientId: 'xcamp', label: 'Xcamp', orgId: 'o1' }),
        app({ clientId: 'xcamp', label: 'Xcamp', orgId: 'o2' }),
      ],
      settings: DEFAULT_TRAY_APP_SETTINGS,
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.orgId).toBe('o1');
  });

  it('survives a malformed settings blob', () => {
    const items = resolveTrayApps({ installed, settings: { mode: 'x' } as never });
    expect(items).toHaveLength(3);
  });
});

describe('groupTrayApps', () => {
  it('groups by org with the personal/custom group first keyed empty', () => {
    const items = resolveTrayApps({
      installed: [
        app({ clientId: 'xcamp', label: 'Xcamp', orgId: 'o1', orgName: 'Acme' }),
        app({ clientId: 'personal', label: 'Personal' }),
      ],
      settings: { mode: 'deny', allow: [], deny: [], custom: [{ id: 'c1', label: 'Docs', url: 'https://d.example.com' }] },
    });
    const groups = groupTrayApps(items);
    const keys = groups.map((g) => g.key).sort();
    expect(keys).toEqual(['', 'o1']);
    expect(groups.find((g) => g.key === 'o1')!.label).toBe('Acme');
  });
});
