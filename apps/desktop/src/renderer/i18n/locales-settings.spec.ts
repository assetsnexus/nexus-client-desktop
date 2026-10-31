import { describe, expect, it } from 'vitest';
import { DICTIONARIES, EN_MESSAGES, SUPPORTED_LOCALES } from './locales.js';
import { SETTINGS_LOCALE_MESSAGES } from './locales-settings.js';

/**
 * The settings strings live in `locales-settings.ts` and are merged into
 * `DICTIONARIES` at module load. These invariants fail loudly if a new locale is
 * added without settings copy, or if a key drifts between the English source and
 * the per-locale blocks.
 */

const EN_SETTINGS_KEYS = Object.keys(SETTINGS_LOCALE_MESSAGES.en).sort();

describe('settings locale messages', () => {
  it('provides a settings block for every supported locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(SETTINGS_LOCALE_MESSAGES[locale], `missing settings block for ${locale}`).toBeDefined();
    }
  });

  it('every locale block matches the English key set exactly', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(Object.keys(SETTINGS_LOCALE_MESSAGES[locale]).sort(), `${locale} key drift`).toEqual(
        EN_SETTINGS_KEYS,
      );
    }
  });

  it('surfaces the English keys in the source dictionary', () => {
    for (const key of EN_SETTINGS_KEYS) {
      expect(EN_MESSAGES).toHaveProperty(key);
    }
  });

  it('merges the keys into every runtime dictionary', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of EN_SETTINGS_KEYS) {
        expect(DICTIONARIES[locale][key as keyof (typeof DICTIONARIES)[typeof locale]]).toBeTruthy();
      }
    }
  });

  it('keeps placeholders intact across locales', () => {
    // A dropped `{name}` placeholder silently breaks interpolation; assert every
    // block exposes the same placeholder set as English for each key.
    const placeholders = (value: string) =>
      [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of EN_SETTINGS_KEYS) {
      const expected = placeholders(SETTINGS_LOCALE_MESSAGES.en[key]);
      if (!expected.length) continue;
      for (const locale of SUPPORTED_LOCALES) {
        expect(
          placeholders(SETTINGS_LOCALE_MESSAGES[locale][key]),
          `${locale} placeholder drift on ${key}`,
        ).toEqual(expected);
      }
    }
  });
});
