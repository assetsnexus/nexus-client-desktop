import { describe, expect, it } from 'vitest';
import {
  DICTIONARIES,
  EN_MESSAGES,
  LOCALE_META,
  RTL_LOCALES,
  SUPPORTED_LOCALES,
} from './locales.js';

/**
 * i18n registry invariants.
 *
 * The dictionaries are `Partial`, so a missing key degrades to English at
 * runtime rather than throwing. These tests pin the registry shape so a new
 * locale can never silently ship with missing metadata, and so the shipped
 * locale set only grows deliberately.
 */

// The brand string is intentionally identical in every locale (it is a proper
// noun), so it is the one key allowed to be absent from non-English dictionaries.
const BRAND_ONLY_KEYS = new Set(['login.footer.assetsNexus']);

describe('i18n locales', () => {
  it('has a metadata entry for every supported locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const meta = LOCALE_META[locale];
      expect(meta, `missing LOCALE_META for ${locale}`).toBeDefined();
      expect(meta.label).toBeTruthy();
      expect(meta.english).toBeTruthy();
      expect(meta.flag).toBeTruthy();
    }
  });

  it('exposes a dictionary for every supported locale and nothing else', () => {
    expect(Object.keys(DICTIONARIES).sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });

  it('covers every English message key in every locale', () => {
    const expected = Object.keys(EN_MESSAGES).filter((key) => !BRAND_ONLY_KEYS.has(key));
    for (const locale of SUPPORTED_LOCALES) {
      if (locale === 'en') continue;
      const dict = DICTIONARIES[locale];
      const missing = expected.filter((key) => !dict[key as keyof typeof dict]);
      expect(missing, `${locale} is missing keys: ${missing.join(', ')}`).toEqual([]);
    }
  });

  it('does not define keys that English does not have', () => {
    const known = new Set(Object.keys(EN_MESSAGES));
    for (const locale of SUPPORTED_LOCALES) {
      const extra = Object.keys(DICTIONARIES[locale]).filter((key) => !known.has(key));
      expect(extra, `${locale} has unknown keys: ${extra.join(', ')}`).toEqual([]);
    }
  });

  it('keeps every RTL locale in the supported set', () => {
    for (const locale of RTL_LOCALES) {
      expect(SUPPORTED_LOCALES).toContain(locale);
    }
  });
});
