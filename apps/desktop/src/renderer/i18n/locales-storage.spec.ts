import { describe, expect, it } from 'vitest';
import { DICTIONARIES, EN_MESSAGES, SUPPORTED_LOCALES } from './locales.js';
import { STORAGE_LOCALE_MESSAGES } from './locales-storage.js';

/**
 * The storage-hub strings live in `locales-storage.ts` and are merged into
 * `DICTIONARIES` at module load. These invariants fail loudly if a new locale is
 * added without a block, or if a key drifts between the English source and the
 * per-locale blocks.
 */

const EN_STORAGE_KEYS = Object.keys(STORAGE_LOCALE_MESSAGES.en).sort();

describe('storage locale messages', () => {
  it('provides a storage block for every supported locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(STORAGE_LOCALE_MESSAGES[locale], `missing storage block for ${locale}`).toBeDefined();
    }
  });

  it('every locale block matches the English key set exactly', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(Object.keys(STORAGE_LOCALE_MESSAGES[locale]).sort(), `${locale} key drift`).toEqual(
        EN_STORAGE_KEYS,
      );
    }
  });

  it('surfaces the English keys in the source dictionary', () => {
    for (const key of EN_STORAGE_KEYS) {
      expect(EN_MESSAGES).toHaveProperty(key);
    }
  });

  it('merges the keys into every runtime dictionary', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of EN_STORAGE_KEYS) {
        expect(
          DICTIONARIES[locale][key as keyof (typeof DICTIONARIES)[typeof locale]],
          `${locale} missing ${key}`,
        ).toBeTruthy();
      }
    }
  });

  it('keeps placeholders intact across locales', () => {
    const placeholders = (value: string) =>
      [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of EN_STORAGE_KEYS) {
      const expected = placeholders(STORAGE_LOCALE_MESSAGES.en[key]);
      if (!expected.length) continue;
      for (const locale of SUPPORTED_LOCALES) {
        expect(
          placeholders(STORAGE_LOCALE_MESSAGES[locale][key]),
          `${locale} placeholder drift on ${key}`,
        ).toEqual(expected);
      }
    }
  });
});
