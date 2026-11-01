import { describe, expect, it } from 'vitest';
import { DICTIONARIES, EN_MESSAGES } from '../../i18n/locales.js';
import {
  DEFAULT_STORAGE_SECTION,
  STORAGE_NAV,
  workspaceOptionLabel,
  type StorageNavEntry,
} from './sections.js';

describe('workspaceOptionLabel', () => {
  it('leaves a personal workspace name as-is', () => {
    expect(workspaceOptionLabel({ name: 'My Storage', isOrg: false, orgName: null })).toBe('My Storage');
  });

  it('qualifies an org workspace with its org name so two orgs are distinguishable', () => {
    expect(workspaceOptionLabel({ name: 'Org Storage', isOrg: true, orgName: 'Acme Corp' })).toBe(
      'Org Storage — Acme Corp',
    );
  });

  it('falls back to the bare name when an org has no resolved name', () => {
    expect(workspaceOptionLabel({ name: 'Org Storage', isOrg: true, orgName: null })).toBe('Org Storage');
    expect(workspaceOptionLabel({ name: 'Org Storage', isOrg: true })).toBe('Org Storage');
  });
});

describe('STORAGE_NAV', () => {
  const ids = STORAGE_NAV.map((entry: StorageNavEntry) => entry.id);

  it('lists every section exactly once', () => {
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the pre-existing sections in their original order and appends audit last', () => {
    expect(ids).toEqual([
      'browse',
      'datarooms',
      'workspaces',
      'mounts',
      'sync',
      'folders',
      'access',
      'audit',
    ]);
  });

  it('includes the two portal-managed collection sections', () => {
    expect(ids).toContain('datarooms');
    expect(ids).toContain('workspaces');
  });

  it('keeps browse as the default section', () => {
    expect(DEFAULT_STORAGE_SECTION).toBe('browse');
    expect(ids).toContain(DEFAULT_STORAGE_SECTION);
  });

  it('gives every section an icon and a resolvable label/help key', () => {
    for (const entry of STORAGE_NAV) {
      expect(entry.icon, `${entry.id} icon`).toBeTruthy();
      expect(EN_MESSAGES[entry.labelKey], `${entry.id} label`).toBeTruthy();
      expect(DICTIONARIES.en[entry.labelKey], `${entry.id} en label`).toBeTruthy();
      if (entry.helpKey) {
        expect(EN_MESSAGES[entry.helpKey], `${entry.id} help`).toBeTruthy();
      }
    }
  });

  it('translates both new section labels in every locale', () => {
    for (const entry of STORAGE_NAV.filter(
      (e) => e.id === 'datarooms' || e.id === 'workspaces' || e.id === 'audit',
    )) {
      for (const [locale, dictionary] of Object.entries(DICTIONARIES)) {
        expect(
          dictionary[entry.labelKey],
          `${locale} is missing ${entry.labelKey}`,
        ).toBeTruthy();
      }
    }
  });
});
