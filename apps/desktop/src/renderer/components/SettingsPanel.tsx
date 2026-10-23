import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { LocalModelsPanel } from './LocalModelsPanel.js';
import { LocalVoicePanel } from './LocalVoicePanel.js';
import { WakeSettingsPanel } from './WakeSettingsPanel.js';
import { AuditPanel } from './AuditPanel.js';
import { NexusAppsPanel } from './NexusAppsPanel.js';
import { CertTrustPanel } from './CertTrustPanel.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { LanguageSelector } from './LanguageSelector.js';
import { useI18n } from '../i18n/index.js';
import {
  bridge,
  LOCK_TIMEOUT_CHOICES,
  PIN_MIN_LENGTH,
  type AppLockSettings,
  type AppLockState,
  type AssetAgentDiscoverySnapshot,
  type CompanionDebugSettings,
  type DesktopConnectionConfig,
  type LocalCommandSkill,
  type LocalRunnerSettings,
  type LocalRunnerState,
  type NotificationSettings,
  type ToolsConfig,
  type WorkspaceRoot,
} from '../bridge.js';

const wrap: CSSProperties = {
  height: '100%',
  width: '100%',
  boxSizing: 'border-box',
  minWidth: 0,
  minHeight: 0,
  overflowY: 'auto',
  overflowX: 'hidden',
  padding: 24,
  display: 'flex',
  flexDirection: 'column',
  gap: 24,
  maxWidth: 760,
};

const section: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: 18,
  borderRadius: 12,
  background: '#151b22',
  border: '1px solid #2a333d',
};

const field: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  fontSize: 12,
  color: '#9aa7b5',
};

const input: CSSProperties = {
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid #3a4654',
  background: '#0f1419',
  color: '#e8eef4',
  fontSize: 13,
};

const button: CSSProperties = {
  alignSelf: 'flex-start',
  padding: '8px 14px',
  borderRadius: 8,
  border: '1px solid #3f6cb0',
  background: '#2f5c9e',
  color: '#fff',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
};

const row: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 0',
  borderTop: '1px solid #222b34',
};

const healthColors: Record<string, string> = {
  healthy: '#4ade80',
  available: '#4ade80',
  unreachable: '#f2a1a1',
  error: '#f2a1a1',
  disabled: '#8b95a1',
  stopped: '#8b95a1',
  checking: '#fbbf24',
  starting: '#fbbf24',
  unknown: '#8b95a1',
};

function HealthChip({ health }: { health: string }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        color: healthColors[health] ?? '#8b95a1',
        border: `1px solid ${healthColors[health] ?? '#8b95a1'}`,
        borderRadius: 999,
        padding: '2px 8px',
        textTransform: 'uppercase',
        letterSpacing: 0.4,
      }}
    >
      {health}
    </span>
  );
}

/**
 * Settings: connection targets (region/gateway/portal + custom CA) and the
 * desktop-local model health list. Local models are probed on this machine by
 * the main process — region node / inference are cloud stacks.
 */
export function SettingsPanel({
  connection,
  onConnectionChange,
  onClose,
}: {
  connection: DesktopConnectionConfig;
  onConnectionChange: (next: DesktopConnectionConfig) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [regionUrl, setRegionUrl] = useState(connection.regionUrl);
  const [gatewayUrl, setGatewayUrl] = useState(connection.gatewayUrl ?? '');
  const [portalUrl, setPortalUrl] = useState(connection.portalUrl ?? '');
  const [customCaPem, setCustomCaPem] = useState(connection.customCaPem ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [runner, setRunner] = useState<LocalRunnerState | null>(null);
  const [runnerBusy, setRunnerBusy] = useState(false);

  const [tools, setTools] = useState<ToolsConfig | null>(null);
  const [newWorkspace, setNewWorkspace] = useState('');
  const [newWorkspaceMode, setNewWorkspaceMode] = useState<WorkspaceRoot['mode']>('read-write');

  const [assetAgents, setAssetAgents] = useState<AssetAgentDiscoverySnapshot | null>(null);
  const [assetBusy, setAssetBusy] = useState(false);

  const [notifications, setNotifications] = useState<NotificationSettings | null>(null);
  const [notificationsBusy, setNotificationsBusy] = useState(false);
  const [testSent, setTestSent] = useState(false);

  const [appLock, setAppLock] = useState<AppLockState | null>(null);
  const [pinDraft, setPinDraft] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);

  const [companionDebug, setCompanionDebug] = useState<CompanionDebugSettings | null>(null);
  const [companionDebugBusy, setCompanionDebugBusy] = useState(false);

  useEffect(() => {
    void bridge.getUiSettings().then((ui) => {
      setNotifications(ui.notifications);
      setCompanionDebug(ui.companionDebug);
    });
    void bridge.appLockGetState().then(setAppLock).catch(() => setAppLock(null));
  }, []);

  const patchAppLock = useCallback(
    async (patch: Partial<AppLockSettings>) => {
      try {
        setAppLock(await bridge.appLockUpdateSettings(patch));
      } catch (err) {
        setPinError(err instanceof Error ? err.message : 'could not update the lock');
      }
    },
    [],
  );

  const savePin = useCallback(async () => {
    setPinError(null);
    try {
      setAppLock(await bridge.appLockSetPin(pinDraft.trim()));
      setPinDraft('');
    } catch (err) {
      setPinError(err instanceof Error ? err.message : 'could not set the PIN');
    }
  }, [pinDraft]);

  const clearPin = useCallback(async () => {
    setPinError(null);
    try {
      setAppLock(await bridge.appLockClearPin());
    } catch (err) {
      setPinError(err instanceof Error ? err.message : 'could not clear the PIN');
    }
  }, []);

  const patchNotifications = useCallback(
    async (patch: Partial<NotificationSettings>) => {
      if (!notifications) return;
      setNotificationsBusy(true);
      setTestSent(false);
      try {
        const ui = await bridge.setUiSettings({
          notifications: { ...notifications, ...patch },
        });
        setNotifications(ui.notifications);
      } finally {
        setNotificationsBusy(false);
      }
    },
    [notifications],
  );

  const patchCompanionDebug = useCallback(
    async (patch: Partial<CompanionDebugSettings>) => {
      if (!companionDebug) return;
      setCompanionDebugBusy(true);
      try {
        const ui = await bridge.setUiSettings({
          companionDebug: { ...companionDebug, ...patch },
        });
        setCompanionDebug(ui.companionDebug);
      } finally {
        setCompanionDebugBusy(false);
      }
    },
    [companionDebug],
  );

  const sendTestNotification = useCallback(async () => {
    await bridge.notifyIncoming({
      messageId: `test-${Date.now()}`,
      conversationId: null,
      contactId: null,
      agentId: null,
      senderName: 'Nexus',
      preview: 'This is what a new-message notification looks like.',
      title: 'Nexus',
    }, { force: true });
    setTestSent(true);
  }, []);

  const refreshAssetAgents = useCallback(async (scan: boolean) => {
    setAssetBusy(true);
    try {
      setAssetAgents(
        scan ? await bridge.assetAgentDiscoveryScan() : await bridge.assetAgentDiscoverySnapshot(),
      );
    } finally {
      setAssetBusy(false);
    }
  }, []);

  useEffect(() => {
    void bridge.runnerGetState().then(setRunner);
  }, []);

  const patchRunner = useCallback(async (patch: Partial<LocalRunnerSettings>) => {
    setRunnerBusy(true);
    try {
      setRunner(await bridge.runnerSetSettings(patch));
    } finally {
      setRunnerBusy(false);
    }
  }, []);

  const registerRunner = useCallback(async () => {
    setRunnerBusy(true);
    try {
      setRunner(await bridge.runnerRegister());
    } catch (err) {
      // Surface the reason (e.g. signed out) rather than failing silently.
      setRunner((cur) =>
        cur ? { ...cur, detail: err instanceof Error ? err.message : 'registration failed' } : cur,
      );
    } finally {
      setRunnerBusy(false);
    }
  }, []);

  useEffect(() => {
    void bridge.getToolsConfig().then(setTools);
  }, []);

  useEffect(() => {
    void refreshAssetAgents(false);
  }, [refreshAssetAgents]);

  async function addWorkspace() {
    const path = newWorkspace.trim();
    if (!path || !tools) return;
    const next: ToolsConfig = await bridge.setWorkspaces([
      ...tools.workspaces,
      { id: `ws-${Date.now()}`, label: path.split('/').filter(Boolean).pop() || path, path, mode: newWorkspaceMode },
    ]);
    setTools(next);
    setNewWorkspace('');
  }

  async function removeWorkspace(id: string) {
    if (!tools) return;
    setTools(await bridge.setWorkspaces(tools.workspaces.filter((w) => w.id !== id)));
  }

  async function toggleReadOnly(id: string) {
    if (!tools) return;
    setTools(
      await bridge.setWorkspaces(
        tools.workspaces.map((w) =>
          w.id === id ? { ...w, mode: w.mode === 'read-write' ? 'read-only' : 'read-write' } : w,
        ),
      ),
    );
  }

  async function onSave() {
    setSaving(true);
    setSaved(false);
    try {
      const next = await bridge.setConnectionConfig({
        regionUrl,
        gatewayUrl: gatewayUrl || null,
        portalUrl: portalUrl || null,
        customCaPem: customCaPem || null,
      });
      onConnectionChange(next);
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={wrap}>
      <section style={section}>
        <h2 style={{ margin: 0, fontSize: 16 }}>{t('settings.language')}</h2>
        <p style={{ margin: 0, color: '#6b7784', fontSize: 12 }}>{t('settings.language.help')}</p>
        <LanguageSelector variant="field" />
      </section>

      <section style={section}>
        <h2 style={{ margin: 0, fontSize: 16 }}>{t('settings.notifications')}</h2>
        <p style={{ margin: 0, color: '#6b7784', fontSize: 12 }}>
          {t('settings.notifications.help')}
        </p>
        {notifications ? (
          <>
            <label style={{ ...field, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <input
                type="checkbox"
                checked={notifications.enabled}
                disabled={notificationsBusy}
                onChange={(e) => void patchNotifications({ enabled: e.target.checked })}
              />
              <span style={{ color: '#e8eef4' }}>{t('settings.notifications.enabled')}</span>
            </label>

            <label style={field}>
              <span>{t('settings.notifications.cardMode')}</span>
              <select
                style={input}
                value={notifications.cardMode}
                disabled={notificationsBusy || !notifications.enabled}
                onChange={(e) =>
                  void patchNotifications({
                    cardMode: e.target.value === 'title_only' ? 'title_only' : 'full',
                  })
                }
              >
                <option value="full">{t('settings.notifications.cardMode.full')}</option>
                <option value="title_only">{t('settings.notifications.cardMode.titleOnly')}</option>
              </select>
            </label>

            <label style={{ ...field, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <input
                type="checkbox"
                checked={notifications.showSender}
                disabled={notificationsBusy || !notifications.enabled}
                onChange={(e) => void patchNotifications({ showSender: e.target.checked })}
              />
              <span style={{ color: '#e8eef4' }}>{t('settings.notifications.showSender')}</span>
            </label>

            <label style={{ ...field, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <input
                type="checkbox"
                checked={notifications.showPreview}
                disabled={
                  notificationsBusy ||
                  !notifications.enabled ||
                  notifications.cardMode === 'title_only'
                }
                onChange={(e) => void patchNotifications({ showPreview: e.target.checked })}
              />
              <span style={{ color: '#e8eef4' }}>{t('settings.notifications.showPreview')}</span>
            </label>

            <label style={{ ...field, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <input
                type="checkbox"
                checked={notifications.sound}
                disabled={notificationsBusy || !notifications.enabled}
                onChange={(e) => void patchNotifications({ sound: e.target.checked })}
              />
              <span style={{ color: '#e8eef4' }}>
                {t('settings.notifications.sound')}{' '}
                <span style={{ color: '#6b7784' }}>{t('settings.notifications.sound.help')}</span>
              </span>
            </label>

            <label style={{ ...field, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <input
                type="checkbox"
                checked={notifications.suppressWhenLocked}
                disabled={notificationsBusy || !notifications.enabled}
                onChange={(e) => void patchNotifications({ suppressWhenLocked: e.target.checked })}
              />
              <span style={{ color: '#e8eef4' }}>
                {t('settings.notifications.suppressWhenLocked')}{' '}
                <span style={{ color: '#6b7784' }}>
                  {notifications.suppressWhenLocked
                    ? '(on — locked cards show no content)'
                    : '(off — content is shown even while locked)'}
                </span>
              </span>
            </label>

            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <button
                type="button"
                style={{ ...button, background: '#1c2430', borderColor: '#3a4654' }}
                onClick={() => void sendTestNotification()}
                disabled={notificationsBusy}
              >
                {t('settings.notifications.test')}
              </button>
              {testSent ? (
                <span style={{ color: '#4ade80', fontSize: 12 }}>
                  {t('settings.notifications.testSent')}
                </span>
              ) : null}
            </div>
          </>
        ) : (
          <p style={{ color: '#6b7784', fontSize: 12 }}>Loading…</p>
        )}
      </section>

      <section style={section}>
        <h2 style={{ margin: 0, fontSize: 16 }}>App lock</h2>
        <p style={{ margin: 0, color: '#6b7784', fontSize: 12 }}>
          Lock the interface behind a PIN after a period of inactivity. The lock hides the screen
          only — it never blocks sign-in, 2FA, or any secure operation. Forgot the PIN? Sign out or
          switch user to clear it.
        </p>
        {appLock ? (
          <>
            <label style={{ ...field, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <input
                type="checkbox"
                checked={appLock.settings.enabled}
                disabled={!appLock.hasPin}
                onChange={(e) => void patchAppLock({ enabled: e.target.checked })}
              />
              <span style={{ color: '#e8eef4' }}>
                Lock the app after inactivity
                {!appLock.hasPin ? (
                  <span style={{ color: '#6b7784' }}> (set a PIN first)</span>
                ) : null}
              </span>
            </label>

            <label style={field}>
              <span>Lock after (minutes of inactivity)</span>
              <select
                style={input}
                value={appLock.settings.timeoutMinutes}
                disabled={!appLock.settings.enabled}
                onChange={(e) => void patchAppLock({ timeoutMinutes: Number(e.target.value) })}
              >
                {LOCK_TIMEOUT_CHOICES.map((m) => (
                  <option key={m} value={m}>
                    {m === 1 ? '1 minute' : `${m} minutes`}
                  </option>
                ))}
              </select>
            </label>

            <label style={field}>
              <span>{appLock.hasPin ? 'Replace PIN' : `Set a PIN (${PIN_MIN_LENGTH}–12 digits)`}</span>
              <input
                style={input}
                type="password"
                inputMode="numeric"
                value={pinDraft}
                placeholder="••••"
                onChange={(e) => setPinDraft(e.target.value.replace(/[^0-9]/g, ''))}
              />
            </label>
            {pinError ? <span style={{ color: '#f2a1a1', fontSize: 12 }}>{pinError}</span> : null}

            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <button
                type="button"
                style={button}
                disabled={pinDraft.trim().length < PIN_MIN_LENGTH}
                onClick={() => void savePin()}
              >
                {appLock.hasPin ? 'Replace PIN' : 'Set PIN'}
              </button>
              {appLock.hasPin ? (
                <button
                  type="button"
                  style={{ ...button, background: '#1c2430', borderColor: '#3a4654' }}
                  onClick={() => void clearPin()}
                >
                  Remove PIN
                </button>
              ) : null}
              {appLock.armed ? (
                <span style={{ color: '#4ade80', fontSize: 12 }}>
                  Armed · locks after {appLock.settings.timeoutMinutes} min
                </span>
              ) : (
                <span style={{ color: '#6b7784', fontSize: 12 }}>Not armed</span>
              )}
              <span style={{ flex: 1 }} />
              {appLock.armed ? (
                <button
                  type="button"
                  style={{ ...button, background: '#1c2430', borderColor: '#3a4654' }}
                  onClick={() => void bridge.appLockLock()}
                >
                  Lock now
                </button>
              ) : null}
            </div>
          </>
        ) : (
          <p style={{ color: '#6b7784', fontSize: 12 }}>Loading…</p>
        )}
      </section>

      <section style={section}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Companion debug</h2>
        <p style={{ margin: 0, color: '#6b7784', fontSize: 12 }}>
          Developer surfaces for the 3D agent companion. All off by default; a normal companion
          window stays clean. The motion feed shows the live action stream (source / status / op),
          the gesture tester plays any loaded clip, and the status-motion editor tunes the clips an
          agent uses while working. Scene mode swaps the flat stage for a walkable room so the
          character tools (walk / approach / turn) are visible. You can also force all of these on
          with <code>?companionDebug=1</code> in the companion window URL.
        </p>
        {companionDebug ? (
          <>
            {(
              [
                ['motionFeed', 'Motion feed panel', 'Live action feed (source / status / Δ / op / detail).'],
                ['gestureTest', 'Gesture tester', 'Play any loaded clip, or run all one-shots.'],
                ['statusMotions', 'Status motions editor', 'Clips cycled while the agent is thinking / writing.'],
                ['sceneMode', 'Walkable scene', 'Ground grid + room bounds so walk / approach is visible.'],
              ] as const
            ).map(([key, label, hint]) => (
              <label
                key={key}
                style={{ ...field, flexDirection: 'row', alignItems: 'center', gap: 10 }}
              >
                <input
                  type="checkbox"
                  checked={companionDebug[key]}
                  disabled={companionDebugBusy}
                  onChange={(e) => void patchCompanionDebug({ [key]: e.target.checked })}
                />
                <span style={{ color: '#e8eef4' }}>
                  {label}
                  <span style={{ color: '#6b7784' }}> — {hint}</span>
                </span>
              </label>
            ))}
          </>
        ) : (
          <p style={{ color: '#6b7784', fontSize: 12 }}>Loading…</p>
        )}
      </section>

      <section style={section}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Connection</h2>
        <p style={{ margin: 0, color: '#6b7784', fontSize: 12 }}>
          Region node and inference are cloud-hosted per region stack. The desktop is a client; the
          gateway defaults to the region until gateways are deployed.
        </p>

        <label style={field}>
          <span>Region node</span>
          <input style={input} value={regionUrl} onChange={(e) => setRegionUrl(e.target.value)} />
        </label>
        <label style={field}>
          <span>Gateway (optional — defaults to region)</span>
          <input
            style={input}
            value={gatewayUrl}
            placeholder="same as region node"
            onChange={(e) => setGatewayUrl(e.target.value)}
          />
        </label>
        <label style={field}>
          <span>Portal (optional — for redirects)</span>
          <input
            style={input}
            value={portalUrl}
            placeholder="region may advertise its own"
            onChange={(e) => setPortalUrl(e.target.value)}
          />
        </label>
        <label style={field}>
          <span>Custom CA (PEM, for local/self-signed region nodes)</span>
          <textarea
            style={{ ...input, minHeight: 90, fontFamily: 'monospace' }}
            value={customCaPem}
            placeholder="-----BEGIN CERTIFICATE-----"
            onChange={(e) => setCustomCaPem(e.target.value)}
          />
        </label>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button type="button" style={button} onClick={onSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save connection'}
          </button>
          {saved ? <span style={{ color: '#4ade80', fontSize: 12 }}>Saved</span> : null}
          <span style={{ flex: 1 }} />
          <button type="button" style={{ ...button, background: '#1c2430', borderColor: '#3a4654' }} onClick={onClose}>
            {t('settings.done')}
          </button>
        </div>
      </section>

      <ErrorBoundary label="Nexus apps">
        <NexusAppsPanel />
      </ErrorBoundary>

      <ErrorBoundary label="Trusted certificates">
        <CertTrustPanel />
      </ErrorBoundary>

      <ErrorBoundary label="Local models">
        <LocalModelsPanel />
      </ErrorBoundary>

      <ErrorBoundary label="Local speech models">
        <LocalVoicePanel />
      </ErrorBoundary>

      <ErrorBoundary label="Wake words">
        <WakeSettingsPanel />
      </ErrorBoundary>

      <ErrorBoundary label="Client-tool audit trail">
        <AuditPanel />
      </ErrorBoundary>

      <section style={section}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Local GPU runner (BYOK)</h2>
        <p style={{ margin: 0, color: '#6b7784', fontSize: 12 }}>
          Expose this machine&apos;s local model server to your agents. The runner serves a
          loopback TLS proxy registered with the region as a BYOK <code>edge_gpu_sidecar</code>{' '}
          provider, so your agents can use your own GPU without buying cloud tokens.
        </p>

        {runner ? (
          <>
            <label style={{ ...field, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <input
                type="checkbox"
                checked={runner.settings.enabled}
                disabled={runnerBusy}
                onChange={(e) => void patchRunner({ enabled: e.target.checked })}
              />
              <span>Run the local runner while signed in</span>
            </label>

            <label style={field}>
              <span>Label in the model picker</span>
              <input
                style={input}
                value={runner.settings.name}
                disabled={runnerBusy}
                onChange={(e) => setRunner({ ...runner, settings: { ...runner.settings, name: e.target.value } })}
                onBlur={(e) => void patchRunner({ name: e.target.value })}
              />
            </label>

            <label style={field}>
              <span>Upstream local server (OpenAI-compatible)</span>
              <input
                style={input}
                value={runner.settings.upstreamBaseUrl}
                placeholder="http://127.0.0.1:11434"
                disabled={runnerBusy}
                onChange={(e) =>
                  setRunner({ ...runner, settings: { ...runner.settings, upstreamBaseUrl: e.target.value } })
                }
                onBlur={(e) => void patchRunner({ upstreamBaseUrl: e.target.value })}
              />
            </label>

            <label style={field}>
              <span>Scope</span>
              <select
                style={input}
                value={runner.settings.scope}
                disabled={runnerBusy}
                onChange={(e) => void patchRunner({ scope: e.target.value as 'user' | 'org' })}
              >
                <option value="user">user (private)</option>
                <option value="org">org (shared with members)</option>
              </select>
            </label>

            <div style={row}>
              <HealthChip health={runner.availability} />
              <span style={{ color: '#6b7784', fontSize: 12 }}>
                {runner.endpointUrl ?? runner.detail ?? 'not running'}
              </span>
              <span style={{ flex: 1 }} />
              <span style={{ color: '#6b7784', fontSize: 11 }}>
                {runner.registered ? `registered${runner.providerId ? ` · ${runner.providerId}` : ''}` : 'not registered'}
              </span>
            </div>

            {runner.certFingerprint ? (
              <p style={{ margin: 0, color: '#6b7784', fontSize: 11, fontFamily: 'monospace' }}>
                loopback cert {runner.certFingerprint.slice(0, 32)}… · expires {runner.certNotAfter || '—'}
              </p>
            ) : null}

            <div style={{ display: 'flex', gap: 10 }}>
              <button
                type="button"
                style={button}
                disabled={runnerBusy || !runner.settings.enabled}
                onClick={() => void registerRunner()}
              >
                Register with region
              </button>
              {runner.settings.enabled ? (
                <button
                  type="button"
                  style={{ ...button, background: '#1c2430', borderColor: '#3a4654' }}
                  disabled={runnerBusy}
                  onClick={() => void patchRunner({ enabled: false })}
                >
                  Stop
                </button>
              ) : null}
            </div>
          </>
        ) : (
          <p style={{ color: '#6b7784', fontSize: 12 }}>Loading…</p>
        )}
      </section>

      <section style={section}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Agent workspaces</h2>
        <p style={{ margin: 0, color: '#6b7784', fontSize: 12 }}>
          Directories the agent may read or write. Enforced in the main process — paths outside these
          roots (including symlink escapes) are refused.
        </p>

        {tools?.workspaces.length ? (
          tools.workspaces.map((w) => (
            <div key={w.id} style={row}>
              <strong style={{ fontSize: 13 }}>{w.label}</strong>
              <span style={{ color: '#6b7784', fontSize: 12 }}>{w.path}</span>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                style={{ ...button, background: '#1c2430', borderColor: '#3a4654', padding: '4px 10px' }}
                onClick={() => toggleReadOnly(w.id)}
              >
                {w.mode}
              </button>
              <button
                type="button"
                style={{ ...button, background: '#1c2430', borderColor: '#3a4654', padding: '4px 10px' }}
                onClick={() => removeWorkspace(w.id)}
              >
                Remove
              </button>
            </div>
          ))
        ) : (
          <p style={{ color: '#6b7784', fontSize: 12 }}>No workspaces yet.</p>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            style={{ ...input, flex: 1 }}
            value={newWorkspace}
            placeholder="/absolute/path/to/project"
            onChange={(e) => setNewWorkspace(e.target.value)}
          />
          <select
            style={input}
            value={newWorkspaceMode}
            onChange={(e) => setNewWorkspaceMode(e.target.value as WorkspaceRoot['mode'])}
          >
            <option value="read-write">read-write</option>
            <option value="read-only">read-only</option>
          </select>
          <button type="button" style={button} onClick={addWorkspace}>
            Add
          </button>
        </div>
      </section>

      <section style={section}>
        <h2 style={{ margin: 0, fontSize: 16 }}>LAN asset agents</h2>
        <p style={{ margin: 0, color: '#6b7784', fontSize: 12 }}>
          Asset nodes announce themselves on the local network over mDNS (<code>_anx._tcp</code>).
          When enabled, the desktop prefers the direct LAN/intranet path to your own asset agents
          instead of routing through the region. Peers from another region are never trusted.
        </p>

        {assetAgents ? (
          <>
            <label style={{ ...field, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <input
                type="checkbox"
                checked={assetAgents.preferLocalEnabled}
                disabled={assetBusy}
                onChange={(e) => void bridge.assetAgentSetPreferLocal(e.target.checked).then(setAssetAgents)}
              />
              <span>Prefer the local path to my asset agents</span>
            </label>

            {assetAgents.matches.length ? (
              assetAgents.matches.map((m) => (
                <div key={m.contactId} style={row}>
                  <strong style={{ fontSize: 13 }}>{m.name ?? m.assetId}</strong>
                  <span style={{ color: '#6b7784', fontSize: 12 }}>
                    {m.host}:{m.port}
                  </span>
                  <HealthChip health={m.routeKind === 'intranet' ? 'available' : 'healthy'} />
                  <span style={{ flex: 1 }} />
                  {m.hostsRooms ? <span style={{ color: '#6b7784', fontSize: 11 }}>hosts rooms</span> : null}
                </div>
              ))
            ) : (
              <p style={{ color: '#6b7784', fontSize: 12 }}>
                {assetAgents.detail ?? 'No matching asset agents found on this network.'}
              </p>
            )}

            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <button
                type="button"
                style={{ ...button, background: '#1c2430', borderColor: '#3a4654' }}
                onClick={() => void refreshAssetAgents(true)}
                disabled={assetBusy}
              >
                {assetBusy ? 'Scanning…' : 'Scan now'}
              </button>
              {assetAgents.region ? (
                <span style={{ color: '#6b7784', fontSize: 11 }}>
                  region {assetAgents.region}
                  {assetAgents.rejectedForeignRegion
                    ? ` · ${assetAgents.rejectedForeignRegion} foreign ignored`
                    : ''}
                </span>
              ) : null}
            </div>
          </>
        ) : (
          <p style={{ color: '#6b7784', fontSize: 12 }}>Loading…</p>
        )}
      </section>

      <section style={section}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Local command skills</h2>
        <p style={{ margin: 0, color: '#6b7784', fontSize: 12 }}>
          Per-OS commands the agent may run, exposed as client tools. The CPU + GPU load skill ships
          by default (read-only).
        </p>
        {tools?.localCommands.map((skill) => (
          <LocalCommandRow key={skill.skillId} skill={skill} />
        ))}
      </section>
    </div>
  );
}

function LocalCommandRow({ skill }: { skill: LocalCommandSkill }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={row}>
        <strong style={{ fontSize: 14 }}>{skill.title}</strong>
        <span style={{ color: '#9aa7b5', fontSize: 12 }}>{skill.oneLiner}</span>
      </div>
      <ul style={{ margin: '0 0 8px', paddingLeft: 18, color: '#6b7784', fontSize: 12 }}>
        {skill.commands.map((c) => (
          <li key={c.id}>
            <code>{c.os}</code> · {c.access}
            {c.approval === 'ask' ? ' · needs approval' : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}
