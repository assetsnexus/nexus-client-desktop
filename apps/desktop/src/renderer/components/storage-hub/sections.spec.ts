import { describe, expect, it } from 'vitest';
import { workspaceOptionLabel } from './sections.js';

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