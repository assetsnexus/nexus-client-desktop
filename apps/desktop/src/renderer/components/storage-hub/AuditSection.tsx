/**
 * Storage hub → Access audit.
 *
 * A filterable, keyset-paginated view over the region's storage access log
 * (`anx.storage.access-audit.list`) with per-grant revocation
 * (`anx.storage.access-audit.revoke-grant`). This is the *storage access* audit —
 * distinct from the client-tool audit under Settings → Developer.
 *
 * The component is deliberately thin: payload building, reply parsing, accessor
 * label resolution and the cursor stack all live in the pure module
 * `renderer/storage/access-audit.ts` (unit-tested there), and this file only
 * wires them to React state and the shared UI primitives.
 *
 * Two invariants it must honour:
 *  - a **failed** request renders its own error state with a Retry — never the
 *    empty state, which would read as "nothing ever happened";
 *  - a revoke always goes through a confirm dialog naming what will be revoked,
 *    and the outcome (success or the region's refusal) is shown.
 */

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { useI18n, type MessageKey } from '../../i18n/index.js';
import { Modal } from '../Modal.js';
import {
  CheckboxField,
  Field,
  SectionCard,
  settingsButton,
  settingsGhostButton,
  settingsInput,
  settingsMuted,
  settingsRow,
  settingsTinyButton,
} from '../settings/settings-ui.js';
import { collectionFilterButton } from './collection-ui.js';
import {
  DEFAULT_ACCESS_AUDIT_FILTERS,
  auditCursorAt,
  auditRowCanRevoke,
  auditRowCount,
  auditRowTouchedFileCount,
  loadStorageAuditPage,
  normalizeAccessAuditFilters,
  popAuditCursor,
  pushAuditCursor,
  resolveAccessorDisplay,
  revokeStorageGrant,
  shortenId,
  type AccessAuditFilterState,
  type AccessAuditRow,
  type AuditAccessorKind,
  type AuditDirection,
  type AuditGrantKind,
  type AuditGroupInfo,
} from '../../storage/access-audit.js';
import { useRegionClient } from './use-region-client.js';

/** Directions, in the order the filter bar shows them. */
const DIRECTIONS: readonly AuditDirection[] = ['all', 'read', 'write', 'search', 'share'];

/** Principal kinds selectable in the filter bar, with their label keys. */
const ACCESSOR_KINDS: readonly AuditAccessorKind[] = [
  'user',
  'agent',
  'share',
  'app',
  'guest',
  'service',
];

const DIRECTION_KEY: Record<AuditDirection, MessageKey> = {
  all: 'storage.audit.direction.all',
  read: 'storage.audit.direction.read',
  write: 'storage.audit.direction.write',
  search: 'storage.audit.direction.search',
  share: 'storage.audit.direction.share',
};

const ACCESSOR_KEY: Record<AuditAccessorKind | 'unknown', MessageKey> = {
  user: 'storage.audit.accessor.user',
  agent: 'storage.audit.accessor.agent',
  share: 'storage.audit.accessor.share',
  app: 'storage.audit.accessor.app',
  guest: 'storage.audit.accessor.guest',
  service: 'storage.audit.accessor.service',
  unknown: 'storage.audit.accessor.unknown',
};

const GRANT_KEY: Record<AuditGrantKind, MessageKey> = {
  share: 'storage.audit.revoke.kind.share',
  data_room_share: 'storage.audit.revoke.kind.data_room_share',
  workspace_member: 'storage.audit.revoke.kind.workspace_member',
};

/** The text inputs the filter bar keeps as drafts until applied. */
type TextDraft = Pick<
  AccessAuditFilterState,
  'accessorId' | 'pathPattern' | 'queryPattern' | 'since' | 'until'
>;

function draftOf(filters: AccessAuditFilterState): TextDraft {
  return {
    accessorId: filters.accessorId,
    pathPattern: filters.pathPattern,
    queryPattern: filters.queryPattern,
    since: filters.since,
    until: filters.until,
  };
}

const EMPTY_DRAFT = draftOf(DEFAULT_ACCESS_AUDIT_FILTERS);

/** Human timestamp, guarding an unparseable value so it never renders "Invalid Date". */
function formatWhen(value: string): string {
  if (!value) return '—';
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  return new Date(ms).toLocaleString();
}

/** The audit result table: a compact, dense, single-line-per-access layout. */
const tableStyle: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 12,
  marginTop: 8,
};

const thStyle: CSSProperties = {
  textAlign: 'left',
  padding: '6px 8px',
  borderBottom: '1px solid #2a333d',
  color: '#6b7784',
  fontWeight: 600,
};

const tdStyle: CSSProperties = {
  padding: '7px 8px',
  borderBottom: '1px solid #1e2630',
  color: '#cbd5e1',
  verticalAlign: 'top',
};

const smallButton: CSSProperties = { ...settingsGhostButton, padding: '6px 12px', fontSize: 12 };

export function AuditSection() {
  const { t } = useI18n();
  const { client, ready } = useRegionClient();

  const [filters, setFilters] = useState<AccessAuditFilterState>(DEFAULT_ACCESS_AUDIT_FILTERS);
  const [draft, setDraft] = useState<TextDraft>(EMPTY_DRAFT);
  const [rows, setRows] = useState<AccessAuditRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [groupInfo, setGroupInfo] = useState<AuditGroupInfo | undefined>(undefined);
  /** Keyset cursor stack; `['']` is page one. Previous pops, Next pushes. */
  const [cursorStack, setCursorStack] = useState<readonly string[]>(['']);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  /** Grant pending confirmation / in flight. */
  const [revokeTarget, setRevokeTarget] = useState<{ grantKind: AuditGrantKind; grantId: string } | null>(
    null,
  );
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revokeNotice, setRevokeNotice] = useState<string | null>(null);

  const cursor = auditCursorAt(cursorStack);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const page = await loadStorageAuditPage(client, filters, cursor);
        if (cancelled) return;
        setRows(page.items);
        setNextCursor(page.nextCursor);
        setGroupInfo(page.groupInfo);
      } catch (err) {
        if (cancelled) return;
        // A failure is NOT an empty log — clear the rows and show a retry.
        setError(err instanceof Error ? err.message : 'failed to load the access audit');
        setRows([]);
        setNextCursor(undefined);
        setGroupInfo(undefined);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `filters` is a fresh object on every change, so this re-runs for any edit.
  }, [client, filters, cursor, reloadKey]);

  /** Commit the whole filter (selects, toggle, applied text) and return to page one. */
  const commitFilters = useCallback((next: Partial<AccessAuditFilterState>) => {
    setFilters((current) => normalizeAccessAuditFilters({ ...current, ...next }));
    setCursorStack(['']);
  }, []);

  /** Apply the text drafts (Refresh button / Enter in an input). */
  const applyDraft = useCallback(() => {
    setFilters((current) => normalizeAccessAuditFilters({ ...current, ...draft }));
    setCursorStack(['']);
    setRevokeNotice(null);
  }, [draft]);

  const retry = useCallback(() => setReloadKey((n) => n + 1), []);

  const goNext = useCallback(() => {
    setCursorStack((stack) => pushAuditCursor(stack, nextCursor));
  }, [nextCursor]);

  const goPrevious = useCallback(() => {
    setCursorStack((stack) => popAuditCursor(stack));
  }, []);

  const confirmRevoke = useCallback(async () => {
    if (!client || !revokeTarget) return;
    setRevoking(true);
    setRevokeError(null);
    try {
      await revokeStorageGrant(client, revokeTarget.grantKind, revokeTarget.grantId);
      setRevokeTarget(null);
      setRevokeNotice(t('storage.audit.revoke.success'));
      // Refresh in place so the revoked row reflects reality.
      setReloadKey((n) => n + 1);
    } catch (err) {
      setRevokeError(err instanceof Error ? err.message : t('storage.collections.error', { error: '' }));
    } finally {
      setRevoking(false);
    }
  }, [client, revokeTarget, t]);

  const canGoNext = Boolean(nextCursor);
  const canGoPrevious = cursorStack.length > 1;

  return (
    <SectionCard title={t('storage.audit.title')} help={t('storage.audit.help')}>
      {/* Direction */}
      <Field label={t('storage.audit.filters.direction')}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {DIRECTIONS.map((direction) => (
            <button
              key={direction}
              type="button"
              style={collectionFilterButton(filters.direction === direction)}
              onClick={() => commitFilters({ direction })}
            >
              {t(DIRECTION_KEY[direction])}
            </button>
          ))}
        </div>
      </Field>

      {/* Principal kind + id */}
      <div style={{ ...settingsRow, gap: 10, flexWrap: 'wrap' }}>
        <Field label={t('storage.audit.filters.accessor')} rowStyle={{ ...settingsRow, gap: 6, padding: 0, border: 'none' }}>
          <select
            style={settingsInput}
            value={filters.accessorKind}
            onChange={(e) => commitFilters({ accessorKind: e.target.value as AccessAuditFilterState['accessorKind'] })}
          >
            <option value="">{t('storage.audit.filters.accessor.any')}</option>
            {ACCESSOR_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(ACCESSOR_KEY[kind])}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('storage.audit.filters.accessorId')} rowStyle={{ ...settingsRow, gap: 6, padding: 0, border: 'none' }}>
          <input
            style={{ ...settingsInput, width: 160 }}
            value={draft.accessorId}
            placeholder={t('storage.audit.filters.accessorIdPlaceholder')}
            onChange={(e) => setDraft((d) => ({ ...d, accessorId: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyDraft();
            }}
          />
        </Field>
      </div>

      {/* Path + search-term patterns */}
      <div style={{ ...settingsRow, gap: 10, flexWrap: 'wrap', border: 'none', padding: 0 }}>
        <Field
          label={t('storage.audit.filters.path')}
          rowStyle={{ ...settingsRow, gap: 6, padding: 0, border: 'none' }}
        >
          <input
            style={{ ...settingsInput, width: 200 }}
            value={draft.pathPattern}
            placeholder={t('storage.audit.filters.pathPlaceholder')}
            onChange={(e) => setDraft((d) => ({ ...d, pathPattern: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyDraft();
            }}
          />
        </Field>
        <Field
          label={t('storage.audit.filters.query')}
          rowStyle={{ ...settingsRow, gap: 6, padding: 0, border: 'none' }}
        >
          <input
            style={{ ...settingsInput, width: 200 }}
            value={draft.queryPattern}
            placeholder={t('storage.audit.filters.queryPlaceholder')}
            onChange={(e) => setDraft((d) => ({ ...d, queryPattern: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyDraft();
            }}
          />
        </Field>
      </div>

      {/* Date range + group toggle + refresh */}
      <div style={{ ...settingsRow, gap: 10, flexWrap: 'wrap', border: 'none', padding: 0 }}>
        <Field label={t('storage.audit.filters.since')} rowStyle={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input
            type="date"
            style={settingsInput}
            value={draft.since}
            onChange={(e) => setDraft((d) => ({ ...d, since: e.target.value }))}
          />
        </Field>
        <Field label={t('storage.audit.filters.until')} rowStyle={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input
            type="date"
            style={settingsInput}
            value={draft.until}
            onChange={(e) => setDraft((d) => ({ ...d, until: e.target.value }))}
          />
        </Field>
        <div style={{ alignSelf: 'flex-end' }}>
          <CheckboxField
            checked={filters.groupSequential}
            onChange={(next) => commitFilters({ groupSequential: next })}
            label={t('storage.audit.filters.group')}
          />
        </div>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          style={settingsTinyButton}
          onClick={applyDraft}
          disabled={!client || loading}
        >
          {t('storage.collections.refresh')}
        </button>
      </div>

      {!ready ? <p style={settingsMuted}>{t('storage.collections.loading')}</p> : null}

      {ready && !client ? (
        <p style={settingsMuted}>{t('storage.collections.signedOut')}</p>
      ) : null}

      {revokeNotice ? <p style={{ ...settingsMuted, color: '#4ade80' }}>{revokeNotice}</p> : null}

      {/* Failed state: never rendered as the empty state. */}
      {error ? (
        <div>
          <p style={{ ...settingsMuted, color: '#f0a4a4' }}>
            {t('storage.collections.error', { error })}
          </p>
          <button type="button" style={smallButton} onClick={retry} disabled={loading}>
            {t('storage.browse.retry')}
          </button>
        </div>
      ) : null}

      {client && loading && !rows.length && !error ? (
        <p style={settingsMuted}>{t('storage.collections.loading')}</p>
      ) : null}

      {client && !loading && !error && !rows.length ? (
        <p style={settingsMuted}>{t('storage.audit.empty')}</p>
      ) : null}

      {rows.length ? (
        <>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>{t('storage.audit.col.when')}</th>
                <th style={thStyle}>{t('storage.audit.filters.direction')}</th>
                <th style={thStyle}>{t('storage.audit.filters.accessor')}</th>
                <th style={thStyle}>{t('storage.workspaces.title')}</th>
                <th style={thStyle}>{t('storage.audit.col.file')}</th>
                <th style={thStyle} />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const accessor = resolveAccessorDisplay(row);
                const grouped = auditRowCount(row) > 1 || auditRowTouchedFileCount(row) > 0;
                return (
                  <tr key={row.id}>
                    <td style={tdStyle}>{formatWhen(row.timestamp)}</td>
                    <td style={tdStyle}>
                      <div>{row.operation || '—'}</div>
                      {row.operationClass ? (
                        <div style={{ color: '#6b7784' }}>{t(DIRECTION_KEY[row.operationClass])}</div>
                      ) : null}
                    </td>
                    <td style={tdStyle}>
                      {accessor.unattributed ? (
                        <span style={{ color: '#e6c07b' }}>{t('storage.audit.accessor.unattributed')}</span>
                      ) : (
                        <>
                          <div>{accessor.label ?? t(ACCESSOR_KEY[accessor.kind])}</div>
                          {accessor.id ? <div style={{ color: '#6b7784' }}>{accessor.id}</div> : null}
                        </>
                      )}
                    </td>
                    <td style={tdStyle}>{row.workspaceId ? shortenId(row.workspaceId) : '—'}</td>
                    <td style={tdStyle}>
                      <div>{row.path ?? (row.fileId ? shortenId(row.fileId) : '—')}</div>
                      {row.query ? (
                        <div style={{ color: '#6b7784' }}>
                          “{row.query}”
                        </div>
                      ) : null}
                      {grouped ? (
                        <div style={{ color: '#6b7784' }}>
                          {t('storage.audit.grouped', { count: auditRowCount(row) })}
                          {auditRowTouchedFileCount(row) > 0
                            ? ` · ${t('storage.audit.groupedFiles', { count: auditRowTouchedFileCount(row) })}`
                            : ''}
                        </div>
                      ) : null}
                    </td>
                    <td style={tdStyle}>
                      {auditRowCanRevoke(row) ? (
                        <button
                          type="button"
                          style={settingsTinyButton}
                          onClick={() => {
                            setRevokeError(null);
                            setRevokeNotice(null);
                            setRevokeTarget({
                              grantKind: row.grantKind as AuditGrantKind,
                              grantId: row.grantId as string,
                            });
                          }}
                        >
                          {t('storage.audit.revoke')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {groupInfo?.grouped && groupInfo.pageLocal ? (
            <p style={settingsMuted}>{t('storage.audit.groupedNote')}</p>
          ) : null}

          <div style={{ ...settingsRow, gap: 8, marginTop: 8 }}>
            <span style={settingsMuted}>
              {t('storage.audit.count', { count: rows.length })}
            </span>
            <span style={{ flex: 1 }} />
            <button type="button" style={smallButton} onClick={goPrevious} disabled={!canGoPrevious || loading}>
              {t('storage.audit.prev')}
            </button>
            <button type="button" style={smallButton} onClick={goNext} disabled={!canGoNext || loading}>
              {t('storage.audit.next')}
            </button>
          </div>
        </>
      ) : null}

      {revokeTarget ? (
        <Modal title={t('storage.audit.revoke')} onClose={() => (revoking ? undefined : setRevokeTarget(null))}>
          <p style={{ margin: 0, fontSize: 13, color: '#cbd5e1' }}>
            {t('storage.audit.revoke.confirm', {
              kind: t(GRANT_KEY[revokeTarget.grantKind]),
            })}
          </p>
          {revokeError ? <p style={{ ...settingsMuted, color: '#f0a4a4' }}>{revokeError}</p> : null}
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              type="button"
              style={settingsButton}
              onClick={() => void confirmRevoke()}
              disabled={revoking}
            >
              {t('storage.audit.revoke')}
            </button>
            <button
              type="button"
              style={settingsGhostButton}
              data-modal-dismiss
              onClick={() => setRevokeTarget(null)}
              disabled={revoking}
            >
              {t('storage.audit.revoke.cancel')}
            </button>
          </div>
        </Modal>
      ) : null}
    </SectionCard>
  );
}
