/**
 * Storage hub → Mounts.
 *
 * Projects a Nexus storage bucket (or one sub-directory) onto a local directory.
 * Redesigned from the old top-bar `MountPanel`: primary actions first, with the
 * lifetime (expires after N minutes/hours/days/weeks) and the "survive restarts"
 * switch tucked behind an Advanced disclosure so the everyday flow stays short.
 *
 * All IO lives in the main process; this section only drives the mount daemon
 * bridge.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  bridge,
  type MountExpiry,
  type MountLifetimeUnit,
  type MountSessionInput,
  type MountSessionRow,
  type MountSnapshot,
  type StorageRemoteFolderRow,
  type StorageWorkspaceRow,
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
  settingsRow,
  settingsTinyButton,
} from '../settings/settings-ui.js';
import { workspaceOptionLabel } from './sections.js';

const UNITS: MountLifetimeUnit[] = ['minutes', 'hours', 'days', 'weeks'];
const UNIT_LABEL_KEY = {
  minutes: 'storage.mounts.expires.minutes',
  hours: 'storage.mounts.expires.hours',
  days: 'storage.mounts.expires.days',
  weeks: 'storage.mounts.expires.weeks',
} as const;

const rowActions: React.CSSProperties = { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' };

function formatExpiry(expiresAt: string | null): string | null {
  if (!expiresAt) return null;
  const when = new Date(expiresAt);
  if (Number.isNaN(when.getTime())) return null;
  return when.toLocaleString();
}

export function MountsSection({
  initialWorkspaceId = null,
  initialRemoteFolderId = null,
  onPrefillConsumed,
}: {
  /**
   * Prefill handed over from the storage explorer's "Mount to system dir" action:
   * the workspace and folder the user right-clicked. The user only has to pick a
   * mount point and confirm — the mount daemon and its lifetime/restart options
   * stay here, so there is one mount flow rather than a second one in the file
   * browser.
   */
  initialWorkspaceId?: string | null;
  initialRemoteFolderId?: string | null;
  /** Called once the prefill has been applied, so a later visit starts clean. */
  onPrefillConsumed?: () => void;
} = {}) {
  const { t } = useI18n();
  const [snap, setSnap] = useState<MountSnapshot | null>(null);
  const [workspaces, setWorkspaces] = useState<StorageWorkspaceRow[]>([]);
  const [folders, setFolders] = useState<StorageRemoteFolderRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Identity context that owns the selected workspace, so a mount of an org
   * workspace reads its folders and mounts with that org's envelope. */
  const identityKey = workspaces.find((w) => w.id === workspaceId)?.identityKey;

  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId ?? '');
  const [remoteFolderId, setRemoteFolderId] = useState(initialRemoteFolderId ?? '');
  const [mountpoint, setMountpoint] = useState('');
  const [mode, setMode] = useState<'read-only' | 'read-write'>('read-only');
  const [volumeName, setVolumeName] = useState('Nexus');
  const [showAdvanced, setShowAdvanced] = useState(false);
  /** Empty string = "never"; otherwise a positive number of `expiryUnit`. */
  const [expiryValue, setExpiryValue] = useState('');
  const [expiryUnit, setExpiryUnit] = useState<MountLifetimeUnit>('hours');
  const [persist, setPersist] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSnap(await bridge.mountSnapshot());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load mounts');
    }
  }, []);

  useEffect(() => {
    void refresh();
    void (async () => {
      try {
        const rows = await bridge.storageWorkspaces();
        setWorkspaces(rows);
        if (rows.length) setWorkspaceId((id) => id || rows[0].id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [refresh]);

  useEffect(() => {
    if (!workspaceId) return;
    void (async () => {
      try {
        setFolders(await bridge.syncListRemoteFolders(workspaceId, identityKey));
      } catch {
        setFolders([]);
      }
    })();
  }, [workspaceId, identityKey]);

  /**
   * Apply a hand-off from the storage explorer ("Mount to system dir"): select
   * the workspace and folder the user right-clicked, then report the prefill as
   * consumed so returning to Mounts later starts from the default.
   */
  useEffect(() => {
    if (initialWorkspaceId) setWorkspaceId(initialWorkspaceId);
    if (initialRemoteFolderId) setRemoteFolderId(initialRemoteFolderId);
    if (initialWorkspaceId || initialRemoteFolderId) onPrefillConsumed?.();
    // Consume once per hand-off; a new hand-off arrives as new prop values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialWorkspaceId, initialRemoteFolderId]);

  const chooseMountpoint = useCallback(async () => {
    const dir = await bridge.mountChooseMountpoint();
    if (dir) setMountpoint(dir);
  }, []);

  const onAdd = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const n = Number(expiryValue);
      const expiresAfter: MountExpiry | null =
        Number.isFinite(n) && n > 0 ? { value: n, unit: expiryUnit } : null;
      const input: MountSessionInput = {
        workspaceId,
        remoteFolderId: remoteFolderId || null,
        remoteFolderPath: folders.find((f) => f.id === remoteFolderId)?.path ?? '/',
        mountpoint,
        mode,
        volumeName,
        expiresAfter,
        persistAcrossRestarts: persist,
        identityKey,
      };
      setSnap(await bridge.mountAddSession(input));
      setMountpoint('');
      setExpiryValue('');
      setPersist(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to add mount');
    } finally {
      setBusy(false);
    }
  }, [workspaceId, identityKey, remoteFolderId, folders, mountpoint, mode, volumeName, expiryValue, expiryUnit, persist]);

  const start = useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        setSnap(await bridge.mountStartSession(id));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'mount failed');
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const stop = useCallback(async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      setSnap(await bridge.mountStopSession(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unmount failed');
    } finally {
      setBusy(false);
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      setSnap(await bridge.mountRemoveSession(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'remove failed');
    } finally {
      setBusy(false);
    }
  }, []);

  const sessions = snap?.sessions ?? [];

  return (
    <>
      <SectionCard title={t('storage.nav.mounts')} help={t('storage.mounts.help')}>
        <p style={settingsMuted}>
          {t('storage.mounts.capabilities')}: {snap?.capabilities.driver ?? '—'} ·{' '}
          {snap?.capabilities.helperPresent
            ? t('storage.mounts.helper')
            : t('storage.mounts.helperMissing')}
        </p>

        <Field label={t('storage.mounts.workspace')}>
          <select
            style={settingsInput}
            value={workspaceId}
            onChange={(e) => {
              setWorkspaceId(e.target.value);
              setRemoteFolderId('');
            }}
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {workspaceOptionLabel(w)}
              </option>
            ))}
          </select>
        </Field>

        <Field label={t('storage.mounts.folder')}>
          <select
            style={settingsInput}
            value={remoteFolderId}
            onChange={(e) => setRemoteFolderId(e.target.value)}
          >
            <option value="">{t('storage.mounts.folderRoot')}</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.path}
              </option>
            ))}
          </select>
        </Field>

        <Field label={t('storage.mounts.mountpoint')}>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              style={{ ...settingsInput, flex: 1 }}
              value={mountpoint}
              placeholder="/mnt/nexus-clients"
              onChange={(e) => setMountpoint(e.target.value)}
            />
            <button type="button" style={settingsGhostButton} onClick={() => void chooseMountpoint()}>
              {t('storage.mounts.browse')}
            </button>
          </div>
        </Field>

        <Field label={t('storage.mounts.mode')}>
          <select
            style={settingsInput}
            value={mode}
            onChange={(e) => setMode(e.target.value as 'read-only' | 'read-write')}
          >
            <option value="read-only">{t('storage.mounts.mode.readOnly')}</option>
            <option value="read-write">{t('storage.mounts.mode.readWrite')}</option>
          </select>
        </Field>

        <Field label={t('storage.mounts.volumeName')}>
          <input
            style={settingsInput}
            value={volumeName}
            onChange={(e) => setVolumeName(e.target.value)}
          />
        </Field>

        <button
          type="button"
          style={settingsGhostButton}
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? '▾ ' : '▸ '}
          {t('storage.mounts.advanced')}
        </button>

        {showAdvanced ? (
          <>
            <Field label={t('storage.mounts.expires')} hint={t('storage.mounts.expires.help')}>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  style={{ ...settingsInput, width: 90 }}
                  type="number"
                  min={0}
                  placeholder={t('storage.mounts.expires.never')}
                  value={expiryValue}
                  onChange={(e) => setExpiryValue(e.target.value)}
                />
                <select
                  style={settingsInput}
                  value={expiryUnit}
                  disabled={!expiryValue}
                  onChange={(e) => setExpiryUnit(e.target.value as MountLifetimeUnit)}
                >
                  {UNITS.map((u) => (
                    <option key={u} value={u}>
                      {t(UNIT_LABEL_KEY[u])}
                    </option>
                  ))}
                </select>
              </div>
            </Field>

            <CheckboxField
              checked={persist}
              onChange={setPersist}
              label={t('storage.mounts.persist')}
              hint={t('storage.mounts.persist.help')}
            />
          </>
        ) : null}

        <button
          type="button"
          style={settingsButton}
          onClick={() => void onAdd()}
          disabled={busy || !workspaceId || !mountpoint}
        >
          {t('storage.mounts.add')}
        </button>

        {error ? <p style={{ color: '#f2a1a1', fontSize: 12, margin: 0 }}>{error}</p> : null}
      </SectionCard>

      {sessions.length === 0 ? (
        <p style={settingsMuted}>{t('storage.mounts.empty')}</p>
      ) : (
        sessions.map((s) => (
          <MountCard
            key={s.id}
            session={s}
            busy={busy}
            onStart={() => void start(s.id)}
            onStop={() => void stop(s.id)}
            onRemove={() => void remove(s.id)}
          />
        ))
      )}
    </>
  );
}

function MountCard({
  session,
  busy,
  onStart,
  onStop,
  onRemove,
}: {
  session: MountSessionRow;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const running = session.state === 'mounted' || session.state === 'degraded';
  const expiresLabel = formatExpiry(session.expiresAt);
  return (
    <SectionCard title={session.workspaceName ?? session.workspaceId}>
      <p style={{ margin: 0, color: '#9aa7b5', fontSize: 12 }}>
        {session.remoteFolderPath} → {session.mountpoint}
      </p>
      <div style={settingsRow}>
        <span style={settingsMuted}>
          {t('storage.mounts.state')}: {session.state}
        </span>
        <span style={settingsMuted}>
          {t('storage.mounts.delivery')}: {session.delivery}
        </span>
        <span style={settingsMuted}>{session.mode}</span>
        {expiresLabel ? (
          <span style={settingsMuted}>{t('storage.mounts.expiresAt', { when: expiresLabel })}</span>
        ) : null}
        {session.persistAcrossRestarts ? (
          <span style={settingsMuted}>{t('storage.mounts.persist')}</span>
        ) : null}
        <span style={{ flex: 1 }} />
      </div>
      {session.error ? (
        <p style={{ margin: '6px 0 0', color: '#f2a1a1', fontSize: 11 }}>{session.error}</p>
      ) : null}
      <div style={rowActions}>
        {running ? (
          <button type="button" style={settingsTinyButton} disabled={busy} onClick={onStop}>
            {t('storage.mounts.stop')}
          </button>
        ) : (
          <button type="button" style={settingsTinyButton} disabled={busy} onClick={onStart}>
            {t('storage.mounts.start')}
          </button>
        )}
        <button type="button" style={settingsTinyButton} disabled={busy} onClick={onRemove}>
          {t('storage.mounts.remove')}
        </button>
      </div>
    </SectionCard>
  );
}
