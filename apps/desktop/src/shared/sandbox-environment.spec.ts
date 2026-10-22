import { describe, expect, it } from 'vitest';
import {
  environmentFromConfigResponse,
  isSandboxEnvironment,
  sandboxTermsUrl,
  shouldShowSandboxBadge,
} from './sandbox-environment.js';

/**
 * The desktop mirrors the portal's sandbox decision
 * (`sandbox-environment.spec.js` in anx-portal-management_2): the public
 * `anx.config.environment` response is authoritative, and anything unreadable
 * must fail closed to "not sandbox" so a region outage never falsely claims
 * sandbox (and never blocks login).
 */
describe('desktop sandbox environment', () => {
  it('accepts only the exact sandbox token', () => {
    expect(isSandboxEnvironment('sandbox')).toBe(true);
    expect(isSandboxEnvironment(' Sandbox ')).toBe(true);
    expect(isSandboxEnvironment('SANDBOX')).toBe(true);
    expect(isSandboxEnvironment('production')).toBe(false);
    expect(isSandboxEnvironment('')).toBe(false);
    expect(isSandboxEnvironment(null)).toBe(false);
    expect(isSandboxEnvironment(undefined)).toBe(false);
  });

  it('reads the public config command and rejects unusable payloads', () => {
    expect(
      environmentFromConfigResponse({
        responseCode: 200,
        responseObject: { environment: 'sandbox' },
      }),
    ).toBe('sandbox');
    expect(
      environmentFromConfigResponse({
        responseCode: 200,
        responseObject: { environment: 'production' },
      }),
    ).toBe('production');
    // The portal also tolerates a `value` alias used by older responses.
    expect(
      environmentFromConfigResponse({ responseCode: 200, responseObject: { value: 'sandbox' } }),
    ).toBe('sandbox');
    expect(environmentFromConfigResponse({ responseCode: 500 })).toBe(null);
    expect(environmentFromConfigResponse({ responseCode: 200, responseObject: {} })).toBe(null);
    expect(environmentFromConfigResponse({ responseCode: 200, responseObject: { environment: ' ' } })).toBe(
      null,
    );
    expect(environmentFromConfigResponse(null)).toBe(null);
    expect(environmentFromConfigResponse(undefined)).toBe(null);
  });

  it('shows the badge only for a sandbox region and fails closed for unknown', () => {
    // Region answer wins over the build fallback, both ways.
    expect(
      shouldShowSandboxBadge({ regionEnvironment: 'sandbox', buildEnvironment: 'production' }),
    ).toBe(true);
    expect(
      shouldShowSandboxBadge({ regionEnvironment: 'production', buildEnvironment: 'sandbox' }),
    ).toBe(false);
    // An unreadable region falls back to the build flag.
    expect(shouldShowSandboxBadge({ regionEnvironment: null, buildEnvironment: 'sandbox' })).toBe(true);
    expect(shouldShowSandboxBadge({ regionEnvironment: null, buildEnvironment: 'production' })).toBe(
      false,
    );
    // Unknown everywhere -> not sandbox (never falsely claim sandbox).
    expect(shouldShowSandboxBadge({ regionEnvironment: null, buildEnvironment: '' })).toBe(false);
    expect(shouldShowSandboxBadge({ regionEnvironment: null, buildEnvironment: undefined })).toBe(false);
    expect(shouldShowSandboxBadge({})).toBe(false);
    expect(shouldShowSandboxBadge()).toBe(false);
  });

  it('builds the portal terms URL from the connection portal url', () => {
    expect(sandboxTermsUrl('https://sandbox.assetsnexus.org')).toBe(
      'https://sandbox.assetsnexus.org/terms',
    );
    expect(sandboxTermsUrl('https://sandbox.assetsnexus.org/')).toBe(
      'https://sandbox.assetsnexus.org/terms',
    );
    expect(sandboxTermsUrl('')).toBe(null);
    expect(sandboxTermsUrl(null)).toBe(null);
    expect(sandboxTermsUrl(undefined)).toBe(null);
  });
});
