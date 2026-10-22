/**
 * Brand links for the login footer ("powered by Blue Axion Labs & OmniBot").
 *
 * The company names are proper nouns, so they are kept verbatim inside every
 * locale's translation of `login.footer.poweredBy` while only the surrounding
 * wording is localized. Rather than hard-coding an anchor per locale (which
 * would break the moment a translator reorders the sentence), we tokenize the
 * already-translated string on the brand names and link each occurrence.
 */

export type BrandLinkSegment = {
  /** Literal text to render. */
  text: string;
  /** When set, this segment is a link to the given URL. */
  href?: string;
};

/** Canonical marketing sites, longest name first so prefixes never shadow. */
export const BRAND_LINKS: ReadonlyArray<{ name: string; href: string }> = [
  { name: 'Blue Axion Labs', href: 'https://blueaxionlabs.com' },
  { name: 'OmniBot', href: 'https://omnibot.ai' },
];

/**
 * Split `text` into plain and linked segments, linking every known brand name.
 * Unmatched text (including the localized glue words) is preserved verbatim.
 */
export function linkBrands(text: string): BrandLinkSegment[] {
  const segments: BrandLinkSegment[] = [];
  let rest = text;

  while (rest) {
    let bestIndex = -1;
    let bestBrand: { name: string; href: string } | null = null;

    for (const brand of BRAND_LINKS) {
      const index = rest.indexOf(brand.name);
      if (index === -1) continue;
      if (bestIndex === -1 || index < bestIndex) {
        bestIndex = index;
        bestBrand = brand;
      }
    }

    if (!bestBrand || bestIndex === -1) {
      segments.push({ text: rest });
      break;
    }

    if (bestIndex > 0) segments.push({ text: rest.slice(0, bestIndex) });
    segments.push({ text: bestBrand.name, href: bestBrand.href });
    rest = rest.slice(bestIndex + bestBrand.name.length);
  }

  return segments;
}
