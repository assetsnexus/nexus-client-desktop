import { describe, expect, it } from 'vitest';
import {
  contactOverrideFor,
  normalizeContactOverride,
  normalizeContactOverrides,
  placementModeForContact,
  shouldOpenCompanionForContact,
} from './contact-overrides.js';

describe('normalizeContactOverride', () => {
  it('returns null for a malformed or empty entry', () => {
    expect(normalizeContactOverride(null)).toBeNull();
    expect(normalizeContactOverride('nope')).toBeNull();
    expect(normalizeContactOverride({})).toBeNull();
    // An invalid mode with no other usable key leaves nothing behind.
    expect(normalizeContactOverride({ placementMode: 'moon' })).toBeNull();
  });

  it('keeps only valid, known keys', () => {
    expect(
      normalizeContactOverride({
        placementMode: 'center',
        openCompanionOnMessage: true,
        somethingElse: 'ignored',
      }),
    ).toEqual({ placementMode: 'center', openCompanionOnMessage: true });
    // A per-agent opt-out (`false`) is a real value, not an absent key.
    expect(normalizeContactOverride({ openCompanionOnMessage: false })).toEqual({
      openCompanionOnMessage: false,
    });
  });
});

describe('normalizeContactOverrides', () => {
  it('returns an empty map for malformed input', () => {
    expect(normalizeContactOverrides(null)).toEqual({});
    expect(normalizeContactOverrides(42)).toEqual({});
    expect(normalizeContactOverrides([])).toEqual({});
  });

  it('drops empty/unknown entries and blank keys but keeps valid ones', () => {
    expect(
      normalizeContactOverrides({
        'agent-1': { placementMode: 'top-left' },
        'agent-2': {},
        'agent-3': { placementMode: 'nowhere' },
        '  ': { placementMode: 'center' },
      }),
    ).toEqual({ 'agent-1': { placementMode: 'top-left' } });
  });
});

describe('contactOverrideFor', () => {
  const overrides = { 'agent-1': { placementMode: 'top-left' } as const };

  it('returns the entry for a known contact and {} otherwise', () => {
    expect(contactOverrideFor(overrides, 'agent-1')).toEqual({ placementMode: 'top-left' });
    expect(contactOverrideFor(overrides, 'agent-2')).toEqual({});
    expect(contactOverrideFor(overrides, null)).toEqual({});
    expect(contactOverrideFor(null, 'agent-1')).toEqual({});
  });
});

describe('placementModeForContact', () => {
  it('prefers the per-agent override, else the global mode', () => {
    const overrides = { 'agent-1': { placementMode: 'right-of-main' } as const };
    expect(
      placementModeForContact({ overrides, contactId: 'agent-1', globalMode: 'bottom-right' }),
    ).toBe('right-of-main');
    expect(
      placementModeForContact({ overrides, contactId: 'agent-2', globalMode: 'bottom-right' }),
    ).toBe('bottom-right');
    expect(
      placementModeForContact({ overrides, contactId: null, globalMode: 'center' }),
    ).toBe('center');
  });
});

describe('shouldOpenCompanionForContact', () => {
  it('inherits the global switch when the agent has no explicit choice', () => {
    expect(shouldOpenCompanionForContact({ overrides: {}, contactId: 'a', globalOpen: true })).toBe(
      true,
    );
    expect(shouldOpenCompanionForContact({ overrides: {}, contactId: 'a', globalOpen: false })).toBe(
      false,
    );
  });

  it('lets an explicit per-agent choice win over the global switch', () => {
    expect(
      shouldOpenCompanionForContact({
        overrides: { a: { openCompanionOnMessage: false } },
        contactId: 'a',
        globalOpen: true,
      }),
    ).toBe(false);
    expect(
      shouldOpenCompanionForContact({
        overrides: { a: { openCompanionOnMessage: true } },
        contactId: 'a',
        globalOpen: false,
      }),
    ).toBe(true);
  });
});
