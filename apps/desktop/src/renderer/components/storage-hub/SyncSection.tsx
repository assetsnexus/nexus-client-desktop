/**
 * Storage hub → Sync.
 *
 * Links Nexus storage bucket sub-directories to local directories and manages
 * multiple syncs at once. Redesigned from the old top-bar `SyncPanel`: the create
 * form and per-binding basics stay up front, while conflict policy / interval /
 * excludes live behind an Advanced disclosure.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  bridge,
  type StorageRemoteFolderRow,
  type StorageSyncBindingInput,
  type StorageSyncBindingRow,
  type StorageSyncConflictPolicy,
  type StorageSyncMode,
  type StorageSyncRunResult,
  type StorageSyncState,
  type StorageWorkspaceRow,
} from '../../bridge.js';
import { useI18n } from '../../i18n/index.js';
import {
  Field,
  SectionCard,
  settingsButton,
  settingsGhostButton,
  settingsInput,
  settingsMuted,
  settingsTinyButton,
} from '../settings/settings-ui.js';
import { workspaceOptionLabel } from './sections.js';

const MODES: StorageSyncMode[] = ['two-way', 'download-only', 'upload-only'];
const POLICIES: StorageSyncConflictPolicy[] = ['newest-wins', 'local-wins', 'remote-wins', 'keep-both'];

type Draft = {
  name: string;
  workspaceId: string;
  remoteFolderPath: string;
  localDir: string;
  mode: StorageSyncMode;
  conflictPolicy: StorageSyncConflictPolicy;
  intervalSeconds: number;
  exclude: string;
};

const emptyDraft = (workspaceId: string): Draft => ({
  name: '',
  workspaceId,
  remoteFolderPath: '/',
  localDir: '',
  mode: 'two-way',
  conflictPolicy: 'newest-wins',
  intervalSeconds: 300,
  exclude: '',
});

export function SyncSection() {
  const { t } = useI18n();
  const [state, setState] = useState<StorageSyncState | null>(null);
  const [workspaces, setWorkspaces] = useState<StorageWorkspaceRow[]>([]);
  const [remoteFolders, setRemoteFolders] = useState<StorageRemoteFolderRow[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft(''));
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Identity context that owns the draft's workspace (routes folder list + the
   * binding's own commands to the org that owns the storage). */
  const identityKey = workspaces.find((w) => w.id === draft.workspaceId)?.identityKey;

  const refresh = useCallback(async () => {
    try {
      setState(await bridge.syncGetState());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load sync state');
    }
  }, []);

  useEffect(() => {
    void refresh();
    void bridge
      .storageWorkspaces()
      .then((rows) => {
        setWorkspaces(rows);
        setDraft((d) => ({ ...d, workspaceId: d.workspaceId || rows[0]?.id || '' }));
      })
      .catch(() => setWorkspaces([]));
  }, [refresh]);

  useEffect(() => {
    if (!draft.workspaceId) {
      setRemoteFolders([]);
      return;
    }
    void bridge
      .syncListRemoteFolders(draft.workspaceId, identityKey)
      .then(setRemoteFolders)
      .catch(() => setRemoteFolders([]));
  }, [draft.workspaceId, identityKey]);

  const chooseLocalDir = useCallback(async () => {
    const dir = await bridge.syncChooseLocalDir();
    if (dir) setDraft((d) => ({ ...d, localDir: dir }));
  }, []);

  const onAdd = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const input: StorageSyncBindingInput = {
        name: draft.name || `${draft.remoteFolderPath} → ${draft.localDir}`,
        workspaceId: draft.workspaceId,
        remoteFolderPath: draft.remoteFolderPath,
        localDir: draft.localDir,
        mode: draft.mode,
        conflictPolicy: draft.conflictPolicy,
        intervalSeconds: Number(draft.intervalSeconds) || 0,
        exclude: draft.exclude
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        identityKey,
      };
      setState(await bridge.syncAddBinding(input));
      setDraft(emptyDraft(draft.workspaceId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to add sync');
    } finally {
      setBusy(false);
    }
  }, [draft, identityKey]);

  const patch = useCallback(
    async (id: string, patchInput: Partial<StorageSyncBindingInput>) => {
      setBusy(true);
      setError(null);
      try {
        setState(await bridge.syncUpdateBinding(id, patchInput));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed to update sync');
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const remove = useCallback(async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      setState(await bridge.syncRemoveBinding(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to remove sync');
    } finally {
      setBusy(false);
    }
  }, []);

  const runNow = useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        await bridge.syncRunNow(id);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'sync run failed');
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const runAll = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setState(await bridge.syncRunAll());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'sync run failed');
    } finally {
      setBusy(false);
    }
  }, []);

  const bindings = state?.bindings ?? [];

  return (
    <>
      <SectionCard
        title={t('storage.nav.sync')}
        help={t('storage.sync.header', {
          count: bindings.length,
          state: state?.schedulerRunning ? t('storage.sync.running') : t('storage.sync.stopped'),
        })}
      >
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" style={settingsGhostButton} onClick={() => void refresh()} disabled={busy}>
            {t('storage.sync.refresh')}
          </button>
          <button
            type="button"
            style={settingsButton}
            onClick={() => void runAll()}
            disabled={busy || !bindings.length}
          >
            {t('storage.sync.all')}
          </button>
        </div>

        <h3 style={{ margin: '6px 0 0', fontSize: 13 }}>{t('storage.sync.new')}</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label={t('storage.sync.name')}>
            <input
              style={settingsInput}
              value={draft.name}
              placeholder={t('storage.sync.namePlaceholder')}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </Field>
          <Field label={t('storage.sync.workspace')}>
            <select
              style={settingsInput}
              value={draft.workspaceId}
              onChange={(e) =>
                setDraft({ ...draft, workspaceId: e.target.value, remoteFolderPath: '/' })
              }
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {workspaceOptionLabel(w)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('storage.sync.folder')}>
            <select
              style={settingsInput}
              value={draft.remoteFolderPath}
              onChange={(e) => setDraft({ ...draft, remoteFolderPath: e.target.value })}
            >
              <option value="/">{t('storage.mounts.folderRoot')}</option>
              {remoteFolders.map((f) => (
                <option key={f.id} value={f.path}>
                  {f.path}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('storage.sync.localDir')}>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                style={{ ...settingsInput, flex: 1 }}
                value={draft.localDir}
                placeholder={t('storage.sync.localDirPlaceholder')}
                onChange={(e) => setDraft({ ...draft, localDir: e.target.value })}
              />
              <button type="button" style={settingsGhostButton} onClick={() => void chooseLocalDir()}>
                {t('storage.mounts.browse')}
              </button>
            </div>
          </Field>
          <Field label={t('storage.sync.mode')}>
            <select
              style={settingsInput}
              value={draft.mode}
              onChange={(e) => setDraft({ ...draft, mode: e.target.value as StorageSyncMode })}
            >
              {MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <button type="button" style={settingsGhostButton} onClick={() => setShowAdvanced((v) => !v)}>
          {showAdvanced ? '▾ ' : '▸ '}
          {t('storage.sync.advanced')}
        </button>

        {showAdvanced ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label={t('storage.sync.policy')}>
              <select
                style={settingsInput}
                value={draft.conflictPolicy}
                onChange={(e) =>
                  setDraft({ ...draft, conflictPolicy: e.target.value as StorageSyncConflictPolicy })
                }
              >
                {POLICIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('storage.sync.interval')}>
              <input
                style={settingsInput}
                type="number"
                min={0}
                value={draft.intervalSeconds}
                onChange={(e) => setDraft({ ...draft, intervalSeconds: Number(e.target.value) })}
              />
            </Field>
            <Field label={t('storage.sync.exclude')}>
              <input
                style={settingsInput}
                value={draft.exclude}
                placeholder={t('storage.sync.excludePlaceholder')}
                onChange={(e) => setDraft({ ...draft, exclude: e.target.value })}
              />
            </Field>
          </div>
        ) : null}

        <button
          type="button"
          style={settingsButton}
          onClick={() => void onAdd()}
          disabled={busy || !draft.workspaceId || !draft.localDir}
        >
          {t('storage.sync.add')}
        </button>

        {error ? <p style={{ color: '#f2a1a1', fontSize: 12, margin: 0 }}>{error}</p> : null}
      </SectionCard>

      {bindings.length === 0 ? (
        <p style={settingsMuted}>{t('storage.sync.empty')}</p>
      ) : (
        bindings.map((b) => (
          <BindingCard
            key={b.id}
            binding={b}
            run={state?.lastRuns[b.id]}
            busy={busy}
            onPatch={patch}
            onRemove={remove}
            onRunNow={runNow}
          />
        ))
      )}
    </>
  );
}

function BindingCard({
  binding,
  run,
  busy,
  onPatch,
  onRemove,
  onRunNow,
}: {
  binding: StorageSyncBindingRow;
  run: StorageSyncRunResult | undefined;
  busy: boolean;
  onPatch: (id: string, patch: Partial<StorageSyncBindingInput>) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onRunNow: (id: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const runLabel = (() => {
    if (!run) return t('storage.sync.neverRun');
    if (run.status === 'running') return t('storage.sync.runRunning');
    if (run.status === 'error')
      return t('storage.sync.runError', { error: run.error ?? 'unknown' });
    const s = run.summary ?? {};
    const parts = Object.entries(s)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${k}`);
    return parts.length ? parts.join(', ') : t('storage.sync.upToDate');
  })();

  return (
    <SectionCard title={binding.name}>
      <p style={{ margin: 0, color: '#9aa7b5', fontSize: 12 }}>
        {binding.workspaceName ?? binding.workspaceId}
        {binding.remoteFolderPath} → {binding.localDir}
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
        <span
          style={{
            fontSize: 11,
            color:
              run?.status === 'error'
                ? '#f2a1a1'
                : run?.status === 'running'
                  ? '#e6c07b'
                  : '#8fbf7f',
          }}
        >
          {runLabel}
        </span>
        <span style={settingsMuted}>{binding.mode}</span>
        <span style={settingsMuted}>
          {binding.intervalSeconds > 0
            ? t('storage.sync.every', { seconds: binding.intervalSeconds })
            : t('storage.sync.manual')}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          style={settingsTinyButton}
          disabled={busy}
          onClick={() => void onPatch(binding.id, { enabled: !binding.enabled })}
        >
          {binding.enabled ? t('storage.sync.pause') : t('storage.sync.resume')}
        </button>
        <button
          type="button"
          style={settingsTinyButton}
          disabled={busy}
          onClick={() => void onRunNow(binding.id)}
        >
          {t('storage.sync.now')}
        </button>
        <button
          type="button"
          style={settingsTinyButton}
          disabled={busy}
          onClick={() => void onRemove(binding.id)}
        >
          {t('storage.sync.remove')}
        </button>
      </div>

      {run?.conflicts?.length ? (
        <ul style={{ margin: '8px 0 0', paddingLeft: 18, color: '#e6c07b', fontSize: 11 }}>
          {run.conflicts.slice(0, 8).map((c) => (
            <li key={c.relPath}>
              {c.relPath} — {c.reason}
            </li>
          ))}
        </ul>
      ) : null}
    </SectionCard>
  );
}
