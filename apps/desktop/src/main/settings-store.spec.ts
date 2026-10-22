import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsStore, DEFAULT_NOTIFICATION_SETTINGS } from './settings-store.js';

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'nexus-settings-')), 'settings.json');
}

describe('createSettingsStore — ui settings', () => {
  it('defaults loginCountry to null and notifications to the safe defaults', () => {
    const store = createSettingsStore(tempFile());
    const ui = store.getUiSettings();
    expect(ui.loginCountry).toBeNull();
    expect(ui.notifications).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
  });

  it('persists a picked login country, upper-cased', () => {
    const path = tempFile();
    const store = createSettingsStore(path);
    expect(store.setUiSettings({ loginCountry: 'de' }).loginCountry).toBe('DE');
    // A fresh store over the same file must see it (survives restarts).
    expect(createSettingsStore(path).getUiSettings().loginCountry).toBe('DE');
  });

  it('rejects a hand-edited invalid country instead of passing it through', () => {
    const path = tempFile();
    writeFileSync(path, JSON.stringify({ ui: { loginCountry: 'deutschland' } }), 'utf8');
    expect(createSettingsStore(path).getUiSettings().loginCountry).toBeNull();
  });

  it('keeps notifications valid when a hand-edited file is malformed', () => {
    const path = tempFile();
    writeFileSync(path, JSON.stringify({ ui: { notifications: { cardMode: 'bogus' } } }), 'utf8');
    expect(createSettingsStore(path).getUiSettings().notifications.cardMode).toBe('full');
  });

  it('applies a partial patch without dropping the other ui fields', () => {
    const store = createSettingsStore(tempFile());
    store.setUiSettings({ locale: 'de', loginCountry: 'FR' });
    const next = store.setUiSettings({ loginCountry: 'DE' });
    expect(next.locale).toBe('de');
    expect(next.loginCountry).toBe('DE');
  });
});
