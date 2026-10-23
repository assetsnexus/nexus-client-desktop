import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import {
  bridge,
  type AuthState,
  type CountryRow,
  type DesktopConnectionConfig,
  type DeviceLinkSessionStart,
  type RegionRow,
} from '../bridge.js';
import { renderQrSvg } from '../qr.js';
import { countryFromLocale, resolveCountryRegion } from '../../shared/login-region.js';
import {
  SANDBOX_BADGE_DESCRIPTION,
  SANDBOX_BADGE_LABEL,
  SANDBOX_DISCLAIMER,
  SANDBOX_TERMS_LABEL,
  sandboxTermsUrl,
  shouldShowSandboxBadge,
} from '../../shared/sandbox-environment.js';
import { useRegionEnvironment } from '../sandbox/use-region-environment.js';
import { sandboxBadgeStyle } from '../sandbox/badge-style.js';
import { useI18n, type MessageKey } from '../i18n/index.js';
import { linkBrands } from '../i18n/brand-links.js';
import { LanguageSelector } from './LanguageSelector.js';

const page: CSSProperties = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
};

const wrap: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'grid',
  // Center the tab strip + card + register row as one block. Without
  // `alignContent: center` the auto rows stretch to fill the tall container
  // (grid's default `align-content: stretch`), opening a huge gap between the
  // mode tabs and the form.
  placeItems: 'center',
  alignContent: 'center',
  gap: 14,
  padding: 24,
};

const card: CSSProperties = {
  width: 380,
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  padding: 24,
  borderRadius: 14,
  background: '#151b22',
  border: '1px solid #2a333d',
};

const field: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  fontSize: 12,
  color: '#9aa7b5',
};

const input: CSSProperties = {
  padding: '9px 11px',
  borderRadius: 8,
  border: '1px solid #3a4654',
  background: '#0f1419',
  color: '#e8eef4',
  fontSize: 14,
};

const button: CSSProperties = {
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid #3f6cb0',
  background: '#2f5c9e',
  color: '#fff',
  cursor: 'pointer',
  fontSize: 14,
  fontWeight: 600,
};

const ghostButton: CSSProperties = {
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid #3a4654',
  background: 'transparent',
  color: '#c3ceda',
  cursor: 'pointer',
  fontSize: 14,
  fontWeight: 600,
};

const errorText: CSSProperties = { color: '#f2a1a1', fontSize: 13, margin: 0 };

const hint: CSSProperties = { color: '#9aa7b5', fontSize: 13, margin: 0, textAlign: 'center' };

/** Row of chips letting the user pick which 2FA factor to complete with. */
const methodPicker: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  justifyContent: 'center',
};

const methodChip: CSSProperties = {
  padding: '6px 12px',
  borderRadius: 999,
  border: '1px solid #2a333d',
  background: '#0f1419',
  color: '#c3cdd8',
  fontSize: 12,
  cursor: 'pointer',
};

const methodChipActive: CSSProperties = {
  ...methodChip,
  border: '1px solid #3d7dff',
  background: '#16233a',
  color: '#e6eefc',
};

/** Human label for an API 2FA method slug. */
function methodLabel(t: (key: MessageKey) => string, method: string): string {
  switch (method) {
    case 'authenticator':
      return t('login.twoFactor.method.authenticator');
    case 'sms':
      return t('login.twoFactor.method.sms');
    case 'phone_call':
      return t('login.twoFactor.method.phoneCall');
    case 'email':
      return t('login.twoFactor.method.email');
    default:
      return method;
  }
}

/** Segmented control for the sign-in surfaces. */
const tabs: CSSProperties = {
  display: 'flex',
  gap: 4,
  padding: 4,
  borderRadius: 10,
  background: '#0f1419',
  border: '1px solid #2a333d',
};

const tab = (active: boolean): CSSProperties => ({
  flex: 1,
  padding: '7px 10px',
  borderRadius: 7,
  border: 'none',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
  background: active ? '#2f5c9e' : 'transparent',
  color: active ? '#fff' : '#9aa7b5',
});

const qrFrame: CSSProperties = {
  alignSelf: 'center',
  display: 'grid',
  placeItems: 'center',
  padding: 10,
  borderRadius: 12,
  background: '#e8eef4',
};

const codeBadge: CSSProperties = {
  alignSelf: 'center',
  padding: '8px 16px',
  borderRadius: 8,
  background: '#0f1419',
  border: '1px solid #3a4654',
  color: '#e8eef4',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 22,
  fontWeight: 700,
  letterSpacing: 3,
};

const footer: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexWrap: 'wrap',
  gap: 8,
  padding: '10px 18px',
  flexShrink: 0,
  borderTop: '1px solid #1e262e',
  fontSize: 12,
  color: '#6b7784',
};

const linkBtn: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  margin: 0,
  cursor: 'pointer',
  color: '#7ea6de',
  fontSize: 12,
  textDecoration: 'none',
};

const sep: CSSProperties = { color: '#39414a' };

const linkRow: CSSProperties = {
  display: 'flex',
  gap: 6,
  justifyContent: 'center',
  alignItems: 'baseline',
  fontSize: 13,
  color: '#9aa7b5',
  margin: 0,
};

/** Country -> region picker: mirrors the portal's auth screen field. */
const select: CSSProperties = {
  padding: '9px 11px',
  borderRadius: 8,
  border: '1px solid #3a4654',
  background: '#0f1419',
  color: '#e8eef4',
  fontSize: 14,
  width: '100%',
};

const regionNote: CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: '#8b98a6',
};

/** Warning/info card shown when a country has no active region. */
const notice = (tone: 'warn' | 'info'): CSSProperties => ({
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '10px 12px',
  borderRadius: 10,
  border: `1px solid ${tone === 'warn' ? '#6b5327' : '#2a4a5c'}`,
  background: tone === 'warn' ? '#241d10' : '#101f26',
  color: tone === 'warn' ? '#e6c98a' : '#9fc9dd',
  fontSize: 12,
});

/** Login-time sandbox disclaimer card (amber, above the sign-in card). */
const sandboxNotice: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  width: 380,
  padding: '10px 12px',
  borderRadius: 10,
  border: '1px solid #efb15a',
  background: '#2a2114',
  color: '#f0d9ab',
  fontSize: 12,
  lineHeight: 1.5,
};

/** Canonical marketing/portal targets for the login footer links. */
const ASSETSNEXUS_URL = 'https://assetsnexus.org';

type LinkPhase = 'idle' | 'starting' | 'pending' | 'denied' | 'expired' | 'error';

/** The three interactive sign-in surfaces (plus the QR "app" surface). */
type LoginMode = 'password' | 'email_code' | 'phone_code' | 'app';

/** Passwordless codes are a two-step flow: request, then verify. */
type CodePhase = 'identifier' | 'code';

export function LoginForm({
  auth,
  connection,
  onAuthChange,
}: {
  auth: AuthState;
  connection: DesktopConnectionConfig | null;
  onAuthChange: () => void;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<LoginMode>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Passwordless (email / phone code) state: which step, and where the code went.
  const [codePhase, setCodePhase] = useState<CodePhase>('identifier');
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);

  // Country -> region picker (same contract as the portal's auth screen). The
  // picked region rides along on the login payload so the region can bind the
  // account to its home region and reject a wrong-region login.
  const [countries, setCountries] = useState<CountryRow[]>([]);
  const [regions, setRegions] = useState<RegionRow[]>([]);
  const [countryCode, setCountryCode] = useState('');
  const [catalogReady, setCatalogReady] = useState(false);
  /** True when the catalog could not be loaded at all (region unreachable). */
  const [catalogFailed, setCatalogFailed] = useState(false);

  // Cross-device ("sign in with the Nexus app") state.
  const [linkPhase, setLinkPhase] = useState<LinkPhase>('idle');
  const [link, setLink] = useState<DeviceLinkSessionStart | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [qrSvg, setQrSvg] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopPolling = useRef(false);

  /**
   * Connected region's environment (sandbox badge / disclaimer). Best-effort,
   * null while loading/unknown; the UI fails closed (no badge) rather than
   * guessing.
   */
  const regionEnvironment = useRegionEnvironment();

  const twoFactor = auth.status === 'two_factor_required';
  const portalUrl = connection?.portalUrl ?? null;
  /**
   * Whether the connected region is a sandbox. The region answer is
   * authoritative; an unreadable/unknown region fails closed (no badge), so a
   * production instance is never mislabelled. The desktop has no build-env
   * fallback (unlike the portal), so unknown means hidden.
   */
  const isSandbox = shouldShowSandboxBadge({ regionEnvironment, buildEnvironment: null });
  const termsUrl = sandboxTermsUrl(portalUrl);

  const selectedCountry = useMemo(
    () => countries.find((c) => c.code === countryCode) ?? null,
    [countries, countryCode],
  );
  const { region: selectedRegion, inactiveRegion } = useMemo(
    () => (selectedCountry ? resolveCountryRegion(selectedCountry, regions) : { region: null, inactiveRegion: null }),
    [selectedCountry, regions],
  );
  /** Login can proceed once a country maps to an available region. */
  const regionReady = Boolean(selectedRegion);
  /**
   * The portal refuses to submit without a resolved region. The desktop matches
   * that, except when the catalog itself could not be loaded (a region outage
   * must not lock the user out); then login proceeds without a region and the
   * node's own region applies.
   */
  const regionBlocked = !catalogFailed && !regionReady;

  // Load the country/region catalog once. Both are public commands, so this
  // works on the signed-out screen. Seeded from the saved country, then the OS
  // locale, so the common case needs no interaction.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [ui, nextCountries, nextRegions] = await Promise.all([
          bridge.getUiSettings(),
          bridge.authListCountries(),
          bridge.authListRegions(),
        ]);
        if (cancelled) return;
        setCountries(nextCountries);
        setRegions(nextRegions);
        const saved = ui.loginCountry;
        const candidate =
          (saved && nextCountries.some((c) => c.code === saved) && saved) ||
          countryFromLocale(navigator.language) ||
          null;
        if (candidate && nextCountries.some((c) => c.code === candidate)) {
          setCountryCode(candidate);
        }
      } catch (err) {
        // A region outage must not block the form; the picker stays empty and
        // login proceeds without a region (the node's own region applies).
        console.warn('[login] country/region catalog unavailable', err);
        if (!cancelled) setCatalogFailed(true);
      } finally {
        if (!cancelled) setCatalogReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Persist the pick so the next launch remembers it (mirrors the portal). */
  const onCountryChange = useCallback((code: string) => {
    setCountryCode(code);
    if (code) void bridge.setUiSettings({ loginCountry: code }).catch(() => undefined);
  }, []);

  const clearPollTimer = useCallback(() => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  /**
   * Poll the in-flight link until it is approved/denied/expired. The main
   * process owns the secret deviceCode, so this only reacts to its verdict.
   */
  const poll = useCallback(
    async (intervalSeconds: number) => {
      if (stopPolling.current) return;
      try {
        const outcome = await bridge.authDeviceLinkPoll();
        if (outcome.status === 'approved') {
          setLinkPhase('idle');
          setLink(null);
          setQrSvg(null);
          onAuthChange();
          return;
        }
        if (outcome.status === 'denied') {
          setLinkPhase('denied');
          return;
        }
        if (outcome.status === 'expired') {
          setLinkPhase('expired');
          return;
        }
        const next = Math.max(2, outcome.interval || intervalSeconds || 5);
        pollTimer.current = setTimeout(() => void poll(next), next * 1000);
      } catch (err) {
        // A transient network blip should not kill the link; keep polling.
        console.warn('[login] device-link poll failed', err);
        const next = Math.max(2, intervalSeconds || 5);
        pollTimer.current = setTimeout(() => void poll(next), next * 1000);
      }
    },
    [onAuthChange],
  );

  const startDeviceLink = useCallback(async () => {
    stopPolling.current = false;
    clearPollTimer();
    setLinkError(null);
    setLinkPhase('starting');
    try {
      const started = await bridge.authDeviceLinkStart();
      setLink(started);
      setLinkPhase('pending');
      // Prefer the deep link so a phone with the app opens it directly; fall
      // back to the portal page (which also renders the code) otherwise.
      const qrPayload = started.appLink || started.verificationUri;
      const svg = await renderQrSvg(qrPayload, { size: 220 });
      setQrSvg(svg);
      pollTimer.current = setTimeout(() => void poll(started.interval), started.interval * 1000);
    } catch (err) {
      setLinkPhase('error');
      setLinkError(err instanceof Error ? err.message : t('login.qr.error'));
    }
  }, [clearPollTimer, poll, t]);

  // Start a link when the user opens the app tab; tear it down when they leave.
  useEffect(() => {
    if (mode !== 'app' || twoFactor) {
      stopPolling.current = true;
      clearPollTimer();
      return;
    }
    void startDeviceLink();
    return () => {
      stopPolling.current = true;
      clearPollTimer();
    };
  }, [mode, twoFactor, startDeviceLink, clearPollTimer]);

  /** Reset the per-mode ephemeral UI state (code step, errors, secrets). */
  const switchMode = useCallback(
    (next: LoginMode) => {
      setMode(next);
      setError(null);
      setCode('');
      setCodePhase('identifier');
      setCodeSentTo(null);
    },
    [],
  );

  /** Leave an in-flight challenge and return to the identifier step. */
  const abandonChallenge = useCallback(async () => {
    setError(null);
    setCode('');
    setCodePhase('identifier');
    setCodeSentTo(null);
    try {
      await bridge.authCancelChallenge();
    } catch {
      /* best-effort: nothing to cancel */
    }
    onAuthChange();
  }, [onAuthChange]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (twoFactor) {
        // A step-up 2FA challenge (password login, or passwordless step-up).
        await bridge.submitTwoFactor({ code, method: auth.methods[0] });
        // Drop the one-time code from renderer state as soon as it is proven.
        setCode('');
      } else if (mode === 'password') {
        if (regionBlocked) {
          setError(t('login.region.required'));
          setBusy(false);
          return;
        }
        await bridge.login({
          email,
          password,
          region: selectedRegion?.slug ?? null,
        });
        // The password has been handed to main; do not keep it in renderer
        // state once the step succeeded (a failed attempt is kept for retry).
        setPassword('');
      } else if (mode === 'email_code') {
        if (codePhase === 'identifier') {
          await bridge.authStartPasswordless({ channel: 'email', identifier: email });
        } else {
          await bridge.authVerifyPasswordless({ code });
          setCode('');
        }
      } else if (mode === 'phone_code') {
        if (codePhase === 'identifier') {
          await bridge.authStartPasswordless({ channel: 'sms', identifier: phone });
        } else {
          await bridge.authVerifyPasswordless({ code });
          setCode('');
        }
      }
      // After a passwordless start the state becomes two_factor_required; the
      // renderer advances to the code step from that transition.
      const next = await bridge.getAuthState();
      if (next.status === 'two_factor_required' && next.flow === 'passwordless') {
        setCodePhase('code');
        setCodeSentTo(next.hint?.sentTo ?? null);
      }
      onAuthChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'login failed');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Re-target the pending password challenge at another enrolled factor.
   * The region dispatches the new channel's code (e.g. an email) on switch,
   * which is the only way to reach email when an authenticator is also enrolled.
   */
  async function onSwitchMethod(method: string) {
    setBusy(true);
    setError(null);
    setCode('');
    try {
      await bridge.authSwitchTwoFactor(method);
      onAuthChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not switch method');
    } finally {
      setBusy(false);
    }
  }

  async function onResend(channel?: 'email' | 'sms' | 'voice') {    setBusy(true);
    setError(null);
    try {
      await bridge.authResendPasswordless(channel ? { channel } : undefined);
      const next = await bridge.getAuthState();
      if (next.status === 'two_factor_required') {
        setCodeSentTo(next.hint?.sentTo ?? codeSentTo);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not resend the code');
    } finally {
      setBusy(false);
    }
  }

  const identifierForm = (kind: 'email_code' | 'phone_code') => {
    const isPhone = kind === 'phone_code';
    // When a 2FA step-up is active we are always past the identifier step, even
    // if the renderer reloaded and lost the local `codePhase`.
    const onIdentifierStep = !twoFactor && codePhase === 'identifier';
    const stepUpMethods = twoFactor ? auth.methods : [];
    const stepUpIsAuthenticator =
      stepUpMethods.length > 0 && stepUpMethods.every((m) => m === 'authenticator');
    const maskedTarget = twoFactor ? auth.hint?.sentTo ?? null : null;
    return (
      <form style={card} onSubmit={onSubmit}>
        <h1 style={{ margin: 0, fontSize: 18 }}>
          {t(isPhone ? 'login.title.phoneCode' : 'login.title.emailCode')}
        </h1>
        {onIdentifierStep ? (
          <p style={hint}>
            {t(isPhone ? 'login.subtitle.phoneCode' : 'login.subtitle.emailCode')}
          </p>
        ) : null}

        {onIdentifierStep ? (
          <label style={field}>
            <span>{t(isPhone ? 'login.field.phone' : 'login.field.email')}</span>
            <input
              style={input}
              type={isPhone ? 'tel' : 'email'}
              inputMode={isPhone ? 'tel' : 'email'}
              autoComplete={isPhone ? 'tel' : 'email'}
              placeholder={isPhone ? t('login.field.phonePlaceholder') : undefined}
              value={isPhone ? phone : email}
              onChange={(e) => (isPhone ? setPhone(e.target.value) : setEmail(e.target.value))}
              required
            />
          </label>
        ) : (
          <>
            <p style={{ ...hint, color: '#9aa7b5' }}>
              {stepUpIsAuthenticator
                ? t('login.twoFactor.authenticator')
                : t(isPhone ? 'login.twoFactor.sentPhone' : 'login.twoFactor.sentEmail', {
                    target: codeSentTo ?? maskedTarget ?? (isPhone ? phone : email),
                  })}
            </p>
            <label style={field}>
              <span>{t('login.field.code')}</span>
              <input
                style={input}
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                autoFocus
              />
            </label>
          </>
        )}

        {error ? <p style={errorText}>{error}</p> : null}

        <button style={button} type="submit" disabled={busy}>
          {busy
            ? t('login.action.wait')
            : onIdentifierStep
              ? t('login.action.sendCode')
              : t('login.action.verifyCode')}
        </button>

        {onIdentifierStep ? (
          <button
            type="button"
            style={{ ...linkBtn, alignSelf: 'center' }}
            onClick={() => switchMode('password')}
          >
            {t('login.action.usePassword')}
          </button>
        ) : (
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button type="button" style={linkBtn} onClick={() => void onResend()} disabled={busy}>
              {t('login.action.resend')}
            </button>
            {isPhone ? (
              <button
                type="button"
                style={linkBtn}
                onClick={() => void onResend('email')}
                disabled={busy}
              >
                {t('login.action.resendEmail')}
              </button>
            ) : (
              <button
                type="button"
                style={linkBtn}
                onClick={() => void onResend('sms')}
                disabled={busy}
              >
                {t('login.action.resendSms')}
              </button>
            )}
            <button type="button" style={linkBtn} onClick={() => void abandonChallenge()}>
              {t('login.action.back')}
            </button>
          </div>
        )}
      </form>
    );
  };

  /**
   * Country picker + resolved region, mirroring the portal's auth screen. Also
   * surfaces the "region unavailable" / "coming soon" states so a country with
   * no live region is explained rather than silently failing at login.
   */
  const countryPicker = () => (
    <>
      <label style={field}>
        <span>{t('login.field.country')}</span>
        <select
          style={select}
          value={countryCode}
          onChange={(e) => onCountryChange(e.target.value)}
          disabled={!catalogReady}
          required
        >
          <option value="">
            {catalogReady ? t('login.field.countryPlaceholder') : t('login.action.wait')}
          </option>
          {countries.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      {selectedCountry && selectedRegion ? (
        <p style={regionNote}>
          {t('login.region.resolved', {
            name: selectedRegion.name,
            slug: selectedRegion.slug,
          })}
        </p>
      ) : null}

      {selectedCountry && inactiveRegion ? (
        <div style={notice('warn')}>
          <strong>{t('login.region.unavailableTitle')}</strong>
          <span>
            {t('login.region.unavailableBody', {
              name: inactiveRegion.name,
              state: inactiveRegion.state,
            })}
          </span>
        </div>
      ) : null}

      {selectedCountry && !selectedRegion && !inactiveRegion ? (
        <div style={notice('info')}>
          <strong>{t('login.region.comingSoonTitle')}</strong>
          <span>{t('login.region.comingSoonBody', { name: selectedCountry.name })}</span>
        </div>
      ) : null}
    </>
  );

  const renderPasswordForm = () => {
    const sentTo = twoFactor ? auth.hint?.sentTo ?? null : null;
    const methods = twoFactor ? auth.methods : [];
    const isAuthenticator = methods.length > 0 && methods.every((m) => m === 'authenticator');
    // When the account has more than one usable factor, let the user pick — the
    // region auto-selects the authenticator, so without this an email-only user
    // waits for a mail that is never sent (the portal has the same picker).
    const switchableMethods = methods.filter((m) => m !== 'biometric');
    const challengeHint = twoFactor ? auth.hint : undefined;
    const activeMethod = challengeHint?.methodSlug ?? challengeHint?.channelType ?? methods[0] ?? 'email';
    return (
      <form style={card} onSubmit={onSubmit}>
        <h1 style={{ margin: 0, fontSize: 18 }}>
          {twoFactor ? t('login.twoFactor.title') : t('login.title.password')}
        </h1>

        {twoFactor ? (
          <p style={hint}>
            {isAuthenticator
              ? t('login.twoFactor.authenticator')
              : sentTo
                ? t('login.twoFactor.sentEmail', { target: sentTo })
                : t('login.twoFactor.required')}
          </p>
        ) : (
          <>
            {countryPicker()}
            <label style={field}>
              <span>{t('login.field.email')}</span>
              <input
                style={input}
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            <label style={field}>
              <span>{t('login.field.password')}</span>
              <input
                style={input}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
          </>
        )}

        {twoFactor && switchableMethods.length > 1 ? (
          <div style={methodPicker} role="group" aria-label={t('login.twoFactor.choose')}>
            {switchableMethods.map((m) => (
              <button
                key={m}
                type="button"
                style={m === activeMethod ? methodChipActive : methodChip}
                disabled={busy}
                onClick={() => void onSwitchMethod(m)}
              >
                {methodLabel(t, m)}
              </button>
            ))}
          </div>
        ) : null}

        {twoFactor ? (
          <label style={field}>
            <span>{t('login.field.code')}</span>
            <input
              style={input}
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              autoFocus
            />
          </label>
        ) : null}

        {error ? <p style={errorText}>{error}</p> : null}

        <button style={button} type="submit" disabled={busy || !catalogReady}>
          {busy
            ? t('login.action.wait')
            : twoFactor
              ? t('login.action.verify')
              : t('login.action.signIn')}
        </button>

        {twoFactor ? (
          <button
            type="button"
            style={{ ...linkBtn, alignSelf: 'center' }}
            onClick={() => void abandonChallenge()}
          >
            {t('login.action.back')}
          </button>
        ) : (
          <button
            type="button"
            style={{ ...linkBtn, alignSelf: 'center' }}
            onClick={() => switchMode('email_code')}
          >
            {t('login.action.useCode')}
          </button>
        )}
      </form>
    );
  };

  const renderAppForm = () => (
    <div style={card}>
      <h1 style={{ margin: 0, fontSize: 18 }}>{t('login.title.app')}</h1>

      {linkPhase === 'pending' && link ? (
        <>
          <p style={hint}>{t('login.qr.scan')}</p>
          <div style={qrFrame}>
            {qrSvg ? (
              // Inline SVG generated by the `qrcode` browser build.
              <div style={{ width: 220, height: 220 }} dangerouslySetInnerHTML={{ __html: qrSvg }} />
            ) : (
              <div style={{ width: 220, height: 220, display: 'grid', placeItems: 'center', color: '#6b7784' }}>
                {t('login.qr.generating')}
              </div>
            )}
          </div>
          <div style={codeBadge}>{link.userCode}</div>
          <p style={hint}>{t('login.qr.orEnter')}</p>
          <button style={ghostButton} type="button" onClick={() => void startDeviceLink()}>
            {t('login.action.refreshCode')}
          </button>
        </>
      ) : null}

      {linkPhase === 'starting' ? <p style={hint}>{t('login.qr.preparing')}</p> : null}

      {linkPhase === 'denied' ? (
        <>
          <p style={errorText}>{t('login.qr.denied')}</p>
          <button style={button} type="button" onClick={() => void startDeviceLink()}>
            {t('login.action.tryAgain')}
          </button>
        </>
      ) : null}

      {linkPhase === 'expired' ? (
        <>
          <p style={errorText}>{t('login.qr.expired')}</p>
          <button style={button} type="button" onClick={() => void startDeviceLink()}>
            {t('login.action.getNewCode')}
          </button>
        </>
      ) : null}

      {linkPhase === 'error' ? (
        <>
          <p style={errorText}>{linkError ?? t('login.qr.error')}</p>
          <button style={button} type="button" onClick={() => void startDeviceLink()}>
            {t('login.action.retry')}
          </button>
        </>
      ) : null}
    </div>
  );

  // While a 2FA challenge is active the tabs are hidden: the user must finish
  // (or abandon) the challenge before choosing a different sign-in surface.
  const activeTab: LoginMode = twoFactor ? (auth.flow === 'passwordless' ? mode : 'password') : mode;

  const tabLabels: Array<{ id: LoginMode; key: MessageKey }> = [
    { id: 'password', key: 'login.tab.password' },
    { id: 'email_code', key: 'login.tab.emailCode' },
    { id: 'phone_code', key: 'login.tab.phoneCode' },
    { id: 'app', key: 'login.tab.app' },
  ];

  return (
    <div style={page}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '14px 18px 0',
        }}
      >
        <div>
          {isSandbox ? (
            <span
              style={sandboxBadgeStyle}
              title={SANDBOX_BADGE_DESCRIPTION}
              aria-label={SANDBOX_BADGE_LABEL}
            >
              {SANDBOX_BADGE_LABEL}
            </span>
          ) : null}
        </div>
        <LanguageSelector />
      </div>
      <div style={wrap}>
        {isSandbox ? (
          <div style={sandboxNotice} role="note">
            <span>{SANDBOX_DISCLAIMER}</span>
            {termsUrl ? (
              <button
                type="button"
                style={{ ...linkBtn, alignSelf: 'flex-start' }}
                onClick={() => void bridge.openExternal(termsUrl)}
              >
                {SANDBOX_TERMS_LABEL}
              </button>
            ) : null}
          </div>
        ) : null}
        {!twoFactor ? (
          <div style={{ ...tabs, width: 380 }}>
            {tabLabels.map(({ id, key }) => (
              <button
                key={id}
                type="button"
                style={tab(activeTab === id)}
                onClick={() => switchMode(id)}
              >
                {t(key)}
              </button>
            ))}
          </div>
        ) : null}

        {twoFactor
          ? auth.flow === 'passwordless'
            ? identifierForm(mode === 'phone_code' ? 'phone_code' : 'email_code')
            : renderPasswordForm()
          : mode === 'app'
            ? renderAppForm()
            : mode === 'password'
              ? renderPasswordForm()
              : identifierForm(mode)}

        {!twoFactor && mode === 'password' && portalUrl ? (
          <p style={{ ...linkRow, width: 380 }}>
            <span>{t('login.register.prompt')}</span>
            <button
              type="button"
              style={linkBtn}
              onClick={() => void bridge.openExternal(`${portalUrl.replace(/\/+$/, '')}/register`)}
            >
              {t('login.register.link')}
            </button>
          </p>
        ) : null}
      </div>

      <div style={footer}>
        {portalUrl ? (
          <button type="button" style={linkBtn} onClick={() => void bridge.openExternal(portalUrl)}>
            {t('login.footer.portal')}
          </button>
        ) : null}
        {portalUrl ? <span style={sep}>·</span> : null}
        <button
          type="button"
          style={linkBtn}
          onClick={() => void bridge.openExternal(ASSETSNEXUS_URL)}
        >
          {t('login.footer.assetsNexus')}
        </button>
        <span style={sep}>·</span>
        <span>
          {linkBrands(t('login.footer.poweredBy')).map((segment, index) => {
            const href = segment.href;
            return href ? (
              <button
                key={`brand-${index}`}
                type="button"
                style={linkBtn}
                onClick={() => void bridge.openExternal(href)}
              >
                {segment.text}
              </button>
            ) : (
              <span key={`text-${index}`}>{segment.text}</span>
            );
          })}
        </span>
      </div>
    </div>
  );
}
