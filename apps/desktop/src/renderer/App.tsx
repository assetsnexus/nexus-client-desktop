import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { bridge, type AuthState, type DesktopConnectionConfig, type SessionHydrationState } from './bridge.js';
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
import { AppLockGate } from './components/AppLockGate.js';
import { LogoutDialog } from './components/LogoutDialog.js';
import { CertTrustPrompt } from './components/CertTrustPrompt.js';
import { useI18n, type MessageKey } from './i18n/index.js';
import { WakeBottomBar } from './components/WakeBottomBar.js';
import { useWakeHost } from './wake/director-host.js';
import { useRegionEnvironment } from './sandbox/use-region-environment.js';
import { sandboxBadgeStyle } from './sandbox/badge-style.js';
import {
  SANDBOX_BADGE_DESCRIPTION,
  SANDBOX_BADGE_LABEL,
  shouldShowSandboxBadge,
} from '../shared/sandbox-environment.js';
import { lockGateVisible } from '../shared/app-lock.js';
import { resolveShellView } from '../shared/auth-view.js';
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
  /**
   * Connected region's environment (sandbox badge). Best-effort, non-blocking;
   * null while loading/unknown, and the UI fails closed (no badge) rather than
   * guessing.
   */
  const regionEnv = useRegionEnvironment();
  const [auth, setAuth] = useState<AuthState>({ status: 'signed_out' });
  const [connection, setConnection] = useState<DesktopConnectionConfig | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [view, setView] = useState<(typeof views)[number]>('chat');
  const [showIdentities, setShowIdentities] = useState(false);
  const [version, setVersion] = useState('');
  const [openRoomId, setOpenRoomId] = useState<string | null>(null);
  /**
   * Startup hydration (Deliverable 2): what the shell should show before it
   * knows whether the stored session is still good. `null` = still deciding.
   */
  const [hydration, setHydration] = useState<SessionHydrationState | null>(null);
  /** App PIN lock (Deliverable 3): set while the UI must stay behind the PIN. */
  const [locked, setLocked] = useState(false);
  const [showLogout, setShowLogout] = useState(false);
  /** Bumped to retry hydration from the offline screen. */
  const [hydrateNonce, setHydrateNonce] = useState(0);
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
    // Device removed in the portal -> region rejects every command -> the main
    // process tears down storage/sync/mounts and tells us to return to sign-in.
    const off = bridge.onSessionLost(() => {
      setShowSettings(false);
      setShowIdentities(false);
      setOpenRoomId(null);
      setView('chat');
      setLocked(false);
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
    // Deliverable 2: the companion's avatar gallery links here to map agents to
    // library models, so a request from any window opens the Settings surface.
    const offSettings = bridge.onOpenSettings(() => {
      setShowIdentities(false);
      setOpenRoomId(null);
      setShowSettings(true);
    });
    return () => {
      off();
      offNotify();
      offSettings();
    };
  }, []);

  // Session hydration (Deliverable 2). Runs at startup and whenever the user hits
  // "Retry" on the offline screen. Main already decided; we just render the view.
  useEffect(() => {
    let cancelled = false;
    setHydration(null);
    void bridge
      .hydrateSession()
      .then((state) => {
        if (cancelled) return;
        setHydration(state);
        if (state.view === 'signed_in') {
          void bridge.getAuthState().then(setAuth);
        } else {
          setAuth({ status: 'signed_out' });
        }
      })
      .catch(() => {
        if (cancelled) return;
        // A hydration crash must not dead-end: fall back to the sign-in screen.
        setHydration({
          view: 'signed_out',
          reason: 'no_session',
          message: null,
          canRetry: false,
          hasSession: false,
          token: null,
          identity: null,
        });
        setAuth({ status: 'signed_out' });
      });
    return () => {
      cancelled = true;
    };
  }, [hydrateNonce]);

  // Which surface the shell shows. Hydration is a one-shot startup snapshot, so
  // a sign-in that completes afterwards (password + 2FA, QR link, code) must win
  // over it — otherwise the OTP step succeeds but the shell bounces back to the
  // login form. See `resolveShellView` for the precedence rules.
  const shellView = resolveShellView({ auth, hydration });
  const hydrationSignedIn = shellView === 'signed_in';

  // App PIN lock (Deliverable 3): poll the pure policy ~every 15s while the app
  // is visible, and report any user input so the idle timer resets. The lock is a
  // UI gate only; it never blocks a command or a 2FA flow in main.
  useEffect(() => {
    if (!hydrationSignedIn) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await bridge.appLockEvaluate();
        if (!cancelled) setLocked(next);
      } catch {
        /* non-fatal */
      }
    };
    void tick();
    const interval = window.setInterval(() => void tick(), 15_000);
    const note = () => void bridge.appLockNoteActivity().catch(() => undefined);
    const events = ['pointerdown', 'keydown', 'wheel', 'focus'] as const;
    for (const event of events) window.addEventListener(event, note, { passive: true });
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      for (const event of events) window.removeEventListener(event, note);
    };
  }, [hydrationSignedIn]);

  const onLogout = useCallback(() => {
    setShowIdentities(false);
    setShowSettings(false);
    setShowLogout(true);
  }, []);

  const finishLogout = useCallback(() => {
    setShowLogout(false);
    setLocked(false);
    // Drop the signed-in auth state *before* the re-hydrate: a stale
    // `status: 'signed_in'` would otherwise win over the fresh hydration
    // snapshot and briefly render the shell with a token that was just revoked.
    setAuth({ status: 'signed_out' });
    setHydration(null);
    setHydrateNonce((n) => n + 1);
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

  // `auth.status` is re-checked (rather than only read through `shellView`) so
  // TypeScript narrows `auth` to the signed-in variant for the panels below.
  const signedIn = shellView === 'signed_in' && auth.status === 'signed_in';

  // Sandbox badge in the signed-in chrome. The region answer is authoritative;
  // unknown/null fails closed (no badge), so a production instance is never
  // mislabelled.
  const isSandbox = shouldShowSandboxBadge({ regionEnvironment: regionEnv, buildEnvironment: null });

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
        {signedIn && isSandbox ? (
          <span
            style={sandboxBadgeStyle}
            title={SANDBOX_BADGE_DESCRIPTION}
            aria-label={SANDBOX_BADGE_LABEL}
          >
            {SANDBOX_BADGE_LABEL}
          </span>
        ) : null}
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
        {shellView === 'starting' ? (
          <p style={{ padding: 24, color: '#9aa7b5' }}>{t('shell.starting')}</p>
        ) : shellView === 'offline_retry' ? (
          <div style={{ padding: 24, maxWidth: 460, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <strong style={{ fontSize: 16 }}>{t('shell.offline.title')}</strong>
            <p style={{ margin: 0, color: '#9aa7b5', fontSize: 13 }}>
              {hydration?.message ?? t('shell.offline.message')}
            </p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" style={btnStyle} onClick={() => setHydrateNonce((n) => n + 1)}>
                {t('shell.offline.retry')}
              </button>
              <button
                type="button"
                style={btnStyle}
                onClick={() => {
                  // Give up on the stored session: run the keep-data logout so the
                  // user can sign in as someone else instead of being stuck.
                  void bridge
                    .logoutRun({ kind: 'switch_user', unmount: false })
                    .finally(() => finishLogout());
                }}
              >
                {t('shell.offline.signIn')}
              </button>
            </div>
          </div>
        ) : (
          <>
            {showIdentities && signedIn ? (
              <IdentitySwitcher
                baseUrl={connection?.gatewayUrl ?? connection?.regionUrl ?? null}
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
          </>
        )}
      </main>

      {signedIn ? <WakeBottomBar /> : null}

      {lockGateVisible({ locked, signedIn, recoveryOpen: showLogout }) ? (
        <AppLockGate
          onUnlocked={() => setLocked(false)}
          onRecover={() => {
            setShowLogout(true);
          }}
        />
      ) : null}

      {showLogout ? <LogoutDialog onClose={() => setShowLogout(false)} onDone={finishLogout} /> : null}

      {/* Global: a TLS connection to the region/gateway needs explicit trust. */}
      <CertTrustPrompt />
    </div>
  );
}
