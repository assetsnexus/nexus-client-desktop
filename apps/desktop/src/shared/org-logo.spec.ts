import { describe, expect, it } from 'vitest';
import { orgInitials, resolveOrgLogoUrl } from './org-logo.js';

describe('resolveOrgLogoUrl', () => {
  it('passes through absolute http(s) URLs', () => {
    expect(resolveOrgLogoUrl('https://cdn.example/logo.png')).toBe('https://cdn.example/logo.png');
    expect(resolveOrgLogoUrl('http://127.0.0.1:3005/logo.png')).toBe('http://127.0.0.1:3005/logo.png');
  });

  it('keeps inline image data URLs and rejects other data kinds', () => {
    const png = 'data:image/png;base64,AAAA';
    expect(resolveOrgLogoUrl(png)).toBe(png);
    expect(resolveOrgLogoUrl('data:text/html;base64,AAAA')).toBeNull();
  });

  it('rejects an oversized inline data URL', () => {
    const huge = `data:image/png;base64,${'A'.repeat(9000)}`;
    expect(resolveOrgLogoUrl(huge)).toBeNull();
  });

  it('absolutises a root-relative region path against the base', () => {
    expect(resolveOrgLogoUrl('/public-files/orgs/x.png', 'https://region.test/')).toBe(
      'https://region.test/public-files/orgs/x.png',
    );
    expect(resolveOrgLogoUrl('/public-files/orgs/x.png', 'https://region.test')).toBe(
      'https://region.test/public-files/orgs/x.png',
    );
  });

  it('returns null for a relative path with no base to resolve against', () => {
    expect(resolveOrgLogoUrl('/public-files/orgs/x.png')).toBeNull();
    expect(resolveOrgLogoUrl('/public-files/orgs/x.png', '')).toBeNull();
  });

  it('resolves protocol-relative URLs over https', () => {
    expect(resolveOrgLogoUrl('//cdn.example/logo.png')).toBe('https://cdn.example/logo.png');
  });

  it('returns null for missing or unusable values', () => {
    expect(resolveOrgLogoUrl(null)).toBeNull();
    expect(resolveOrgLogoUrl(undefined)).toBeNull();
    expect(resolveOrgLogoUrl('')).toBeNull();
    expect(resolveOrgLogoUrl('   ')).toBeNull();
    expect(resolveOrgLogoUrl('some-raw-file-id')).toBeNull();
    expect(resolveOrgLogoUrl(42)).toBeNull();
  });
});

describe('orgInitials', () => {
  it('takes the first letters of the first two words', () => {
    expect(orgInitials('Acme Corp')).toBe('AC');
    expect(orgInitials('north wind labs')).toBe('NW');
  });

  it('splits on common separators', () => {
    expect(orgInitials('acme-corp')).toBe('AC');
    expect(orgInitials('acme_corp ltd')).toBe('AC');
  });

  it('uses up to two letters of a single word', () => {
    expect(orgInitials('Acme')).toBe('AC');
    expect(orgInitials('X')).toBe('X');
  });

  it('falls back to a question mark when there is no name', () => {
    expect(orgInitials(null)).toBe('?');
    expect(orgInitials(undefined)).toBe('?');
    expect(orgInitials('   ')).toBe('?');
  });
});
