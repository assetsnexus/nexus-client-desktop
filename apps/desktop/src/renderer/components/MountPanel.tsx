import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import {
  bridge,
  type MountSessionInput,
  type MountSessionRow,
  type MountSnapshot,
  type StorageRemoteFolderRow,
  type StorageWorkspaceRow,
} from '../bridge.js';

const wrap: CSSProperties = { height: '100%', overflow: 'auto', background: '#0f1419', padding: 14 };
const head: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 };
const card: CSSProperties = {
  border: '1px solid #2a333d',
  borderRadius: 10,
  padding: 12,
  marginBottom: 10,
  background: '#12171c',
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
};
const label: CSSProperties = { color: '#9aa7b5', fontSize: 11, display: 'block', marginBottom: 3 };
const muted: CSSProperties = { color: '#8a97a5', fontSize: 11 };

export function MountPanel() {
  const [snap, setSnap] = useState<MountSnapshot | null>(null);
  const [workspaces, setWorkspaces] = useState<StorageWorkspaceRow[]>([]);
  const [folders, setFolders] = useState<StorageRemoteFolderRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [workspaceId, setWorkspaceId] = useState('');
  const [remoteFolderId, setRemoteFolderId] = useState('');
  const [mountpoint, setMountpoint] = useState('');
  const [mode, setMode] = useState<'read-only' | 'read-write'>('read-only');
  const [volumeName, setVolumeName] = useState('Nexus');

  const refresh = useCallback(async () => {
    const next = await bridge.mountSnapshot();
    setSnap(next);
  }, []);

  useEffect(() => {
    void refresh();
    void (async () => {
      try {
        const rows = await bridge.storageWorkspaces();
        setWorkspaces(rows);
        if (rows.length && !workspaceId) setWorkspaceId(rows[0].id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  useEffect(() => {
    if (!workspaceId) return;
    void (async () => {
      try {
        setFolders(await bridge.syncListRemoteFolders(workspaceId));
      } catch {
        setFolders([]);
      }
    })();
  }, [workspaceId]);

  const guard = useCallback(
    async (fn: () => Promise<MountSnapshot>) => {
      setBusy(true);
      setError(null);
      try {
        setSnap(await fn());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const add = useCallback(() => {
    if (!workspaceId || !mountpoint.trim()) return;
    const folder = folders.find((f) => f.id === remoteFolderId);
    const payload: MountSessionInput = {
      workspaceId,
      remoteFolderId: remoteFolderId || null,
      remoteFolderPath: folder?.path ?? '/',
      mountpoint: mountpoint.trim(),
      mode,
      volumeName: volumeName.trim() || 'Nexus',
    };
    void guard(() => bridge.mountAddSession(payload)).then(() => setMountpoint(''));
  }, [workspaceId, remoteFolderId, folders, mountpoint, mode, volumeName, guard]);

  const pickMountpoint = useCallback(async () => {
    const dir = await bridge.mountChooseMountpoint();
    if (dir) setMountpoint(dir);
  }, []);

  const caps = snap?.capabilities;

  return (
    <div style={wrap}>
      <div style={head}>
        <strong style={{ color: '#e8eef4', fontSize: 14 }}>Bucket mounts</strong>
        <span style={muted}>
          {caps ? `${caps.driver} · ${caps.delivery}${caps.helperPresent ? '' : ' (helper missing)'}` : 'loading…'}
        </span>
        <button style={btn} onClick={() => void refresh()} disabled={busy}>
          Refresh
        </button>
      </div>

      {caps && caps.warnings.length > 0 && (
        <div style={{ ...card, borderColor: '#6b5a2a', background: '#1a1710' }}>
          <div style={{ color: '#e0c58a', fontSize: 12 }}>{caps.warnings.join(' · ')}</div>
          <div style={muted}>
            Native {caps.driver} isn’t installed, so buckets are served by the mirror daemon. Install the
            Nexus mount helper to get a kernel mount.
          </div>
        </div>
      )}

      <div style={card}>
        <div style={{ color: '#e8eef4', fontSize: 12, marginBottom: 8 }}>New mount</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <label style={label}>Workspace</label>
            <select
              style={input}
              value={workspaceId}
              onChange={(e) => {
                setWorkspaceId(e.target.value);
                setRemoteFolderId('');
              }}
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={label}>Sub-directory</label>
            <select style={input} value={remoteFolderId} onChange={(e) => setRemoteFolderId(e.target.value)}>
              <option value="">(bucket root)</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.path}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={label}>Mountpoint</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input style={input} value={mountpoint} onChange={(e) => setMountpoint(e.target.value)} placeholder="/home/you/Nexus/clients" />
              <button style={btn} onClick={() => void pickMountpoint()}>
                …
              </button>
            </div>
          </div>
          <div>
            <label style={label}>Mode</label>
            <select style={input} value={mode} onChange={(e) => setMode(e.target.value as 'read-only' | 'read-write')}>
              <option value="read-only">read-only</option>
              <option value="read-write">read-write</option>
            </select>
          </div>
          <div>
            <label style={label}>Volume name</label>
            <input style={input} value={volumeName} onChange={(e) => setVolumeName(e.target.value)} />
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <button style={btnPrimary} onClick={add} disabled={busy || !workspaceId || !mountpoint.trim()}>
              Add mount
            </button>
          </div>
        </div>
      </div>

      {error && <div style={{ ...card, borderColor: '#6b2a2a', color: '#f0a0a0' }}>{error}</div>}

      {(snap?.sessions ?? []).map((s) => (
        <SessionCard key={s.id} session={s} busy={busy} guard={guard} />
      ))}

      {snap && snap.sessions.length === 0 && <div style={{ ...card, ...muted }}>No mounts yet.</div>}
    </div>
  );
}

function SessionCard({
  session,
  busy,
  guard,
}: {
  session: MountSessionRow;
  busy: boolean;
  guard: (fn: () => Promise<MountSnapshot>) => Promise<void>;
}) {
  const mounted = session.state === 'mounted';
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <strong style={{ color: '#e8eef4', fontSize: 13 }}>{session.remoteFolderPath}</strong>
        <span style={{ ...muted }}>{session.workspaceName ?? session.workspaceId}</span>
        <span
          style={{
            ...muted,
            color: session.state === 'error' ? '#f0a0a0' : mounted ? '#8fd08f' : '#c9b07a',
            marginLeft: 'auto',
          }}
        >
          {session.state} · {session.delivery} · {session.mode}
        </span>
      </div>
      <div style={{ ...muted, marginTop: 4, wordBreak: 'break-all' }}>
        {session.mountpoint}
      </div>
      {session.error && <div style={{ color: '#e0c58a', fontSize: 11, marginTop: 4 }}>{session.error}</div>}
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        {mounted ? (
          <button style={btn} disabled={busy} onClick={() => void guard(() => bridge.mountStopSession(session.id))}>
            Unmount
          </button>
        ) : (
          <button style={btnPrimary} disabled={busy} onClick={() => void guard(() => bridge.mountStartSession(session.id))}>
            Mount
          </button>
        )}
        <button style={btn} disabled={busy} onClick={() => void guard(() => bridge.mountRemoveSession(session.id))}>
          Remove
        </button>
      </div>
    </div>
  );
}
