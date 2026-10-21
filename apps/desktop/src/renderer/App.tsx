import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { bridge, type AuthState, type DesktopConnectionConfig } from './bridge.js';
import { LoginForm } from './components/LoginForm.js';
import { ChatHost } from './components/ChatHost.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import { StorageExplorer } from './components/StorageExplorer.js';
import { IdentitySwitcher } from './components/IdentitySwitcher.js';
import { CalendarPanel } from './components/CalendarPanel.js';
import { MeetingRoomPanel } from './components/MeetingRoomPanel.js';
import { MeetingsPanel } from './components/MeetingsPanel.js';

const shellStyle: CSSProperties = {
  height: '100vh',
  display: 'flex',
  flexDirection: 'column',
  background: '#0f1419',
  color: '#e8eef4',
  fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
};

const topBarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '10px 14px',
  borderBottom: '1px solid #2a333d',
  background: '#12171c',
  flexShrink: 0,
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

/**
 * Desktop shell root: routes between login, chat, and settings. Auth + settings
 * are owned by the main process; the renderer only reads/writes via the bridge.
 */
export function App() {
  const [auth, setAuth] = useState<AuthState>({ status: 'signed_out' });
  const [connection, setConnection] = useState<DesktopConnectionConfig | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [view, setView] = useState<'chat' | 'storage' | 'calendar' | 'meetings'>('chat');
  const [showIdentities, setShowIdentities] = useState(false);
  const [version, setVersion] = useState('');
  const [openRoomId, setOpenRoomId] = useState<string | null>(null);

  useEffect(() => {
    void bridge.getVersion().then(setVersion);
    void bridge.getConnectionConfig().then(setConnection);
    void bridge.getAuthState().then(setAuth);
  }, []);

  const refreshAuth = useCallback(() => {
    void bridge.getAuthState().then(setAuth);
  }, []);

  const onLogout = useCallback(async () => {
    await bridge.logout();
    refreshAuth();
  }, [refreshAuth]);

  const signedIn = auth.status === 'signed_in';

  return (
    <div style={shellStyle}>
      <header style={topBarStyle}>
        <strong style={{ fontSize: 14 }}>Nexus</strong>
        <span style={{ color: '#6b7784', fontSize: 12 }}>v{version}</span>
        <span style={{ flex: 1 }} />
        {signedIn ? (
          <div style={{ display: 'flex', gap: 0, borderRadius: 8, overflow: 'hidden', border: '1px solid #3a4654' }}>
            {(['chat', 'storage', 'calendar', 'meetings'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => {
                  setView(tab);
                  setOpenRoomId(null);
                  setShowSettings(false);
                }}
                style={{
                  ...btnStyle,
                  border: 'none',
                  borderRadius: 0,
                  background: view === tab && !showSettings && !openRoomId ? '#243244' : '#1c2430',
                }}
              >
                {tab === 'chat'
                  ? 'Chat'
                  : tab === 'storage'
                    ? 'Storage'
                    : tab === 'calendar'
                      ? 'Calendar'
                      : 'Meetings'}
              </button>
            ))}
          </div>
        ) : null}
        {connection ? (
          <span style={{ color: '#6b7784', fontSize: 12 }} title={connection.regionUrl}>
            {new URL(connection.regionUrl).host}
          </span>
        ) : null}
        {signedIn ? (
          <button
            type="button"
            style={btnStyle}
            onClick={() => setShowIdentities((v) => !v)}
          >
            Identities
          </button>
        ) : null}
        <button type="button" style={btnStyle} onClick={() => setShowSettings((v) => !v)}>
          {showSettings ? 'Close settings' : 'Settings'}
        </button>
        {signedIn ? (
          <button type="button" style={btnStyle} onClick={onLogout}>
            Sign out
          </button>
        ) : null}
      </header>

      <main style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {showIdentities && signedIn ? (
          <IdentitySwitcher
            onClose={() => {
              setShowIdentities(false);
              refreshAuth();
            }}
          />
        ) : null}
        {showSettings && connection ? (
          <SettingsPanel
            connection={connection}
            onConnectionChange={setConnection}
            onClose={() => setShowSettings(false)}
          />
        ) : signedIn ? (
          openRoomId ? (
            <MeetingRoomPanel roomId={openRoomId} onClose={() => setOpenRoomId(null)} />
          ) : view === 'storage' ? (
            <StorageExplorer />
          ) : view === 'calendar' ? (
            <CalendarPanel />
          ) : view === 'meetings' ? (
            <MeetingsPanel onOpenRoom={setOpenRoomId} />
          ) : (
            <ChatHost auth={auth} connection={connection} />
          )
        ) : (
          <LoginForm auth={auth} onAuthChange={refreshAuth} />
        )}
      </main>
    </div>
  );
}
