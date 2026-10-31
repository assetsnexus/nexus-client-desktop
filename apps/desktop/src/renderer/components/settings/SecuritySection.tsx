/**
 * Settings → Security (app PIN lock).
 *
 * The inactivity lock is a **UI gate only**: it hides the interface behind a PIN
 * after a period without input, and never blocks sign-in, 2FA, or any secure
 * operation. Forgetting the PIN is recovered by signing out / switching user,
 * which always clears it.
 *
 * The PIN itself never crosses this component: it is written through
 * `appLockSetPin` and only the redacted `AppLockState` comes back.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  bridge,
  LOCK_TIMEOUT_CHOICES,
  PIN_MIN_LENGTH,
  type AppLockSettings,
  type AppLockState,
} from '../../bridge.js';
import { useI18n } from '../../i18n/index.js';
import {
  CheckboxField,
  Field,
  SectionCard,
  settingsButton,
  settingsGhostButton,
  settingsInput,
  settingsMuted,
} from './settings-ui.js';

export function SecuritySection() {
  const { t } = useI18n();
  const [appLock, setAppLock] = useState<AppLockState | null>(null);
  const [pinDraft, setPinDraft] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);

  useEffect(() => {
    void bridge.appLockGetState().then(setAppLock).catch(() => setAppLock(null));
  }, []);

  const patchAppLock = useCallback(async (patch: Partial<AppLockSettings>) => {
    try {
      setAppLock(await bridge.appLockUpdateSettings(patch));
    } catch (err) {
      setPinError(err instanceof Error ? err.message : 'could not update the lock');
    }
  }, []);

  const savePin = useCallback(async () => {
    setPinError(null);
    try {
      setAppLock(await bridge.appLockSetPin(pinDraft.trim()));
      setPinDraft('');
    } catch (err) {
      setPinError(err instanceof Error ? err.message : 'could not set the PIN');
    }
  }, [pinDraft]);

  const clearPin = useCallback(async () => {
    setPinError(null);
    try {
      setAppLock(await bridge.appLockClearPin());
    } catch (err) {
      setPinError(err instanceof Error ? err.message : 'could not clear the PIN');
    }
  }, []);

  return (
    <SectionCard title={t('settings.appLock')} help={t('settings.appLock.help')}>
      {appLock ? (
        <>
          <CheckboxField
            checked={appLock.settings.enabled}
            disabled={!appLock.hasPin}
            onChange={(v) => void patchAppLock({ enabled: v })}
            label={t('settings.appLock.enable')}
            hint={!appLock.hasPin ? t('settings.appLock.needPin') : undefined}
          />

          <Field label={t('settings.appLock.timeout')}>
            <select
              style={settingsInput}
              value={appLock.settings.timeoutMinutes}
              disabled={!appLock.settings.enabled}
              onChange={(e) => void patchAppLock({ timeoutMinutes: Number(e.target.value) })}
            >
              {LOCK_TIMEOUT_CHOICES.map((m) => (
                <option key={m} value={m}>
                  {m === 1
                    ? t('settings.appLock.minuteOne')
                    : t('settings.appLock.minutes', { count: m })}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label={
              appLock.hasPin
                ? t('settings.appLock.replacePin')
                : t('settings.appLock.setPin', { min: PIN_MIN_LENGTH })
            }
          >
            <input
              style={settingsInput}
              type="password"
              inputMode="numeric"
              value={pinDraft}
              placeholder="••••"
              onChange={(e) => setPinDraft(e.target.value.replace(/[^0-9]/g, ''))}
            />
          </Field>
          {pinError ? <span style={{ color: '#f2a1a1', fontSize: 12 }}>{pinError}</span> : null}

          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button
              type="button"
              style={settingsButton}
              disabled={pinDraft.trim().length < PIN_MIN_LENGTH}
              onClick={() => void savePin()}
            >
              {appLock.hasPin ? t('settings.appLock.replacePinAction') : t('settings.appLock.setPinAction')}
            </button>
            {appLock.hasPin ? (
              <button type="button" style={settingsGhostButton} onClick={() => void clearPin()}>
                {t('settings.appLock.removePin')}
              </button>
            ) : null}
            {appLock.armed ? (
              <span style={{ color: '#4ade80', fontSize: 12 }}>
                {t('settings.appLock.armed', { minutes: appLock.settings.timeoutMinutes })}
              </span>
            ) : (
              <span style={settingsMuted}>{t('settings.appLock.notArmed')}</span>
            )}
            <span style={{ flex: 1 }} />
            {appLock.armed ? (
              <button
                type="button"
                style={settingsGhostButton}
                onClick={() => void bridge.appLockLock()}
              >
                {t('settings.appLock.lockNow')}
              </button>
            ) : null}
          </div>
          <span style={settingsMuted}>{t('settings.appLock.recovery')}</span>
        </>
      ) : (
        <p style={settingsMuted}>{t('settings.loading')}</p>
      )}
    </SectionCard>
  );
}
