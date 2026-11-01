/**
 * Storage hub → Data rooms.
 *
 * Deliberately a **list only** surface. A data room's lifecycle (create, rename,
 * hosting policy, shares/invites, guest privacy, freeze, delete) is a multi-screen
 * flow with guest auth and analytics that the portal already owns — duplicating it
 * in a desktop pane would fork the truth. So this section answers "what data rooms
 * can I see, and how are they doing?" and hands every managing action to the
 * portal via a deep-link.
 *
 * Data comes from the region's own commands (`anx.data-room.list`, plus a bounded
 * `anx.data-room.analytics.summary` per room for the views column), so the numbers
 * match what the portal shows.
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
  dataRoomRowStats,
  loadDataRooms,
  withAnalytics,
  type DataRoomAnalyticsSummary,
  type DataRoomListFilter,
  type DataRoomListRow,
  type DataRoomRowStats,
} from '../../storage/portal-collections.js';
import {
  absolutePortalUrl,
  dataRoomDetailPath,
  dataRoomsListPath,
  portalSurfaceFor,
} from '../../storage/portal-links.js';
import { useRegionClient } from './use-region-client.js';

/**
 * How many rooms get an engagement summary fetched on a list load.
 *
 * The summary is an admin-scoped call per room and the region caches it for 60s,
 * so a whole page of 25 rooms would be 25 commands for a column most users scan
 * rather than read. The first few are enough to show "views this week" without
 * turning a list refresh into a fan-out; rooms beyond the cap show "—" and open
 * in the portal for the full analytics panel.
 */
const ANALYTICS_ROOM_CAP = 6;

export function DataRoomsSection() {
  const { t } = useI18n();
  const { client, portalUrl, orgId: sessionOrgId, ready } = useRegionClient();
  const [filter, setFilter] = useState<DataRoomListFilter>('mine');
  const [rows, setRows] = useState<DataRoomListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<Record<string, DataRoomRowStats>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Bumped by Refresh so the load effect re-runs without changing the filter. */
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const page = await loadDataRooms(client, filter);
        if (cancelled) return;
        setRows(page.items);
        setTotal(page.total);
        setStats(Object.fromEntries(page.items.map((row) => [row.id, dataRoomRowStats(row)])));
        // Views are a separate, admin-scoped call per room — bounded so a list
        // refresh never turns into an unbounded fan-out. A 403 (caller is not a
        // room admin) simply leaves the column at "—" for that room.
        const capped = page.items.slice(0, ANALYTICS_ROOM_CAP);
        const summaries = await Promise.allSettled(
          capped.map((row) => client.send('anx.data-room.analytics.summary', { dataRoomId: row.id })),
        );
        if (cancelled) return;
        const merged: Record<string, DataRoomRowStats> = {};
        capped.forEach((row, index) => {
          const settled = summaries[index];
          const summary =
            settled?.status === 'fulfilled'
              ? readSummary(settled.value)
              : null;
          merged[row.id] = withAnalytics(dataRoomRowStats(row), summary);
        });
        setStats(merged);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'failed to load data rooms');
        setRows([]);
        setTotal(0);
        setStats({});
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, filter, reloadKey]);

  /**
   * Console the "manage"/"new" deep-links target. A row's own scope wins (an org
   * member may hold a personal room), falling back to the session's active org so
   * an empty list still lands on the console the user actually works in.
   */
  const surface = portalSurfaceFor(rows[0]?.orgId ?? sessionOrgId);

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

  return (
    <SectionCard title={t('storage.datarooms.title')} help={t('storage.datarooms.help')}>
      <div style={{ ...settingsRow, gap: 8 }}>
        <button
          type="button"
          style={collectionFilterButton(filter === 'mine')}
          onClick={() => setFilter('mine')}
        >
          {t('storage.datarooms.filter.mine')}
        </button>
        <button
          type="button"
          style={collectionFilterButton(filter === 'shared_with_me')}
          onClick={() => setFilter('shared_with_me')}
        >
          {t('storage.datarooms.filter.shared')}
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
        <p style={settingsMuted}>{t('storage.datarooms.empty')}</p>
      ) : null}

      {rows.length ? (
        <div>
          {rows.map((row) => {
            const rowStats = stats[row.id] ?? dataRoomRowStats(row);
            return (
              <div key={row.id}>
                <div style={settingsRow}>
                  <strong style={collectionRowName}>{row.name}</strong>
                  <span style={collectionBadge}>
                    {row.ownerScope === 'org' || row.orgId
                      ? t('storage.collections.scope.org')
                      : t('storage.collections.scope.personal')}
                  </span>
                  {row.visibility ? (
                    <span style={collectionBadge}>
                      {t('storage.collections.visibility', { visibility: row.visibility })}
                    </span>
                  ) : null}
                  {row.frozen ? (
                    <span style={collectionBadge}>{t('storage.datarooms.frozen')}</span>
                  ) : null}
                  <span style={{ flex: 1 }} />
                  <button
                    type="button"
                    style={settingsTinyButton}
                    onClick={() =>
                      void open(dataRoomDetailPath(row.id, portalSurfaceFor(row.orgId)))
                    }
                  >
                    {t('storage.datarooms.open')}
                  </button>
                </div>
                <div style={collectionRowMeta}>
                  <span>{t('storage.datarooms.items', { count: rowStats.itemCount })}</span>
                  <span>{t('storage.datarooms.shares', { count: rowStats.activeShareCount })}</span>
                  <span>
                    {rowStats.visits == null
                      ? t('storage.datarooms.viewsUnavailable')
                      : t('storage.datarooms.views', { count: rowStats.visits })}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      <div style={{ ...settingsRow, gap: 8, marginTop: 8 }}>
        {rows.length ? (
          <span style={settingsMuted}>{t('storage.collections.total', { count: total })}</span>
        ) : null}
        <span style={{ flex: 1 }} />
        <button type="button" style={settingsGhostButton} onClick={() => void open(dataRoomsListPath(surface))}>
          {t('storage.datarooms.manage')}
        </button>
        <button type="button" style={settingsButton} onClick={() => void open(dataRoomsListPath(surface))}>
          {t('storage.datarooms.new')}
        </button>
      </div>
    </SectionCard>
  );
}

/**
 * Pull an engagement summary out of a raw command reply. The section deliberately
 * ignores failures: a room the caller does not administer answers 403 and its
 * views column stays "—", which is honest rather than showing a zero.
 */
function readSummary(reply: unknown): DataRoomAnalyticsSummary | null {
  if (!reply || typeof reply !== 'object') return null;
  const record = reply as Record<string, unknown>;
  const code = Number(record.responseCode ?? record.status ?? 0);
  if (Number.isFinite(code) && code >= 400) return null;
  const data = record.responseObject ?? record.data ?? record;
  if (!data || typeof data !== 'object') return null;
  const summary = data as DataRoomAnalyticsSummary;
  if ('visits' in summary || 'uniqueViewers' in summary) return summary;
  return null;
}
