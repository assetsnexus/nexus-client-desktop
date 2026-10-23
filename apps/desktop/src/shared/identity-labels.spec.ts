import { describe, expect, it } from 'vitest';
import { humanLabel, isOpaqueId } from './identity-labels.js';

describe('isOpaqueId', () => {
  it('detects canonical UUIDs', () => {
    expect(isOpaqueId('d2285bf8-c00d-4e85-82d9-6b7c331b9629')).toBe(true);
    expect(isOpaqueId('D2285BF8-C00D-4E85-82D9-6B7C331B9629')).toBe(true);
  });

  it('detects 24-hex ObjectIds and bare 32-hex ids', () => {
    expect(isOpaqueId('507f1f77bcf86cd799439011')).toBe(true);
    expect(isOpaqueId('d41d8cd98f00b204e9800998ecf8427e')).toBe(true);
  });

  it('never mistakes a human label for an id', () => {
    expect(isOpaqueId('a@b.c')).toBe(false);
    expect(isOpaqueId('Acme GmbH')).toBe(false);
    // A dashed *name* is not a UUID: right shape, wrong length.
    expect(isOpaqueId('my-org-team')).toBe(false);
    expect(isOpaqueId('my-org')).toBe(false);
    expect(isOpaqueId('')).toBe(false);
    expect(isOpaqueId(null)).toBe(false);
    expect(isOpaqueId(42)).toBe(false);
  });
});

describe('humanLabel', () => {
  it('keeps a real human value', () => {
    expect(humanLabel('a@b.c', 'fallback')).toBe('a@b.c');
    expect(humanLabel('  Acme GmbH  ', 'fallback')).toBe('Acme GmbH');
  });

  it('substitutes the fallback for a missing, blank or opaque id value', () => {
    expect(humanLabel(null, 'fallback')).toBe('fallback');
    expect(humanLabel(undefined, 'fallback')).toBe('fallback');
    expect(humanLabel('   ', 'fallback')).toBe('fallback');
    // The regression: an account with no email used to render its UUID.
    expect(humanLabel('d2285bf8-c00d-4e85-82d9-6b7c331b9629', 'Signed-in account')).toBe(
      'Signed-in account',
    );
    expect(humanLabel('507f1f77bcf86cd799439011', 'Organisation')).toBe('Organisation');
  });
});
