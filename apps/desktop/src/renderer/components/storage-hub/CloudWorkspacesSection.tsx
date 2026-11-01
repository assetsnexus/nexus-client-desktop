/**
 * Storage hub → Cloud workspaces.
 *
 * A cloud workspace is a named collection of files/entities that agents and
 * humans collaborate on. Like the data-room section this is a **list only**
 * surface: creating, editing members, linking conversations/rooms and deleting a
 * workspace happen in the portal, where the full collaboration surface lives.
 *
 * The desktop's job is to answer "what workspaces exist, how big are they, and how
 * many people are in each?" from the region's own `anx.workspace.list`, then hand
 * anything that changes state to the portal.
 */

import { useCallback, useEffect, useState } from 'react';
import { bridge } from '../../bridge.js';
import { useI18n } from '../../i18n/index.js';
import {
  SectionCard,
  settingsButton,
  settingsGhostButton,
  settingsMuted,
  settingsRow,
  settingsTinyButton,
} from '../settings/settings-ui.js';
import {
  collectionBadge,
  collectionFilterButton,
  collectionRowMeta,
  collectionRowName,
} from './collection-ui.js';
import {
  loadCloudWorkspaces,
  workspaceRowStats,
  type WorkspaceListRow,
  type WorkspaceListVisibility,
} from '../../storage/portal-collections.js';
import {
  absolutePortalUrl,
  portalSurfaceFor,
  workspaceDetailPath,
  workspacesListPath,
} from '../../storage/portal-links.js';
import { useRegionClient } from './use-region-client.js';

export function CloudWorkspacesSection() {
  const { t } = useI18n();
  const { client, portalUrl, orgId: sessionOrgId, ready } = useRegionClient();
  const [visibility, setVisibility] = useState<WorkspaceListVisibility>('shared');
  const [rows, setRows] = useState<WorkspaceListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const page = await loadCloudWorkspaces(client, visibility);
        if (cancelled) return;
        setRows(page.items);
        setTotal(page.total);
        setHiddenCount(page.hiddenCount ?? 0);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'failed to load workspaces');
        setRows([]);
        setTotal(0);
        setHiddenCount(0);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, visibility, reloadKey]);

  const open = useCallback(
    async (path: string) => {
      const url = absolutePortalUrl(portalUrl, path);
      if (!url) {
        setError('No portal URL is configured for this connection.');
        return;
      }
      await bridge.openExternal(url);
    },
    [portalUrl],
  );

  // The "manage" link targets the console matching the rows in view; a personal
  // user has no org workspaces, so the list route follows the first row's scope.
  // With an empty list, fall back to the session's active org so an org member
  // lands on the `/b2b` console where their workspaces actually live.
  const surface = portalSurfaceFor(rows[0]?.orgId ?? sessionOrgId);

  return (
    <SectionCard title={t('storage.workspaces.title')} help={t('storage.workspaces.help')}>
      <div style={{ ...settingsRow, gap: 8 }}>
        <button
          type="button"
          style={collectionFilterButton(visibility === 'shared')}
          onClick={() => setVisibility('shared')}
        >
          {t('storage.workspaces.filter.shared')}
        </button>
        <button
          type="button"
          style={collectionFilterButton(visibility === 'all')}
          onClick={() => setVisibility('all')}
        >
          {t('storage.workspaces.filter.all')}
        </button>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          style={settingsTinyButton}
          onClick={() => setReloadKey((n) => n + 1)}
          disabled={!client || loading}
        >
          {t('storage.collections.refresh')}
        </button>
      </div>

      {!ready ? <p style={settingsMuted}>{t('storage.collections.loading')}</p> : null}

      {ready && !client ? (
        <p style={settingsMuted}>{t('storage.collections.signedOut')}</p>
      ) : null}

      {error ? (
        <p style={{ ...settingsMuted, color: '#f0a4a4' }}>
          {t('storage.collections.error', { error })}
        </p>
      ) : null}

      {client && loading && !rows.length ? (
        <p style={settingsMuted}>{t('storage.collections.loading')}</p>
      ) : null}

      {client && !loading && !error && !rows.length ? (
        <p style={settingsMuted}>{t('storage.workspaces.empty')}</p>
      ) : null}

      {rows.length ? (
        <div>
          {rows.map((row) => {
            const rowStats = workspaceRowStats(row);
            return (
              <div key={row.id}>
                <div style={settingsRow}>
                  <strong style={collectionRowName}>{row.name}</strong>
                  <span style={collectionBadge}>
                    {row.ownerScope === 'org' || row.orgId
                      ? t('storage.collections.scope.org')
                      : t('storage.collections.scope.personal')}
                  </span>
                  {row.accessMode ? (
                    <span style={collectionBadge}>
                      {t('storage.collections.accessMode', { mode: row.accessMode })}
                    </span>
                  ) : null}
                  <span style={{ flex: 1 }} />
                  <button
                    type="button"
                    style={settingsTinyButton}
                    onClick={() => void open(workspaceDetailPath(row.id, portalSurfaceFor(row.orgId)))}
                  >
                    {t('storage.workspaces.open')}
                  </button>
                </div>
                <div style={collectionRowMeta}>
                  <span>{t('storage.workspaces.items', { count: rowStats.itemCount })}</span>
                  <span>{t('storage.workspaces.members', { count: rowStats.memberCount })}</span>
                  <span>{t('storage.workspaces.people', { count: rowStats.humanUserCount })}</span>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {hiddenCount > 0 ? (
        <p style={settingsMuted}>{t('storage.workspaces.hidden', { count: hiddenCount })}</p>
      ) : null}

      <div style={{ ...settingsRow, gap: 8, marginTop: 8 }}>
        {rows.length ? (
          <span style={settingsMuted}>{t('storage.collections.total', { count: total })}</span>
        ) : null}
        <span style={{ flex: 1 }} />
        <button type="button" style={settingsGhostButton} onClick={() => void open(workspacesListPath(surface))}>
          {t('storage.workspaces.manage')}
        </button>
        <button type="button" style={settingsButton} onClick={() => void open(workspacesListPath(surface))}>
          {t('storage.workspaces.new')}
        </button>
      </div>
    </SectionCard>
  );
}
