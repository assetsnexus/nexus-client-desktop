import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { bridge, type AuthState, type DesktopConnectionConfig } from './bridge.js';
import { LoginForm } from './components/LoginForm.js';
import { ChatHost } from './components/ChatHost.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import { StorageExplorer } from './components/StorageExplorer.js';
import { SyncPanel } from './components/SyncPanel.js';
import { MountPanel } from './components/MountPanel.js';
import { IdentitySwitcher } from './components/IdentitySwitcher.js';
import { CalendarPanel } from './components/CalendarPanel.js';
import { MeetingRoomPanel } from './components/MeetingRoomPanel.js';
import { MeetingsPanel } from './components/MeetingsPanel.js';
import { useI18n, type MessageKey } from './i18n/index.js';
import { WakeBottomBar } from './components/WakeBottomBar.js';
import { useWakeHost } from './wake/director-host.js';
import anxLogo from './assets/anx-logo.svg';

/** Shell tabs, in display order. */
const views = ['chat', 'storage', 'sync', 'mounts', 'calendar', 'meetings'] as const;

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

/** Brand mark: the ANX Borromean-rings tile, shared with anx-app. */
const brandMark: CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 8,
  flexShrink: 0,
  display: 'block',
};

/**
 * Desktop shell root: routes between login, chat, and settings. Auth + settings
 * are owned by the main process; the renderer only reads/writes via the bridge.
 */
export function App() {
  const { t } = useI18n();
  useWakeHost();
  const [auth, setAuth] = useState<AuthState>({ status: 'signed_out' });
  const [connection, setConnection] = useState<DesktopConnectionConfig | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [view, setView] = useState<(typeof views)[number]>('chat');
  const [showIdentities, setShowIdentities] = useState(false);
  const [version, setVersion] = useState('');
  const [openRoomId, setOpenRoomId] = useState<string | null>(null);
  /**
   * The most recent wake activation. Kept here (not in `ChatHost`) so a wake that
   * fires while another tab is open still switches to chat and routes once the
   * chat host is mounted. `token` makes each activation unique even for the same
   * phrase, so a repeated wake is not swallowed as a no-op.
   */
  const [wakeActivation, setWakeActivation] = useState<{
    phrase: string;
    agentId: string | null;
    token: number;
  } | null>(null);

  useEffect(() => {
    void bridge.getVersion().then(setVersion);
    void bridge.getConnectionConfig().then(setConnection);
    void bridge.getAuthState().then(setAuth);
    // Device removed in the portal -> region rejects every command -> the main
    // process tears down storage/sync/mounts and tells us to return to sign-in.
    const off = bridge.onSessionLost(() => {
      setShowSettings(false);
      setShowIdentities(false);
      setOpenRoomId(null);
      setView('chat');
      void bridge.getAuthState().then(setAuth);
    });
    // A notification click focuses the window in main; here we surface the chat
    // tab so the message the user was told about is actually on screen.
    const offNotify = bridge.onNotificationActivated(() => {
      setShowSettings(false);
      setShowIdentities(false);
      setOpenRoomId(null);
      setView('chat');
    });
    return () => {
      off();
      offNotify();
    };
  }, []);

  // Wake words: a wake must route even when another tab (or settings) is open,
  // so the shell owns the subscription and brings chat forward, then hands the
  // activation to the chat host. Main has already raised the window.
  useEffect(() => {
    let seq = 0;
    const offWake = bridge.onWakeActivated((payload) => {
      if (!payload.agentId) return;
      setShowSettings(false);
      setShowIdentities(false);
      setOpenRoomId(null);
      setView('chat');
      setWakeActivation({ phrase: payload.phrase, agentId: payload.agentId, token: ++seq });
    });
    return () => offWake();
  }, []);

  const refreshAuth = useCallback(() => {
    void bridge.getAuthState().then(setAuth);
  }, []);

  const onLogout = useCallback(async () => {
    await bridge.logout();
    refreshAuth();
  }, [refreshAuth]);

  const signedIn = auth.status === 'signed_in';

  const tabLabels: Record<(typeof views)[number], MessageKey> = {
    chat: 'shell.tab.chat',
    storage: 'shell.tab.storage',
    sync: 'shell.tab.sync',
    mounts: 'shell.tab.mounts',
    calendar: 'shell.tab.calendar',
    meetings: 'shell.tab.meetings',
  };

  return (
    <div style={shellStyle}>
      <header style={topBarStyle}>
        <img src={anxLogo} alt="" aria-hidden style={brandMark} />
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15 }}>
          <strong style={{ fontSize: 14 }}>AssetsNexus.org</strong>
          <span style={{ color: '#6b7784', fontSize: 10 }}>v{version}</span>
        </div>
        <span style={{ flex: 1 }} />
        {signedIn ? (
          <div style={{ display: 'flex', gap: 0, borderRadius: 8, overflow: 'hidden', border: '1px solid #3a4654' }}>
            {views.map((tab) => (
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
                {t(tabLabels[tab])}
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
            {t('shell.identities')}
          </button>
        ) : null}
        <button type="button" style={btnStyle} onClick={() => setShowSettings((v) => !v)}>
          {showSettings ? t('shell.settingsClose') : t('shell.settings')}
        </button>
        {signedIn ? (
          <button type="button" style={btnStyle} onClick={onLogout}>
            {t('shell.signOut')}
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
        ) : null}        {showSettings && connection ? (
          <SettingsPanel
            connection={connection}
            onConnectionChange={setConnection}
            onClose={() => setShowSettings(false)}
          />
        ) : signedIn ? (
          openRoomId ? (
            <MeetingRoomPanel
              roomId={openRoomId}
              auth={auth}
              connection={connection}
              onClose={() => setOpenRoomId(null)}
            />
          ) : view === 'storage' ? (
            <StorageExplorer />
          ) : view === 'sync' ? (
            <SyncPanel />
          ) : view === 'mounts' ? (
            <MountPanel />
          ) : view === 'calendar' ? (
            <CalendarPanel />
          ) : view === 'meetings' ? (
            <MeetingsPanel onOpenRoom={setOpenRoomId} />
          ) : (
            <ChatHost auth={auth} connection={connection} wakeActivation={wakeActivation} />
          )
        ) : (
          <LoginForm auth={auth} connection={connection} onAuthChange={refreshAuth} />
        )}
      </main>

      {signedIn ? <WakeBottomBar /> : null}
    </div>
  );
}
