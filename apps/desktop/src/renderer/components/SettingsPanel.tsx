import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import {
  bridge,
  type AssetAgentDiscoverySnapshot,
  type DesktopConnectionConfig,
  type LocalCommandSkill,
  type LocalModelBackendStatus,
  type LocalModelsSnapshot,
  type LocalRunnerSettings,
  type LocalRunnerState,
  type ToolsConfig,
  type WorkspaceRoot,
} from '../bridge.js';

const wrap: CSSProperties = {
  height: '100%',
  overflow: 'auto',
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

function formatBytes(bytes?: number | null): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
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
  const [regionUrl, setRegionUrl] = useState(connection.regionUrl);
  const [gatewayUrl, setGatewayUrl] = useState(connection.gatewayUrl ?? '');
  const [portalUrl, setPortalUrl] = useState(connection.portalUrl ?? '');
  const [customCaPem, setCustomCaPem] = useState(connection.customCaPem ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [models, setModels] = useState<LocalModelsSnapshot | null>(null);
  const [modelsBusy, setModelsBusy] = useState(false);

  const [runner, setRunner] = useState<LocalRunnerState | null>(null);
  const [runnerBusy, setRunnerBusy] = useState(false);

  const [tools, setTools] = useState<ToolsConfig | null>(null);
  const [newWorkspace, setNewWorkspace] = useState('');
  const [newWorkspaceMode, setNewWorkspaceMode] = useState<WorkspaceRoot['mode']>('read-write');

  const [assetAgents, setAssetAgents] = useState<AssetAgentDiscoverySnapshot | null>(null);
  const [assetBusy, setAssetBusy] = useState(false);

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

  const refreshModels = useCallback(async () => {
    setModelsBusy(true);
    try {
      setModels(await bridge.listLocalModels(true));
    } finally {
      setModelsBusy(false);
    }
  }, []);

  useEffect(() => {
    void refreshModels();
  }, [refreshModels]);

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
            Done
          </button>
        </div>
      </section>

      <section style={section}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Local models</h2>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            style={{ ...button, background: '#1c2430', borderColor: '#3a4654' }}
            onClick={refreshModels}
            disabled={modelsBusy}
          >
            {modelsBusy ? 'Checking…' : 'Refresh'}
          </button>
        </div>
        <p style={{ margin: 0, color: '#6b7784', fontSize: 12 }}>
          Detected on this machine. Ollama is enabled by default; ComfyUI is a preview placeholder.
          Auto-discovery and manual backends come later.
        </p>

        {models?.backends.map((status) => (
          <LocalModelRow key={status.backend.id} status={status} />
        ))}
        {!models ? <p style={{ color: '#6b7784', fontSize: 12 }}>Checking…</p> : null}
      </section>

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

function LocalModelRow({ status }: { status: LocalModelBackendStatus }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={row}>
        <strong style={{ fontSize: 14 }}>{status.backend.label}</strong>
        <HealthChip health={status.health} />
        <span style={{ color: '#6b7784', fontSize: 12 }}>{status.backend.baseUrl}</span>
        <span style={{ flex: 1 }} />
        <span style={{ color: '#6b7784', fontSize: 11 }}>
          {status.models.length ? `${status.models.length} model(s)` : status.detail ?? ''}
        </span>
      </div>
      {status.models.length ? (
        <ul style={{ margin: '0 0 8px', paddingLeft: 18, color: '#9aa7b5', fontSize: 12 }}>
          {status.models.map((m) => (
            <li key={m.id}>
              {m.name}
              {formatBytes(m.sizeBytes) ? ` · ${formatBytes(m.sizeBytes)}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
