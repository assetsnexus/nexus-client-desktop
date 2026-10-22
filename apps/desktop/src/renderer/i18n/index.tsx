/**
 * Renderer i18n: locale state + `t()` lookup + persistence.
 *
 * Locale is persisted through the main process (`getUiSettings` /
 * `setUiSettings`) so the choice survives restarts and is shared by every
 * window, mirroring how the connection config is stored. Before the async load
 * resolves we fall back to the OS locale when it is one we ship, else English.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { bridge } from '../bridge.js';
import {
  DICTIONARIES,
  EN_MESSAGES,
  LOCALE_META,
  RTL_LOCALES,
  SUPPORTED_LOCALES,
  type Locale,
  type MessageKey,
} from './locales.js';

export { LOCALE_META, SUPPORTED_LOCALES };
export type { Locale, MessageKey };

type TranslateVars = Record<string, string | number>;

export type I18n = {
  locale: Locale;
  setLocale: (next: Locale) => void;
  /** Translate `key`, interpolating `{name}` placeholders from `vars`. */
  t: (key: MessageKey, vars?: TranslateVars) => string;
  /** Best-effort locale from the OS, constrained to what we ship. */
  systemLocale: Locale;
};

const I18nContext = createContext<I18n | null>(null);

function isSupported(value: string | null | undefined): value is Locale {
  if (!value) return false;
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** Map a BCP-47 tag like `de-AT` or `ru_RU` to a shipped locale. */
export function normalizeLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const lower = tag.trim().toLowerCase();
  if (isSupported(lower)) return lower;
  const base = lower.split(/[-_]/)[0];
  return isSupported(base) ? base : null;
}

function detectSystemLocale(): Locale {
  if (typeof navigator === 'undefined') return 'en';
  const candidates = [navigator.language, ...(navigator.languages ?? [])];
  for (const candidate of candidates) {
    const match = normalizeLocale(candidate);
    if (match) return match;
  }
  return 'en';
}

function interpolate(template: string, vars?: TranslateVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

/** Resolve `key` for `locale`, falling back to English, then to the raw key. */
export function translate(locale: Locale, key: MessageKey, vars?: TranslateVars): string {
  const message = DICTIONARIES[locale]?.[key] ?? EN_MESSAGES[key] ?? key;
  return interpolate(message, vars);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [systemLocale] = useState<Locale>(detectSystemLocale);
  const [locale, setLocaleState] = useState<Locale>(systemLocale);

  // Hydrate the persisted choice once the bridge is ready. A saved locale wins
  // over the OS default; an unsupported/absent value keeps the OS default.
  useEffect(() => {
    let cancelled = false;
    void bridge
      .getUiSettings()
      .then((settings) => {
        if (cancelled) return;
        const saved = normalizeLocale(settings.locale);
        if (saved) setLocaleState(saved);
      })
      .catch(() => {
        /* first run / bridge unavailable — keep the OS default */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    // Persist in the background; the UI must not wait on disk.
    void bridge.setUiSettings({ locale: next }).catch(() => {
      /* non-fatal: the choice still applies for this session */
    });
  }, []);

  // Flip document direction for RTL locales (e.g. Arabic) so the shell mirrors
  // correctly. Runs on mount and whenever the locale changes.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const dir = RTL_LOCALES.includes(locale) ? 'rtl' : 'ltr';
    document.documentElement.dir = dir;
    document.documentElement.lang = locale;
  }, [locale]);

  const t = useCallback(
    (key: MessageKey, vars?: TranslateVars) => translate(locale, key, vars),
    [locale],
  );

  const value = useMemo<I18n>(
    () => ({ locale, setLocale, t, systemLocale }),
    [locale, setLocale, t, systemLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>');
  return ctx;
}

/** Convenience hook for components that only need `t`. */
export function useTranslation(): { t: I18n['t']; locale: Locale } {
  const { t, locale } = useI18n();
  return { t, locale };
}
