import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import {
  bridge,
  type DesktopConnectionConfig,
  type LocalModelBackendStatus,
  type LocalModelsSnapshot,
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
  unreachable: '#f2a1a1',
  disabled: '#8b95a1',
  checking: '#fbbf24',
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
