import { describe, expect, it } from 'vitest';
import { countryFromLocale, resolveCountryRegion } from './login-region.js';
import type { CountryRow, RegionRow } from '@nexus/node-core';

const country = (over: Partial<CountryRow> = {}): CountryRow => ({
  code: 'DE',
  name: 'Germany',
  region: null,
  state: 'active',
  ...over,
});

const region = (over: Partial<RegionRow> = {}): RegionRow => ({
  slug: 'eu-west',
  name: 'EU West',
  state: 'active',
  countryCodes: [],
  ...over,
});

describe('resolveCountryRegion', () => {
  it('prefers an explicit country.region slug', () => {
    const res = resolveCountryRegion(
      country({ region: 'eu-central' }),
      [region({ slug: 'eu-west', countryCodes: ['DE'] }), region({ slug: 'eu-central' })],
    );
    expect(res.region?.slug).toBe('eu-central');
    expect(res.inactiveRegion).toBeNull();
  });

  it('falls back to a region whose countryCodes contains the country', () => {
    const res = resolveCountryRegion(country(), [region({ slug: 'eu-west', countryCodes: ['DE'] })]);
    expect(res.region?.slug).toBe('eu-west');
  });

  it('ignores a matching region that is not active or preview', () => {
    const res = resolveCountryRegion(
      country({ region: 'eu-west' }),
      [region({ slug: 'eu-west', state: 'disabled', countryCodes: ['DE'] })],
    );
    expect(res.region).toBeNull();
  });

  it('reports an inactive region separately so the UI can explain the gap', () => {
    const res = resolveCountryRegion(
      country({ region: 'eu-west' }),
      [region({ slug: 'eu-west', state: 'inactive', countryCodes: ['DE'] })],
    );
    expect(res.region).toBeNull();
    expect(res.inactiveRegion?.slug).toBe('eu-west');
  });

  it('returns nothing when no region claims the country', () => {
    const res = resolveCountryRegion(country(), [region({ slug: 'us-east', countryCodes: ['US'] })]);
    expect(res.region).toBeNull();
    expect(res.inactiveRegion).toBeNull();
  });

  it('does not fall back to an inactive region when an active one wins', () => {
    const res = resolveCountryRegion(country(), [
      region({ slug: 'eu-west', state: 'inactive', countryCodes: ['DE'] }),
      region({ slug: 'eu-central', state: 'active', countryCodes: ['DE'] }),
    ]);
    expect(res.region?.slug).toBe('eu-central');
    expect(res.inactiveRegion).toBeNull();
  });
});

describe('countryFromLocale', () => {
  it('extracts the region subtag from BCP-47 tags', () => {
    expect(countryFromLocale('de-DE')).toBe('DE');
    expect(countryFromLocale('en_US')).toBe('US');
    expect(countryFromLocale('zh-Hant-TW')).toBe('TW');
  });

  it('returns null when there is no usable region subtag', () => {
    expect(countryFromLocale('de')).toBeNull();
    expect(countryFromLocale('')).toBeNull();
    expect(countryFromLocale(null)).toBeNull();
    expect(countryFromLocale('x-y')).toBeNull();
  });
});
