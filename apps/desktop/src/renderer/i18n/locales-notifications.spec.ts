import { describe, expect, it } from 'vitest';
import { DICTIONARIES, EN_MESSAGES, SUPPORTED_LOCALES } from './locales.js';
import { NOTIFICATIONS_LOCALE_MESSAGES } from './locales-notifications.js';

/**
 * The notifications strings live in `locales-notifications.ts` and are merged
 * into `DICTIONARIES` at module load. These invariants fail loudly if a new
 * locale is added without inbox copy, or if a key drifts between the English
 * source and the blocks.
 */

const EN_KEYS = Object.keys(NOTIFICATIONS_LOCALE_MESSAGES.en).sort();

describe('notifications locale messages', () => {
  it('provides a block for every supported locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(NOTIFICATIONS_LOCALE_MESSAGES[locale], `missing block for ${locale}`).toBeDefined();
    }
  });

  it('every locale block matches the English key set exactly', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(Object.keys(NOTIFICATIONS_LOCALE_MESSAGES[locale]).sort(), `${locale} key drift`).toEqual(
        EN_KEYS,
      );
    }
  });

  it('surfaces the English keys in the source dictionary', () => {
    for (const key of EN_KEYS) {
      expect(EN_MESSAGES).toHaveProperty(key);
    }
  });

  it('merges the keys into every runtime dictionary', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of EN_KEYS) {
        expect(DICTIONARIES[locale][key as keyof (typeof DICTIONARIES)[typeof locale]]).toBeTruthy();
      }
    }
  });
});
