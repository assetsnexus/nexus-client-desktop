import { useCallback, useEffect, useState, type CSSProperties } from 'react';
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
} from '../bridge.js';

const wrap: CSSProperties = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  background: '#0f1419',
};

const head: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 14px',
  borderBottom: '1px solid #2a333d',
  background: '#12171c',
  flexShrink: 0,
};

const btn: CSSProperties = {
  padding: '5px 10px',
  borderRadius: 8,
  border: '1px solid #3a4654',
  background: '#1c2430',
  color: '#e8eef4',
  cursor: 'pointer',
  fontSize: 12,
};

const btnPrimary: CSSProperties = { ...btn, background: '#243244', borderColor: '#3f7fd6' };

const input: CSSProperties = {
  padding: '6px 9px',
  borderRadius: 8,
  border: '1px solid #3a4654',
  background: '#0b1015',
  color: '#e8eef4',
  fontSize: 12,
  width: '100%',
};

const label: CSSProperties = { color: '#9aa7b5', fontSize: 11, marginBottom: 2, display: 'block' };

const card: CSSProperties = {
  border: '1px solid #2a333d',
  borderRadius: 10,
  padding: 12,
  marginBottom: 10,
  background: '#12171c',
};

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

function runLabel(run: StorageSyncRunResult | undefined): string {
  if (!run) return 'never run';
  if (run.status === 'running') return 'running…';
  if (run.status === 'error') return `error: ${run.error ?? 'unknown'}`;
  const s = run.summary ?? {};
  const parts = Object.entries(s)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`);
  return parts.length ? parts.join(', ') : 'up to date';
}

/**
 * Sync panel (Phase 3).
 *
 * Links Nexus storage **bucket sub-directories** to **local directories** and
 * manages multiple syncs at once: create a binding (workspace + sub-dir + local
 * dir + mode/conflict/interval), run it now, run all, enable/pause, or remove.
 * The heavy lifting (reconcile + IO) lives in the main process.
 */
export function SyncPanel() {
  const [state, setState] = useState<StorageSyncState | null>(null);
  const [workspaces, setWorkspaces] = useState<StorageWorkspaceRow[]>([]);
  const [remoteFolders, setRemoteFolders] = useState<StorageRemoteFolderRow[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft(''));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      .syncListRemoteFolders(draft.workspaceId)
      .then(setRemoteFolders)
      .catch(() => setRemoteFolders([]));
  }, [draft.workspaceId]);

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
      };
      setState(await bridge.syncAddBinding(input));
      setDraft(emptyDraft(draft.workspaceId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to add sync');
    } finally {
      setBusy(false);
    }
  }, [draft]);

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
    <div style={wrap}>
      <div style={head}>
        <strong style={{ fontSize: 13 }}>Directory sync</strong>
        <span style={{ color: '#6b7784', fontSize: 11 }}>
          {bindings.length} link{bindings.length === 1 ? '' : 's'} ·{' '}
          {state?.schedulerRunning ? 'scheduler running' : 'scheduler stopped'}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" style={btn} onClick={refresh} disabled={busy}>
          Refresh
        </button>
        <button type="button" style={btnPrimary} onClick={() => void runAll()} disabled={busy || !bindings.length}>
          Sync all
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
        {error ? <p style={{ color: '#f2a1a1', fontSize: 12 }}>{error}</p> : null}

        <div style={{ ...card, background: '#0b1015' }}>
          <strong style={{ fontSize: 12 }}>Link a bucket sub-directory to a local directory</strong>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
            <div>
              <span style={label}>Name (optional)</span>
              <input
                style={input}
                value={draft.name}
                placeholder="Clients folder"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </div>
            <div>
              <span style={label}>Bucket / workspace</span>
              <select
                style={input}
                value={draft.workspaceId}
                onChange={(e) => setDraft({ ...draft, workspaceId: e.target.value, remoteFolderPath: '/' })}
              >
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <span style={label}>Bucket sub-directory</span>
              <select
                style={input}
                value={draft.remoteFolderPath}
                onChange={(e) => setDraft({ ...draft, remoteFolderPath: e.target.value })}
              >
                <option value="/">/ (bucket root)</option>
                {remoteFolders.map((f) => (
                  <option key={f.id} value={f.path}>
                    {f.path}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <span style={label}>Local directory</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  style={input}
                  value={draft.localDir}
                  placeholder="/home/me/nexus/clients"
                  onChange={(e) => setDraft({ ...draft, localDir: e.target.value })}
                />
                <button type="button" style={btn} onClick={() => void chooseLocalDir()}>
                  Browse…
                </button>
              </div>
            </div>
            <div>
              <span style={label}>Direction</span>
              <select
                style={input}
                value={draft.mode}
                onChange={(e) => setDraft({ ...draft, mode: e.target.value as StorageSyncMode })}
              >
                {MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <span style={label}>Conflict policy</span>
              <select
                style={input}
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
            </div>
            <div>
              <span style={label}>Interval (seconds, 0 = manual)</span>
              <input
                style={input}
                type="number"
                min={0}
                value={draft.intervalSeconds}
                onChange={(e) => setDraft({ ...draft, intervalSeconds: Number(e.target.value) })}
              />
            </div>
            <div>
              <span style={label}>Exclude (comma-separated)</span>
              <input
                style={input}
                value={draft.exclude}
                placeholder="node_modules, .git"
                onChange={(e) => setDraft({ ...draft, exclude: e.target.value })}
              />
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            <button
              type="button"
              style={btnPrimary}
              onClick={() => void onAdd()}
              disabled={busy || !draft.workspaceId || !draft.localDir}
            >
              Add sync
            </button>
          </div>
        </div>

        {bindings.length === 0 ? (
          <p style={{ color: '#6b7784', fontSize: 12 }}>No syncs yet. Link a bucket sub-directory above.</p>
        ) : null}

        {bindings.map((b) => (
          <BindingCard
            key={b.id}
            binding={b}
            run={state?.lastRuns[b.id]}
            busy={busy}
            onPatch={patch}
            onRemove={remove}
            onRunNow={runNow}
          />
        ))}
      </div>
    </div>
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
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ fontSize: 13 }}>{binding.name}</strong>
        <span style={{ color: '#6b7784', fontSize: 11 }}>
          {binding.workspaceName ?? binding.workspaceId}
          {binding.remoteFolderPath} → {binding.localDir}
        </span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            fontSize: 11,
            color: run?.status === 'error' ? '#f2a1a1' : run?.status === 'running' ? '#e6c07b' : '#8fbf7f',
          }}
        >
          {runLabel(run)}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <select
          style={{ ...input, width: 'auto' }}
          value={binding.mode}
          disabled={busy}
          onChange={(e) => void onPatch(binding.id, { mode: e.target.value as StorageSyncMode })}
        >
          {MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <select
          style={{ ...input, width: 'auto' }}
          value={binding.conflictPolicy}
          disabled={busy}
          onChange={(e) =>
            void onPatch(binding.id, { conflictPolicy: e.target.value as StorageSyncConflictPolicy })
          }
        >
          {POLICIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <span style={{ color: '#6b7784', fontSize: 11 }}>
          {binding.intervalSeconds > 0 ? `every ${binding.intervalSeconds}s` : 'manual'}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          style={btn}
          disabled={busy}
          onClick={() => void onPatch(binding.id, { enabled: !binding.enabled })}
        >
          {binding.enabled ? 'Pause' : 'Resume'}
        </button>
        <button type="button" style={btn} disabled={busy} onClick={() => void onRunNow(binding.id)}>
          Sync now
        </button>
        <button type="button" style={btn} disabled={busy} onClick={() => void onRemove(binding.id)}>
          Remove
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
    </div>
  );
}
