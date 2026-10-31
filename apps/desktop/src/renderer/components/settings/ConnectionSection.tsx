/**
 * Settings → Connection.
 *
 * The region node / gateway / portal targets and an optional custom CA, plus the
 * local **GPU runner (BYOK)** block: this machine's own model server, exposed to
 * the user's agents through a loopback TLS proxy registered with the region as an
 * `edge_gpu_sidecar` provider.
 *
 * Saved through `setConnectionConfig` (region/gateway/portal/CA) and
 * `runnerSetSettings` / `runnerRegister` (the runner); the connection change is
 * reported back to the shell so every window picks it up without a restart.
 */

import { useCallback, useEffect, useState } from 'react';
import type { DesktopConnectionConfig } from '@nexus/node-core';
import {
  bridge,
  type LocalRunnerSettings,
  type LocalRunnerState,
} from '../../bridge.js';
import { useI18n } from '../../i18n/index.js';
import {
  Field,
  HealthChip,
  SectionCard,
  settingsButton,
  settingsGhostButton,
  settingsInput,
  settingsMuted,
  settingsRow,
} from './settings-ui.js';

export function ConnectionSection({
  connection,
  onConnectionChange,
  onClose,
}: {
  connection: DesktopConnectionConfig;
  onConnectionChange: (next: DesktopConnectionConfig) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [regionUrl, setRegionUrl] = useState(connection.regionUrl);
  const [gatewayUrl, setGatewayUrl] = useState(connection.gatewayUrl ?? '');
  const [portalUrl, setPortalUrl] = useState(connection.portalUrl ?? '');
  const [customCaPem, setCustomCaPem] = useState(connection.customCaPem ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [runner, setRunner] = useState<LocalRunnerState | null>(null);
  const [runnerBusy, setRunnerBusy] = useState(false);

  useEffect(() => {
    void bridge.runnerGetState().then(setRunner);
  }, []);

  const patchRunner = useCallback(async (patch: Partial<LocalRunnerSettings>) => {
    setRunnerBusy(true);
    try {
      setRunner(await bridge.runnerSetSettings(patch));
    } finally {
      setRunnerBusy(false);
    }
  }, []);

  const registerRunner = useCallback(async () => {
    setRunnerBusy(true);
    try {
      setRunner(await bridge.runnerRegister());
    } catch (err) {
      // Surface the reason (e.g. signed out) rather than failing silently.
      setRunner((cur) =>
        cur ? { ...cur, detail: err instanceof Error ? err.message : t('settings.connection.runner.failed') } : cur,
      );
    } finally {
      setRunnerBusy(false);
    }
  }, [t]);

  async function onSave() {
    setSaving(true);
    setSaved(false);
    try {
      const next = await bridge.setConnectionConfig({
        regionUrl,
        gatewayUrl: gatewayUrl || null,
        portalUrl: portalUrl || null,
        customCaPem: customCaPem || null,
      });
      onConnectionChange(next);
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <SectionCard title={t('settings.connection')} help={t('settings.connection.help')}>
        <Field label={t('settings.connection.region')}>
          <input style={settingsInput} value={regionUrl} onChange={(e) => setRegionUrl(e.target.value)} />
        </Field>
        <Field label={t('settings.connection.gateway')}>
          <input
            style={settingsInput}
            value={gatewayUrl}
            placeholder={t('settings.connection.gateway.placeholder')}
            onChange={(e) => setGatewayUrl(e.target.value)}
          />
        </Field>
        <Field label={t('settings.connection.portal')}>
          <input
            style={settingsInput}
            value={portalUrl}
            placeholder={t('settings.connection.portal.placeholder')}
            onChange={(e) => setPortalUrl(e.target.value)}
          />
        </Field>
        <Field label={t('settings.connection.customCa')}>
          <textarea
            style={{ ...settingsInput, minHeight: 90, fontFamily: 'monospace' }}
            value={customCaPem}
            placeholder="-----BEGIN CERTIFICATE-----"
            onChange={(e) => setCustomCaPem(e.target.value)}
          />
        </Field>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button type="button" style={settingsButton} onClick={onSave} disabled={saving}>
            {saving ? t('settings.connection.saving') : t('settings.connection.save')}
          </button>
          {saved ? <span style={{ color: '#4ade80', fontSize: 12 }}>{t('settings.connection.saved')}</span> : null}
          <span style={{ flex: 1 }} />
          <button type="button" style={settingsGhostButton} onClick={onClose}>
            {t('settings.done')}
          </button>
        </div>
      </SectionCard>

      <SectionCard title={t('settings.connection.runner')} help={t('settings.connection.runner.help')}>
        {runner ? (
          <>
            <label style={{ ...settingsRow, borderTop: 'none' }}>
              <input
                type="checkbox"
                checked={runner.settings.enabled}
                disabled={runnerBusy}
                onChange={(e) => void patchRunner({ enabled: e.target.checked })}
              />
              <span style={{ color: '#e8eef4' }}>{t('settings.connection.runner.enabled')}</span>
            </label>

            <Field label={t('settings.connection.runner.name')}>
              <input
                style={settingsInput}
                value={runner.settings.name}
                disabled={runnerBusy}
                onChange={(e) =>
                  setRunner({ ...runner, settings: { ...runner.settings, name: e.target.value } })
                }
                onBlur={(e) => void patchRunner({ name: e.target.value })}
              />
            </Field>

            <Field label={t('settings.connection.runner.upstream')}>
              <input
                style={settingsInput}
                value={runner.settings.upstreamBaseUrl}
                placeholder="http://127.0.0.1:11434"
                disabled={runnerBusy}
                onChange={(e) =>
                  setRunner({
                    ...runner,
                    settings: { ...runner.settings, upstreamBaseUrl: e.target.value },
                  })
                }
                onBlur={(e) => void patchRunner({ upstreamBaseUrl: e.target.value })}
              />
            </Field>

            <Field label={t('settings.connection.runner.scope')}>
              <select
                style={settingsInput}
                value={runner.settings.scope}
                disabled={runnerBusy}
                onChange={(e) => void patchRunner({ scope: e.target.value as 'user' | 'org' })}
              >
                <option value="user">{t('settings.connection.runner.scope.user')}</option>
                <option value="org">{t('settings.connection.runner.scope.org')}</option>
              </select>
            </Field>

            <div style={settingsRow}>
              <HealthChip health={runner.availability} />
              <span style={settingsMuted}>
                {runner.endpointUrl ?? runner.detail ?? t('settings.connection.runner.notRunning')}
              </span>
              <span style={{ flex: 1 }} />
              <span style={{ color: '#6b7784', fontSize: 11 }}>
                {runner.registered
                  ? runner.providerId
                    ? t('settings.connection.runner.registeredWith', { id: runner.providerId })
                    : t('settings.connection.runner.registered')
                  : t('settings.connection.runner.notRegistered')}
              </span>
            </div>

            {runner.certFingerprint ? (
              <p style={{ margin: 0, color: '#6b7784', fontSize: 11, fontFamily: 'monospace' }}>
                {t('settings.connection.runner.cert', {
                  fingerprint: runner.certFingerprint.slice(0, 32),
                  expires: runner.certNotAfter || '—',
                })}
              </p>
            ) : null}

            <div style={{ display: 'flex', gap: 10 }}>
              <button
                type="button"
                style={settingsButton}
                disabled={runnerBusy || !runner.settings.enabled}
                onClick={() => void registerRunner()}
              >
                {t('settings.connection.runner.register')}
              </button>
              {runner.settings.enabled ? (
                <button
                  type="button"
                  style={settingsGhostButton}
                  disabled={runnerBusy}
                  onClick={() => void patchRunner({ enabled: false })}
                >
                  {t('settings.connection.runner.stop')}
                </button>
              ) : null}
            </div>
          </>
        ) : (
          <p style={settingsMuted}>{t('settings.loading')}</p>
        )}
      </SectionCard>
    </>
  );
}
