/**
 * Settings → Integrations.
 *
 * Everything that connects this desktop to the wider Nexus/asset world:
 *  - **Nexus apps** (`NexusAppsPanel`) — install/enable third-party apps + tray.
 *  - **Trusted certificates** (`CertTrustPanel`) — review/revoke TLS pins.
 *  - **LAN asset agents** — mDNS discovery (`_anx._tcp`) and the "prefer the
 *    local path to my asset agents" switch, so the desktop talks to its own
 *    asset nodes over the LAN instead of routing through the region.
 */

import { useCallback, useEffect, useState } from 'react';
import { bridge, type AssetAgentDiscoverySnapshot } from '../../bridge.js';
import { useI18n } from '../../i18n/index.js';
import { ErrorBoundary } from '../ErrorBoundary.js';
import { NexusAppsPanel } from '../NexusAppsPanel.js';
import { CertTrustPanel } from '../CertTrustPanel.js';
import {
  CheckboxField,
  HealthChip,
  SectionCard,
  settingsGhostButton,
  settingsMuted,
  settingsRow,
} from './settings-ui.js';

export function IntegrationsSection() {
  const { t } = useI18n();
  const [assetAgents, setAssetAgents] = useState<AssetAgentDiscoverySnapshot | null>(null);
  const [assetBusy, setAssetBusy] = useState(false);

  const refreshAssetAgents = useCallback(async (scan: boolean) => {
    setAssetBusy(true);
    try {
      setAssetAgents(
        scan ? await bridge.assetAgentDiscoveryScan() : await bridge.assetAgentDiscoverySnapshot(),
      );
    } finally {
      setAssetBusy(false);
    }
  }, []);

  useEffect(() => {
    void refreshAssetAgents(false);
  }, [refreshAssetAgents]);

  return (
    <>
      <ErrorBoundary label={t('settings.integrations.nexusApps')}>
        <NexusAppsPanel />
      </ErrorBoundary>

      <ErrorBoundary label={t('settings.integrations.certificates')}>
        <CertTrustPanel />
      </ErrorBoundary>

      <SectionCard title={t('settings.integrations.lanAgents')} help={t('settings.integrations.lanAgents.help')}>
        {assetAgents ? (
          <>
            <CheckboxField
              checked={assetAgents.preferLocalEnabled}
              disabled={assetBusy}
              onChange={(v) => void bridge.assetAgentSetPreferLocal(v).then(setAssetAgents)}
              label={t('settings.integrations.lanAgents.prefer')}
            />

            {assetAgents.matches.length ? (
              assetAgents.matches.map((m) => (
                <div key={m.contactId} style={settingsRow}>
                  <strong style={{ fontSize: 13 }}>{m.name ?? m.assetId}</strong>
                  <span style={settingsMuted}>
                    {m.host}:{m.port}
                  </span>
                  <HealthChip health={m.routeKind === 'intranet' ? 'available' : 'healthy'} />
                  <span style={{ flex: 1 }} />
                  {m.hostsRooms ? (
                    <span style={{ color: '#6b7784', fontSize: 11 }}>{t('settings.integrations.lanAgents.hostsRooms')}</span>
                  ) : null}
                </div>
              ))
            ) : (
              <p style={settingsMuted}>{assetAgents.detail ?? t('settings.integrations.lanAgents.none')}</p>
            )}

            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <button
                type="button"
                style={settingsGhostButton}
                onClick={() => void refreshAssetAgents(true)}
                disabled={assetBusy}
              >
                {assetBusy ? t('settings.integrations.lanAgents.scanning') : t('settings.integrations.lanAgents.scan')}
              </button>
              {assetAgents.region ? (
                <span style={{ color: '#6b7784', fontSize: 11 }}>
                  {assetAgents.rejectedForeignRegion
                    ? t('settings.integrations.lanAgents.regionForeign', {
                        region: assetAgents.region,
                        count: assetAgents.rejectedForeignRegion,
                      })
                    : t('settings.integrations.lanAgents.region', { region: assetAgents.region })}
                </span>
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
