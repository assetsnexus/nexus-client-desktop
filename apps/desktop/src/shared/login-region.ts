/**
 * Country/region resolution for the login screen.
 *
 * Mirrors the portal's `AuthAccess.vue` logic exactly so the desktop and the
 * portal agree on which region serves a country. Lives in `shared` (not the
 * renderer) because it is pure and exercised directly by a spec; `import type`
 * only, so the renderer never pulls runtime code from `@nexus/node-core`.
 */

import type { CountryRow, RegionRow } from '@nexus/node-core';

export type CountryRegionResolution = {
  /** The region serving the country (active/preview), or null. */
  region: RegionRow | null;
  /** An inactive/disabled region for the country, to explain the gap. */
  inactiveRegion: RegionRow | null;
};

const isActive = (r: RegionRow): boolean => r.state === 'active' || r.state === 'preview';
const isInactive = (r: RegionRow): boolean => r.state === 'inactive' || r.state === 'disabled';

/**
 * Resolve a country to its region — the portal's precedence: an explicit
 * `country.region` slug first, then a region whose `countryCodes` contains the
 * country code. Active/preview wins; an inactive region is reported separately
 * so the UI can say "not available yet" instead of failing silently.
 */
export function resolveCountryRegion(
  country: CountryRow,
  regions: RegionRow[],
): CountryRegionResolution {
  const bySlug = (slug: string | null, pred: (r: RegionRow) => boolean): RegionRow | null =>
    slug ? regions.find((r) => r.slug === slug && pred(r)) ?? null : null;
  const byCodes = (pred: (r: RegionRow) => boolean): RegionRow | null =>
    regions.find((r) => r.countryCodes.includes(country.code) && pred(r)) ?? null;

  const region = bySlug(country.region, isActive) ?? byCodes(isActive);
  const inactiveRegion = region
    ? null
    : bySlug(country.region, isInactive) ?? byCodes(isInactive);

  return { region, inactiveRegion };
}

/**
 * Best-effort country from a BCP-47 tag (`de-DE` -> `DE`). Returns null when the
 * tag carries no region subtag (e.g. a bare `de`), so the caller can fall back
 * to its own default rather than guessing.
 */
export function countryFromLocale(locale: string | null | undefined): string | null {
  if (!locale) return null;
  const parts = locale.split(/[-_]/);
  if (parts.length < 2) return null;
  const region = parts[parts.length - 1]?.toUpperCase();
  return region && /^[A-Z]{2}$/.test(region) ? region : null;
}
