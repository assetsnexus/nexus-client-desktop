import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  bridge,
  type StorageCapabilities,
  type StorageFileRow,
  type StoragePage,
  type StorageRevisionPage,
  type StorageWorkspaceRow,
} from '../bridge.js';

const panelStyle: CSSProperties = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  background: '#0f1419',
};

const sidebarStyle: CSSProperties = {
  width: 240,
  flexShrink: 0,
  borderRight: '1px solid #2a333d',
  background: '#12171c',
  overflowY: 'auto',
  padding: 8,
};

const btnStyle: CSSProperties = {
  padding: '6px 12px',
  borderRadius: 8,
  border: '1px solid #3a4654',
  background: '#1c2430',
  color: '#e8eef4',
  cursor: 'pointer',
  fontSize: 13,
};

function formatBytes(n: number): string {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / 1024 ** i;
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

type ViewMode = 'active' | 'trash';

/**
 * Storage bucket explorer (Phase 2).
 *
 * Browses the signed-in user's Nexus storage workspaces via the main-process
 * `@nexus/storage-browser` adapter. All byte transfer goes through the
 * capability fallbacks in that package; the renderer only reads/sends base64
 * through the IPC bridge.
 */
export function StorageExplorer() {
  const [workspaces, setWorkspaces] = useState<StorageWorkspaceRow[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [page, setPage] = useState<StoragePage | null>(null);
  const [caps, setCaps] = useState<StorageCapabilities | null>(null);
  const [mode, setMode] = useState<ViewMode>('active');
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<StorageFileRow | null>(null);
  const [revisions, setRevisions] = useState<StorageRevisionPage | null>(null);
  const [revisionsBusy, setRevisionsBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const loadWorkspaces = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const rows = await bridge.storageWorkspaces();
      setWorkspaces(rows);
      setActiveWorkspaceId((cur) => cur ?? rows[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to list workspaces');
    } finally {
      setBusy(false);
    }
  }, []);

  const loadFiles = useCallback(
    async (workspaceId: string, view: ViewMode, query: string) => {
      setBusy(true);
      setError(null);
      try {
        const next = await bridge.storageListFiles({
          workspaceId,
          search: query || undefined,
          status: view === 'trash' ? 'deleted' : undefined,
          limit: 50,
        });
        setPage(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed to list files');
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  useEffect(() => {
    void bridge.storageCapabilities('workspace').then(setCaps).catch(() => setCaps(null));
  }, []);

  useEffect(() => {
    if (activeWorkspaceId) void loadFiles(activeWorkspaceId, mode, search);
  }, [activeWorkspaceId, mode, search, loadFiles]);

  const refresh = useCallback(() => {
    if (activeWorkspaceId) void loadFiles(activeWorkspaceId, mode, search);
  }, [activeWorkspaceId, mode, search, loadFiles]);

  const onUpload = useCallback(
    async (file: File) => {
      if (!file || !activeWorkspaceId) return;
      setBusy(true);
      setError(null);
      try {
        const buffer = await file.arrayBuffer();
        const base64Data = bytesToBase64(new Uint8Array(buffer));
        await bridge.storageUpload({
          workspaceId: activeWorkspaceId,
          name: file.name,
          contentType: file.type || 'application/octet-stream',
          base64Data,
        });
        refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'upload failed');
      } finally {
        setBusy(false);
        if (fileInput.current) fileInput.current.value = '';
      }
    },
    [activeWorkspaceId, refresh],
  );

  const onDownload = useCallback(async (file: StorageFileRow) => {
    try {
      const { url } = await bridge.storageDownloadUrl(file.id);
      await bridge.openExternal(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'download failed');
    }
  }, []);

  const onTrash = useCallback(
    async (file: StorageFileRow) => {
      try {
        await bridge.storageTrashFile(file.id);
        setSelected(null);
        refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'trash failed');
      }
    },
    [refresh],
  );

  const onRestore = useCallback(
    async (file: StorageFileRow) => {
      try {
        await bridge.storageRestoreFile(file.id);
        setSelected(null);
        refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'restore failed');
      }
    },
    [refresh],
  );

  const onRename = useCallback(
    async (file: StorageFileRow) => {
      const next = window.prompt('New name', file.name);
      if (!next || next === file.name) return;
      try {
        await bridge.storageRenameFile(file.id, next);
        refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'rename failed');
      }
    },
    [refresh],
  );

  const items = useMemo(() => page?.items ?? [], [page]);

  const loadRevisions = useCallback(async (file: StorageFileRow) => {
    setRevisionsBusy(true);
    setError(null);
    try {
      setRevisions(await bridge.storageListRevisions(file.id, 100));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load revisions');
      setRevisions(null);
    } finally {
      setRevisionsBusy(false);
    }
  }, []);

  const onRevert = useCallback(
    async (file: StorageFileRow, revisionNo: number) => {
      if (!window.confirm(`Revert "${file.name}" to revision ${revisionNo}? This writes a new revision.`)) return;
      try {
        await bridge.storageRevertRevision(file.id, revisionNo);
        await loadRevisions(file);
        refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'revert failed');
      }
    },
    [loadRevisions, refresh],
  );

  // Load revision history whenever the selected file changes.
  useEffect(() => {
    if (!selected) {
      setRevisions(null);
      return;
    }
    void loadRevisions(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  return (
    <div style={panelStyle}>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <aside style={sidebarStyle}>
          <div style={{ color: '#6b7784', fontSize: 11, padding: '6px 6px', textTransform: 'uppercase' }}>
            Workspaces
          </div>
          {workspaces.length === 0 && !busy ? (
            <p style={{ color: '#6b7784', fontSize: 12, padding: 6 }}>No storage workspaces.</p>
          ) : null}
          {workspaces.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => setActiveWorkspaceId(w.id)}
              style={{
                ...btnStyle,
                display: 'block',
                width: '100%',
                textAlign: 'left',
                marginBottom: 4,
                background: w.id === activeWorkspaceId ? '#243244' : '#1c2430',
                borderColor: w.id === activeWorkspaceId ? '#3f7fd6' : '#3a4654',
              }}
            >
              {w.name}
            </button>
          ))}
          <div style={{ marginTop: 12, borderTop: '1px solid #2a333d', paddingTop: 8 }}>
            <button
              type="button"
              style={{ ...btnStyle, width: '100%', marginBottom: 4 }}
              onClick={() => setMode('active')}
            >
              Files
            </button>
            <button type="button" style={{ ...btnStyle, width: '100%' }} onClick={() => setMode('trash')}>
              Trash
            </button>
          </div>
        </aside>

        <section style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: 10,
              borderBottom: '1px solid #2a333d',
            }}
          >
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search files…"
              style={{
                flex: 1,
                padding: '7px 10px',
                borderRadius: 8,
                border: '1px solid #3a4654',
                background: '#0b1015',
                color: '#e8eef4',
              }}
            />
            {mode === 'active' ? (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void onUpload(file);
                  }}
                />
                <button
                  type="button"
                  style={btnStyle}
                  disabled={!activeWorkspaceId || busy}
                  onClick={() => fileInput.current?.click()}
                >
                  Upload
                </button>
              </>
            ) : null}
            <button type="button" style={btnStyle} onClick={refresh} disabled={busy}>
              Refresh
            </button>
          </div>

          {caps ? (
            <div style={{ padding: '6px 12px', color: '#6b7784', fontSize: 11 }}>
              backend {caps.presignPut ? 'presign+PUT' : 'base64'} · {caps.presignGet ? 'sign GET' : 'proxy GET'}
              {caps.shareLinks ? ' · share links' : ''}
            </div>
          ) : null}

          {error ? <p style={{ padding: '0 12px', color: '#f2a1a1', fontSize: 12 }}>{error}</p> : null}

          <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
            {items.length === 0 ? (
              <p style={{ color: '#6b7784', padding: 12 }}>
                {busy ? 'Loading…' : mode === 'trash' ? 'Trash is empty.' : 'No files yet.'}
              </p>
            ) : null}
            {items.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setSelected(f)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 10px',
                  marginBottom: 4,
                  borderRadius: 8,
                  border: '1px solid transparent',
                  background: selected?.id === f.id ? '#1c2733' : 'transparent',
                  color: '#e8eef4',
                  cursor: 'pointer',
                }}
              >
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {f.name}
                </span>
                {f.encryptionTier && f.encryptionTier !== 'none' ? (
                  <span style={{ fontSize: 10, color: '#8fbf7f' }}>🔒 {f.encryptionTier}</span>
                ) : null}
                <span style={{ fontSize: 11, color: '#6b7784', width: 70, textAlign: 'right' }}>
                  {formatBytes(f.sizeBytes)}
                </span>
              </button>
            ))}
          </div>

          {selected ? (
            <div
              style={{
                borderTop: '1px solid #2a333d',
                padding: 10,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
              }}
            >
              <span style={{ fontSize: 12, color: '#9aa7b5', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {selected.name} · rev {selected.revisionNo ?? '—'} · {selected.status}
              </span>
              {mode === 'active' ? (
                <>
                  <button type="button" style={btnStyle} onClick={() => void onDownload(selected)}>
                    Download
                  </button>
                  <button type="button" style={btnStyle} onClick={() => void onRename(selected)}>
                    Rename
                  </button>
                  <button type="button" style={btnStyle} onClick={() => void onTrash(selected)}>
                    Trash
                  </button>
                </>
              ) : (
                <button type="button" style={btnStyle} onClick={() => void onRestore(selected)}>
                  Restore
                </button>
              )}
            </div>
          ) : null}

          {selected && mode === 'active' ? (
            <div style={{ borderTop: '1px solid #2a333d', padding: 10, maxHeight: 220, overflow: 'auto' }}>
              <div style={{ color: '#6b7784', fontSize: 11, textTransform: 'uppercase', marginBottom: 6 }}>
                Revision history {revisionsBusy ? '· loading…' : ''}
              </div>
              {revisions && revisions.items.length === 0 ? (
                <p style={{ color: '#6b7784', fontSize: 12 }}>No recorded revisions yet.</p>
              ) : null}
              {(revisions?.items ?? []).map((r) => (
                <div
                  key={r.revisionNo}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '4px 0',
                    borderBottom: '1px solid #1e252d',
                  }}
                >
                  <span style={{ fontSize: 12, color: '#c7d2de', width: 52 }}>rev {r.revisionNo}</span>
                  <span style={{ fontSize: 11, color: '#8a97a5', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {r.command}
                    {r.reason ? ` · ${r.reason}` : ''}
                  </span>
                  <span style={{ fontSize: 11, color: '#6b7784', whiteSpace: 'nowrap' }}>
                    {r.sizeBytes} B
                  </span>
                  {r.revisionNo === revisions?.currentRevisionNo ? (
                    <span style={{ fontSize: 11, color: '#8fd08f' }}>current</span>
                  ) : (
                    <button type="button" style={btnStyle} onClick={() => void onRevert(selected, r.revisionNo)}>
                      Restore
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
