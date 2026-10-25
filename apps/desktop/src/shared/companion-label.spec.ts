import { describe, expect, it } from 'vitest';
import {
  COMPANION_FALLBACK_LABEL,
  isUsableCompanionLabel,
  resolveCompanionLabel,
  resolveCompanionLabelOrNull,
} from './companion-label.js';

/** The exact id shape from the report (region conversation/contact id). */
const RAW_ID = '1792316062792-nm26u6zve';
const UUID = '63e7b12e-0a91-76ef-adae-c13fe0c2a206';
const OBJECT_ID = '6512f0a4c8b3e21f9a7d0e55';

describe('resolveCompanionLabel', () => {
  it('prefers the first human-readable candidate (region displayTitle first)', () => {
    expect(resolveCompanionLabel('Rune', 'Ignored agent name')).toBe('Rune');
  });

  it('uses the fallback literal when nothing is provided', () => {
    expect(resolveCompanionLabel()).toBe(COMPANION_FALLBACK_LABEL);
    expect(resolveCompanionLabel(null, undefined, '')).toBe(COMPANION_FALLBACK_LABEL);
    expect(resolveCompanionLabel('   ')).toBe(COMPANION_FALLBACK_LABEL);
  });

  it('NEVER renders a raw internal id as the label (the reported bug)', () => {
    // Given only a raw id (what the bug showed where a name belongs) the label
    // must be the neutral literal, never the id.
    expect(resolveCompanionLabel(RAW_ID)).toBe(COMPANION_FALLBACK_LABEL);
    expect(resolveCompanionLabel(RAW_ID)).not.toContain(RAW_ID);
  });

  it('skips every known internal-id shape and keeps looking', () => {
    expect(resolveCompanionLabel(RAW_ID, 'Rune')).toBe('Rune');
    expect(resolveCompanionLabel(UUID, 'Rune')).toBe('Rune');
    expect(resolveCompanionLabel(OBJECT_ID, 'Rune')).toBe('Rune');
  });
});

describe('resolveCompanionLabelOrNull', () => {
  it('returns a human name when present', () => {
    expect(resolveCompanionLabelOrNull('Rune')).toBe('Rune');
  });

  it('returns null (not the literal) for an id-only input', () => {
    expect(resolveCompanionLabelOrNull(RAW_ID)).toBeNull();
    expect(resolveCompanionLabelOrNull(RAW_ID, UUID)).toBeNull();
    expect(resolveCompanionLabelOrNull()).toBeNull();
  });

  it('recovers a real name even when a raw id comes first', () => {
    expect(resolveCompanionLabelOrNull(RAW_ID, 'Rune')).toBe('Rune');
  });
});

describe('isUsableCompanionLabel', () => {
  it('accepts a human name and rejects ids / blanks', () => {
    expect(isUsableCompanionLabel('Rune')).toBe(true);
    expect(isUsableCompanionLabel('Project kickoff')).toBe(true);
    expect(isUsableCompanionLabel(RAW_ID)).toBe(false);
    expect(isUsableCompanionLabel('')).toBe(false);
    expect(isUsableCompanionLabel(null)).toBe(false);
    expect(isUsableCompanionLabel(42)).toBe(false);
  });
});
