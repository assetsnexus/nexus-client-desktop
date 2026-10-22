import { describe, expect, it } from 'vitest';
import { BRAND_LINKS, linkBrands } from './brand-links.js';

function rendered(segments: ReturnType<typeof linkBrands>): string {
  return segments.map((segment) => segment.text).join('');
}

describe('linkBrands', () => {
  it('links both brands in the English footer string', () => {
    const segments = linkBrands('powered by Blue Axion Labs & OmniBot');

    expect(segments).toEqual([
      { text: 'powered by ' },
      { text: 'Blue Axion Labs', href: 'https://blueaxionlabs.com' },
      { text: ' & ' },
      { text: 'OmniBot', href: 'https://omnibot.ai' },
    ]);
  });

  it('preserves every character of the source text', () => {
    for (const text of [
      'powered by Blue Axion Labs & OmniBot',
      '由 Blue Axion Labs 与 OmniBot 提供支持',
      'Blue Axion Labs & OmniBot tarafından desteklenmektedir',
      'مدعوم من Blue Axion Labs & OmniBot',
      'no brands here',
    ]) {
      expect(rendered(linkBrands(text))).toBe(text);
    }
  });

  it('links brands regardless of surrounding localized wording', () => {
    const segments = linkBrands('由 Blue Axion Labs 与 OmniBot 提供支持');

    const links = segments.filter((segment) => segment.href);
    expect(links.map((segment) => segment.text)).toEqual(['Blue Axion Labs', 'OmniBot']);
    expect(links.map((segment) => segment.href)).toEqual([
      'https://blueaxionlabs.com',
      'https://omnibot.ai',
    ]);
  });

  it('returns a single plain segment when no brand is present', () => {
    expect(linkBrands('powered by nobody')).toEqual([{ text: 'powered by nobody' }]);
  });

  it('handles a brand at the very start and end', () => {
    expect(linkBrands('OmniBot by Blue Axion Labs')).toEqual([
      { text: 'OmniBot', href: 'https://omnibot.ai' },
      { text: ' by ' },
      { text: 'Blue Axion Labs', href: 'https://blueaxionlabs.com' },
    ]);
  });

  it('exposes https targets for both brands', () => {
    for (const brand of BRAND_LINKS) {
      expect(brand.href).toMatch(/^https:\/\//);
    }
  });
});
