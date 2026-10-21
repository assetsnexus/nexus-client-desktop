import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PORTAL_URL,
  DEFAULT_REGION_URL,
  DESKTOP_APP_ID,
  DESKTOP_DEVICE_TYPE,
  isLocalHostname,
  normalizeBaseUrl,
  resolveConnectionConfig,
} from './config.js';

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes and keeps the origin', () => {
    expect(normalizeBaseUrl('https://region.example/')).toBe('https://region.example');
    expect(normalizeBaseUrl('https://region.example///')).toBe('https://region.example');
  });

  it('preserves a path prefix', () => {
    expect(normalizeBaseUrl('https://region.example/api/')).toBe('https://region.example/api');
  });

  it('rejects empty and non-http input', () => {
    expect(() => normalizeBaseUrl('')).toThrow(/empty/);
    expect(() => normalizeBaseUrl('   ')).toThrow(/empty/);
    expect(() => normalizeBaseUrl('ftp://region.example')).toThrow(/unsupported protocol/);
    expect(() => normalizeBaseUrl('region.example')).toThrow(/invalid base url/);
  });
});

describe('isLocalHostname', () => {
  it('matches loopback hosts', () => {
    expect(isLocalHostname('localhost')).toBe(true);
    expect(isLocalHostname('127.0.0.1')).toBe(true);
    expect(isLocalHostname('::1')).toBe(true);
    expect(isLocalHostname('[::1]')).toBe(true);
  });

  it('rejects non-loopback hosts', () => {
    expect(isLocalHostname('example.com')).toBe(false);
    expect(isLocalHostname('10.0.0.5')).toBe(false);
  });
});

describe('resolveConnectionConfig', () => {
  it('applies sandbox defaults when nothing is provided', () => {
    const resolved = resolveConnectionConfig();
    expect(resolved.regionUrl).toBe(DEFAULT_REGION_URL);
    expect(resolved.portalUrl).toBe(DEFAULT_PORTAL_URL);
    expect(resolved.customCaPem).toBeNull();
    expect(resolved.appId).toBe(DESKTOP_APP_ID);
    expect(resolved.deviceType).toBe(DESKTOP_DEVICE_TYPE);
  });

  it('defaults the gateway to the resolved region', () => {
    const resolved = resolveConnectionConfig({ regionUrl: 'https://local.region:3005/' });
    expect(resolved.regionUrl).toBe('https://local.region:3005');
    expect(resolved.gatewayUrl).toBe('https://local.region:3005');
  });

  it('honours explicit overrides', () => {
    const resolved = resolveConnectionConfig({
      gatewayUrl: 'https://gw.example',
      regionUrl: 'https://region.example',
      portalUrl: 'https://portal.example',
      customCaPem: '  -----BEGIN CERTIFICATE-----\n',
    });
    expect(resolved.gatewayUrl).toBe('https://gw.example');
    expect(resolved.regionUrl).toBe('https://region.example');
    expect(resolved.portalUrl).toBe('https://portal.example');
    expect(resolved.customCaPem).toContain('BEGIN CERTIFICATE');
  });

  it('treats blank CA as absent', () => {
    const resolved = resolveConnectionConfig({ customCaPem: '   ' });
    expect(resolved.customCaPem).toBeNull();
  });

  it('rejects an invalid region url', () => {
    expect(() => resolveConnectionConfig({ regionUrl: 'not-a-url' })).toThrow();
  });
});
