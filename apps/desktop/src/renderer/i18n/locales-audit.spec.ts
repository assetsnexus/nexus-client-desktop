import { describe, expect, it } from 'vitest';
import { DICTIONARIES, EN_MESSAGES, SUPPORTED_LOCALES } from './locales.js';
import { AUDIT_LOCALE_MESSAGES } from './locales-audit.js';

/**
 * The audit strings live in `locales-audit.ts` and are merged into `DICTIONARIES`
 * at module load. These invariants fail loudly if a new locale is added without
 * audit copy, or if a key drifts between the English source and the blocks.
 */

const EN_AUDIT_KEYS = Object.keys(AUDIT_LOCALE_MESSAGES.en).sort();

describe('audit locale messages', () => {
  it('provides an audit block for every supported locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(AUDIT_LOCALE_MESSAGES[locale], `missing audit block for ${locale}`).toBeDefined();
    }
  });

  it('every locale block matches the English key set exactly', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(Object.keys(AUDIT_LOCALE_MESSAGES[locale]).sort(), `${locale} key drift`).toEqual(EN_AUDIT_KEYS);
    }
  });

  it('surfaces the English audit keys in the source dictionary', () => {
    for (const key of EN_AUDIT_KEYS) {
      expect(EN_MESSAGES).toHaveProperty(key);
    }
  });

  it('merges the audit keys into every runtime dictionary', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of EN_AUDIT_KEYS) {
        expect(DICTIONARIES[locale][key as keyof typeof DICTIONARIES[typeof locale]]).toBeTruthy();
      }
    }
  });
});
