import { describe, expect, it } from 'vitest';
import { createRegionTransport } from './transport.js';

describe('createRegionTransport', () => {
  it('uses the supplied base url and normalizes it', () => {
    const t = createRegionTransport({ baseUrl: 'https://region.example/' });
    expect(t.active.baseUrl).toBe('https://region.example');
    expect(t.active.slug).toBeNull();
    expect(t.peers).toEqual([]);
  });

  it('parses peer routes from a region document', () => {
    const t = createRegionTransport({
      baseUrl: 'https://primary.example',
      regionDocument: {
        slug: 'eu-west',
        routes: [
          { url: 'https://primary.example', priority: 1, kind: 'primary' },
          { url: 'https://alt.example', priority: 5, kind: 'alternative' },
        ],
      },
    });
    expect(t.active.slug).toBe('eu-west');
    expect(t.peers).toEqual(['https://primary.example', 'https://alt.example']);
  });

  it('falls back to the first peer when no base url is given', () => {
    const t = createRegionTransport({
      baseUrl: '',
      regionDocument: {
        slug: 'eu',
        routes: [{ url: 'https://first.example', priority: 1 }],
      },
    });
    expect(t.active.baseUrl).toBe('https://first.example');
  });

  it('adopts a redirect peer', () => {
    const t = createRegionTransport({ baseUrl: 'https://primary.example' });
    t.adopt('https://peer.example/');
    expect(t.active.baseUrl).toBe('https://peer.example');
    // Blank adoption is ignored.
    t.adopt('   ');
    expect(t.active.baseUrl).toBe('https://peer.example');
  });

  it('ignores an invalid region document without throwing', () => {
    const t = createRegionTransport({ baseUrl: 'https://r.example', regionDocument: { nope: 1 } });
    expect(t.active.slug).toBeNull();
    expect(t.peers).toEqual([]);
  });
});
