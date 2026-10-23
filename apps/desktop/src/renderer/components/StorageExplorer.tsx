import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  bridge,
  type StorageCapabilities,
  type StorageFileRow,
  type StoragePage,
  type StorageRevisionPage,
  type StorageWorkspaceRow,
} from '../bridge.js';
import { useStorageUploads } from '../storage/use-storage-uploads.js';
import { useStorageDropZone } from '../storage/use-storage-drop-zone.js';
import { useStorageDownloads } from '../storage/use-storage-downloads.js';
import { useStoragePreview, useStorageThumbnails } from '../storage/use-storage-preview.js';
import { canThumbnail, previewKindFor } from '../../shared/storage-preview.js';
import { StoragePreview } from './StoragePreview.js';
import { UploadProgressPanel } from '../storage/UploadProgressPanel.js';

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

/** Fixed width of the right-hand detail/preview column. */
const DETAIL_COLUMN_WIDTH = 340;
/**
 * Below this explorer width the right column would squeeze the file list, so
 * the detail pane becomes an overlay that slides over the list instead of a
 * sibling column. Derived from the layout budgets: workspaces sidebar (240) +
 * a usable file list (420) + the detail column (340) ≈ 1000.
 */
const DETAIL_LAYOUT_BREAKPOINT = 1000;

/** The right column: one coherent pane holding metadata, actions and preview. */
const detailColumnStyle: CSSProperties = {
  width: DETAIL_COLUMN_WIDTH,
  flexShrink: 0,
  borderLeft: '1px solid #2a333d',
  background: '#12171c',
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
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
  const [revisionsUnsupported, setRevisionsUnsupported] = useState(false);
  const [revisionsTransportError, setRevisionsTransportError] = useState<string | null>(null);
  const [revisionsBusy, setRevisionsBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  // Multi-selection for "save many" (bounded to file ids only).
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  // The explorer's own width decides whether the right detail column can be a
  // sibling of the file list or must overlay it (see DETAIL_LAYOUT_BREAKPOINT).
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [compactLayout, setCompactLayout] = useState(false);
  // Drag-and-drop transfer: bounded-concurrency queue with real byte progress,
  // a recursive drop zone, and save/drag-out for getting files back out.
  const uploads = useStorageUploads();
  const downloads = useStorageDownloads();
  // Inline image/PDF preview for the selected file, plus small row thumbnails.
  const preview = useStoragePreview(selected);
  const items = page?.items ?? [];
  const thumbnails = useStorageThumbnails(items);

  // Track the pane width so the layout choice follows the real container, not a
  // guessed viewport (the explorer is one tab among many in the shell).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setCompactLayout(el.clientWidth > 0 && el.clientWidth < DETAIL_LAYOUT_BREAKPOINT);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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

  // A dropped path list (files and/or folders) starts a queued batch upload.
  const onDroppedPaths = useCallback(
    (paths: string[]) => {
      if (!activeWorkspaceId) return;
      void uploads.enqueuePaths(paths, { workspaceId: activeWorkspaceId, folderId: null });
    },
    [activeWorkspaceId, uploads],
  );
  const dropZone = useStorageDropZone(onDroppedPaths, { enabled: Boolean(activeWorkspaceId) && mode === 'active' });

  // When a batch drains, refresh the listing so the new files appear.
  const hadActiveUploads = useRef(false);
  useEffect(() => {
    if (uploads.snapshot.active) hadActiveUploads.current = true;
    else if (hadActiveUploads.current) {
      hadActiveUploads.current = false;
      refresh();
    }
  }, [uploads.snapshot.active, refresh]);

  const onUpload = useCallback(
    async (file: File) => {
      if (!activeWorkspaceId) return;
      // Resolve the dropped `File` to a real path (Electron 32+ API) and reuse
      // the same queue, so a picker upload gets identical progress + retry.
      let path = '';
      try {
        path = bridge.getPathForFile(file);
      } catch {
        path = '';
      }
      if (!path) {
        setError('Could not resolve a filesystem path for the selected file.');
        return;
      }
      setError(null);
      await uploads.enqueuePaths([path], { workspaceId: activeWorkspaceId, folderId: null });
      if (fileInput.current) fileInput.current.value = '';
    },
    [activeWorkspaceId, uploads],
  );

  const onDownload = useCallback(
    async (file: StorageFileRow) => {
      const outcome = await downloads.saveOne({ id: file.id, name: file.name });
      if (outcome.error) setError(outcome.error);
    },
    [downloads],
  );

  /** Save a multi-selection into one folder chosen with a native dialog. */
  const onDownloadMany = useCallback(
    async (files: StorageFileRow[]) => {
      const outcome = await downloads.saveMany(files.map((f) => ({ id: f.id, name: f.name })));
      if (outcome.error) setError(outcome.error);
      else if (outcome.saved > 0) setError(null);
    },
    [downloads],
  );

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

  const checkedFiles = useMemo(() => items.filter((f) => checkedIds.has(f.id)), [items, checkedIds]);
  const toggleChecked = useCallback((id: string) => {
    setCheckedIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const loadRevisions = useCallback(async (file: StorageFileRow) => {
    setRevisionsBusy(true);
    setError(null);
    setRevisionsTransportError(null);
    try {
      const page = await bridge.storageListRevisions(file.id, 100);
      setRevisions(page);
      // A region without the revision surface answers COMMAND_NOT_FOUND; that is
      // a deliberate unsupported state, never a raw error toast.
      setRevisionsUnsupported(page.unsupported === true);
      // A dropped/reset socket is transient: show a clear, retryable state
      // rather than the raw `RegionAuthError: read ECONNRESET` the user cannot
      // act on. The main process distinguishes this from a real command error.
      if (page.transportFailed) {
        setRevisionsTransportError(
          page.transportMessage ?? 'Connection to the region was interrupted.',
        );
      }
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
      setRevisionsUnsupported(false);
      setRevisionsTransportError(null);
      return;
    }
    void loadRevisions(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  return (
    <div
      ref={rootRef}
      style={{ ...panelStyle, position: 'relative' }}
      {...dropZone.handlers}
      data-testid="storage-explorer"
    >
      {dropZone.dragOver ? (
        <div
          data-testid="storage-drop-overlay"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(15,20,25,0.82)',
            border: '2px dashed #3f7fd6',
            borderRadius: 8,
            pointerEvents: 'none',
          }}
        >
          <span style={{ color: '#cfe0f5', fontSize: 15, fontWeight: 600 }}>
            Drop files or folders to upload
          </span>
        </div>
      ) : null}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, position: 'relative' }}>
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
            {mode === 'active' && checkedFiles.length > 0 ? (
              <button
                type="button"
                style={btnStyle}
                onClick={() => void onDownloadMany(checkedFiles)}
              >
                Save {checkedFiles.length}…
              </button>
            ) : null}
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
              <div
                key={f.id}
                draggable={mode === 'active'}
                onMouseEnter={() => downloads.warmDrag({ id: f.id, name: f.name })}
                onDragStart={(e) => downloads.onDragStart(e, { id: f.id, name: f.name })}
                onDragEnd={() => downloads.onDragEnd({ id: f.id, name: f.name })}
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
                  cursor: downloads.draggingId === f.id ? 'grabbing' : 'pointer',
                }}
              >
                {mode === 'active' ? (
                  <input
                    type="checkbox"
                    checked={checkedIds.has(f.id)}
                    onChange={() => toggleChecked(f.id)}
                    onClick={(e) => e.stopPropagation()}
                    title="Select for multi-download"
                  />
                ) : null}
                <button
                  type="button"
                  onClick={() => setSelected(f)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    flex: 1,
                    minWidth: 0,
                    background: 'transparent',
                    border: 'none',
                    color: '#e8eef4',
                    cursor: 'pointer',
                    padding: 0,
                    textAlign: 'left',
                  }}
                >
                  {mode === 'active' &&
                  thumbnails[f.id] &&
                  canThumbnail(previewKindFor(f.name, f.mimeType), f.sizeBytes) ? (
                    <img
                      src={thumbnails[f.id]}
                      alt=""
                      data-testid={`storage-thumb-${f.id}`}
                      style={{
                        width: 28,
                        height: 28,
                        flexShrink: 0,
                        objectFit: 'cover',
                        borderRadius: 4,
                        border: '1px solid #2a333d',
                        background: '#0b1015',
                      }}
                    />
                  ) : null}
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
              </div>
            ))}
          </div>
        </section>

        {/*
          Right-hand detail column: ONE coherent pane holding the selected
          file's metadata, its actions (Save… / Drag out / Rename / Trash), the
          inline image/PDF preview and the revision history. It sits *beside* the
          file list, never below it, so the preview is visible without scrolling
          past the list. Under `DETAIL_LAYOUT_BREAKPOINT` it overlays the list
          instead of squashing it to an unusable width.
        */}
        {selected ? (
          <aside
            style={{
              ...detailColumnStyle,
              ...(compactLayout
                ? { position: 'absolute', top: 0, right: 0, bottom: 0, zIndex: 15, boxShadow: '-12px 0 24px rgba(0,0,0,0.45)' }
                : {}),
            }}
            data-testid="storage-detail-column"
            data-compact={compactLayout ? 'true' : 'false'}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                padding: 10,
                borderBottom: '1px solid #2a333d',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  data-testid="storage-detail-name"
                  style={{ fontSize: 13, color: '#e8eef4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {selected.name}
                </div>
                <div style={{ fontSize: 11, color: '#6b7784', marginTop: 2, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <span>rev {selected.revisionNo ?? '—'}</span>
                  <span>{selected.status}</span>
                  <span>{formatBytes(selected.sizeBytes)}</span>
                  {selected.mimeType ? <span>{selected.mimeType}</span> : null}
                </div>
              </div>
              {compactLayout ? (
                <button
                  type="button"
                  style={btnStyle}
                  title="Close details"
                  data-testid="storage-detail-close"
                  onClick={() => setSelected(null)}
                >
                  ✕
                </button>
              ) : null}
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: 10, borderBottom: '1px solid #2a333d' }}>
              {mode === 'active' ? (
                <>
                  <button
                    type="button"
                    style={btnStyle}
                    data-testid="storage-detail-save"
                    onClick={() => void onDownload(selected)}
                  >
                    Save…
                  </button>
                  <button
                    type="button"
                    style={btnStyle}
                    title="Drag this row to copy the file to another app (Finder / Explorer / Photos)"
                    data-testid="storage-detail-drag"
                    onMouseEnter={() => downloads.warmDrag({ id: selected.id, name: selected.name })}
                    onDragStart={(e) => downloads.onDragStart(e, { id: selected.id, name: selected.name })}
                    onDragEnd={() => downloads.onDragEnd({ id: selected.id, name: selected.name })}
                    draggable
                  >
                    Drag out ⤴
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

            {mode === 'active' ? (
              <div style={{ padding: '0 10px 10px' }}>
                <StoragePreview state={preview} onRetry={preview.reload} maxHeight={260} />
              </div>
            ) : null}

            {mode === 'active' ? (
              <div style={{ borderTop: '1px solid #2a333d', padding: 10, flex: 1, overflowY: 'auto' }}>
                <div style={{ color: '#6b7784', fontSize: 11, textTransform: 'uppercase', marginBottom: 6 }}>
                  Revision history {revisionsBusy ? '· loading…' : ''}
                </div>
                {revisionsUnsupported ? (
                  <p style={{ color: '#8a97a5', fontSize: 12 }}>
                    Revision history is not available on this region.
                  </p>
                ) : null}
                {revisionsTransportError ? (
                  <div data-testid="storage-revisions-transport-error">
                    <p style={{ color: '#f2a1a1', fontSize: 12, margin: '0 0 6px' }}>
                      {revisionsTransportError}
                    </p>
                    <button
                      type="button"
                      style={btnStyle}
                      data-testid="storage-revisions-retry"
                      onClick={() => void loadRevisions(selected)}
                    >
                      Try again
                    </button>
                  </div>
                ) : null}
                {!revisionsUnsupported && !revisionsTransportError && revisions && revisions.items.length === 0 ? (
                  <p style={{ color: '#6b7784', fontSize: 12 }}>No recorded revisions yet.</p>
                ) : null}
                {(revisionsUnsupported || revisionsTransportError ? [] : revisions?.items ?? []).map((r) => (
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
                    <span style={{ fontSize: 11, color: '#6b7784', whiteSpace: 'nowrap' }}>{r.sizeBytes} B</span>
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
          </aside>
        ) : (
          <aside
            style={{
              ...detailColumnStyle,
              ...(compactLayout ? { display: 'none' } : {}),
            }}
            data-testid="storage-detail-empty"
          >
            <div style={{ padding: 16, color: '#6b7784', fontSize: 12 }}>
              <div style={{ fontSize: 13, color: '#8a97a5', marginBottom: 6 }}>No file selected</div>
              Select a file to preview it and see its revision history.
            </div>
          </aside>
        )}
      </div>

      <UploadProgressPanel
        snapshot={uploads.snapshot}
        onCancelAll={uploads.cancelAll}
        onCancelOne={uploads.cancelOne}
        onRetryOne={uploads.retryOne}
        onRetryAllFailed={uploads.retryAllFailed}
        onClearFinished={uploads.clearFinished}
      />
    </div>
  );
}
