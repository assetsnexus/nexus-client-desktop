/**
 * Language selector.
 *
 * A compact `<select>` that writes straight through to the persisted UI
 * settings. Used both on the login screen (so a user can pick a language before
 * signing in) and in the settings panel.
 */

import type { CSSProperties } from 'react';
import { LOCALE_META, SUPPORTED_LOCALES, useI18n, type Locale } from '../i18n/index.js';

const label: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 12,
  color: '#9aa7b5',
};

const select: CSSProperties = {
  padding: '6px 8px',
  borderRadius: 8,
  border: '1px solid #3a4654',
  background: '#0f1419',
  color: '#e8eef4',
  fontSize: 13,
  cursor: 'pointer',
};

export function LanguageSelector({
  variant = 'inline',
  style,
}: {
  /** `inline` = small footer/row control; `field` = stacked settings field. */
  variant?: 'inline' | 'field';
  style?: CSSProperties;
}) {
  const { locale, setLocale, t } = useI18n();

  const control = (
    <select
      style={select}
      value={locale}
      aria-label={t('login.language')}
      onChange={(e) => setLocale(e.target.value as Locale)}
    >
      {SUPPORTED_LOCALES.map((code) => (
        <option key={code} value={code}>
          {LOCALE_META[code].label}
        </option>
      ))}
    </select>
  );

  if (variant === 'field') {
    return (
      <label style={{ ...label, flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
        <span>{t('settings.language')}</span>
        {control}
      </label>
    );
  }

  return (
    <span style={{ ...label, ...style }}>
      <span aria-hidden>🌐</span>
      {control}
    </span>
  );
}
