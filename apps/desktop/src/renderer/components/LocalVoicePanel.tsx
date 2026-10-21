import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import {
  bridge,
  type LocalVoiceEndpoint,
  type LocalVoiceModelKind,
  type LocalVoiceModelRow,
  type LocalVoiceProtocol,
  type LocalVoiceSettings,
  type LocalVoiceState,
} from '../bridge.js';

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
  padding: '6px 12px',
  borderRadius: 8,
  border: '1px solid #3f6cb0',
  background: '#2f5c9e',
  color: '#fff',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
};

const ghostButton: CSSProperties = {
  ...button,
  background: '#1c2430',
  borderColor: '#3a4654',
  color: '#e8eef4',
  fontWeight: 500,
};

const row: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 0',
  borderTop: '1px solid #222b34',
};

const PROTOCOLS: { id: LocalVoiceProtocol; label: string }[] = [
  { id: 'openai_audio', label: 'OpenAI-compatible audio' },
  { id: 'whisper_rest', label: 'Whisper REST' },
  { id: 'ollama', label: 'Ollama' },
  { id: 'custom', label: 'Custom' },
];

function formatBytes(bytes?: number | null): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

function pct(free: number | null | undefined, total: number | null | undefined): number | null {
  if (typeof free !== 'number' || typeof total !== 'number' || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((free / total) * 100)));
}

/** A labelled free/used meter (VRAM or RAM). */
function ResourceBar({
  label,
  freeBytes,
  totalBytes,
  note,
  color,
}: {
  label: string;
  freeBytes: number | null;
  totalBytes: number | null;
  note?: string | null;
  color: string;
}) {
  const free = pct(freeBytes, totalBytes);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', fontSize: 12, color: '#9aa7b5' }}>
        <span>{label}</span>
        <span style={{ flex: 1 }} />
        <span>
          {free == null
            ? 'unknown'
            : `${formatBytes(freeBytes)} free of ${formatBytes(totalBytes)} (${free}%)`}
        </span>
      </div>
      <div
        style={{
          height: 8,
          borderRadius: 999,
          background: '#0f1419',
          border: '1px solid #2a333d',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${free ?? 0}%`,
            background: color,
            transition: 'width 0.3s ease',
          }}
        />
      </div>
      {note ? <span style={{ fontSize: 11, color: '#6b7784' }}>{note}</span> : null}
    </div>
  );
}

function ModelRow({ model, onChange }: { model: LocalVoiceModelRow; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const downloading = model.installState === 'downloading';
  const installed = model.installState === 'installed';

  async function act(fn: () => Promise<LocalVoiceState>) {
    setBusy(true);
    try {
      await fn();
      onChange();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ ...row, flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            textTransform: 'uppercase',
            color: model.kind === 'stt' ? '#7fb2ff' : '#ffb27f',
            border: `1px solid ${model.kind === 'stt' ? '#2f5c9e' : '#8a5a2a'}`,
            borderRadius: 999,
            padding: '1px 7px',
          }}
        >
          {model.kind}
        </span>
        <strong style={{ fontSize: 13 }}>{model.label}</strong>
        <span style={{ flex: 1 }} />
        {model.sizeBytes ? <span style={{ fontSize: 11, color: '#6b7784' }}>{formatBytes(model.sizeBytes)}</span> : null}
        {model.vramGiB ? (
          <span style={{ fontSize: 11, color: '#6b7784' }}>~{model.vramGiB} GB VRAM</span>
        ) : null}
      </div>
      {model.runtime || model.licenseKeys.length ? (
        <span style={{ fontSize: 11, color: '#6b7784' }}>
          {model.runtime}
          {model.runtime && model.licenseKeys.length ? ' · ' : ''}
          {model.licenseKeys.join(', ')}
        </span>
      ) : null}

      {downloading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ height: 8, borderRadius: 999, background: '#0f1419', border: '1px solid #2a333d', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${model.downloadPercent ?? 0}%`, background: '#3f6cb0' }} />
          </div>
          <div style={{ display: 'flex', fontSize: 11, color: '#6b7784' }}>
            <span>
              {formatBytes(model.installedBytes)}
              {model.sizeBytes ? ` / ${formatBytes(model.sizeBytes)}` : ''}
            </span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              style={{ ...ghostButton, padding: '2px 8px' }}
              onClick={() => void act(() => bridge.localVoiceCancelInstall(model.id))}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {model.error && !downloading ? (
        <span style={{ fontSize: 11, color: '#f2a1a1' }}>{model.error}</span>
      ) : null}

      <div style={{ display: 'flex', gap: 8 }}>
        {installed ? (
          <>
            <span style={{ fontSize: 11, color: '#4ade80' }}>Installed</span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              style={{ ...ghostButton, padding: '3px 10px' }}
              disabled={busy}
              onClick={() => void act(() => bridge.localVoiceRemove(model.id))}
            >
              Remove
            </button>
          </>
        ) : downloading ? null : (
          <>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              style={{ ...button, padding: '3px 10px' }}
              disabled={busy || !model.downloadUrl}
              title={model.downloadUrl ?? 'No download URL for this model'}
              onClick={() => void act(() => bridge.localVoiceInstall(model.id))}
            >
              Download
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Custom self-hosted endpoint editor (protocol + URL + ignore-TLS). */
function EndpointEditor({
  kind,
  endpoint,
  ignoreTlsForCustom,
  onChange,
}: {
  kind: LocalVoiceModelKind;
  endpoint: LocalVoiceEndpoint | null;
  ignoreTlsForCustom: boolean;
  onChange: (next: LocalVoiceEndpoint | null, ignoreTls: boolean) => void;
}) {
  const enabled = endpoint != null;
  const ep: LocalVoiceEndpoint = endpoint ?? {
    kind,
    protocol: 'openai_audio',
    baseUrl: '',
    ignoreTls: false,
    apiKey: null,
  };
  const isHttps = /^https:\/\//i.test(ep.baseUrl.trim());

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0' }}>
      <label style={{ ...field, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) =>
            onChange(
              e.target.checked
                ? { kind, protocol: ep.protocol, baseUrl: ep.baseUrl || 'http://127.0.0.1:8000', ignoreTls: false }
                : null,
              ignoreTlsForCustom,
            )
          }
        />
        <span>Use a custom self-hosted {kind.toUpperCase()} server</span>
      </label>

      {enabled ? (
        <>
          <label style={field}>
            <span>API protocol (from the system catalog)</span>
            <select
              style={input}
              value={ep.protocol}
              onChange={(e) => onChange({ ...ep, protocol: e.target.value as LocalVoiceProtocol }, ignoreTlsForCustom)}
            >
              {PROTOCOLS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label style={field}>
            <span>Base URL</span>
            <input
              style={input}
              value={ep.baseUrl}
              placeholder="http://127.0.0.1:8000"
              onChange={(e) => onChange({ ...ep, baseUrl: e.target.value }, ignoreTlsForCustom)}
            />
          </label>
          {isHttps ? (
            <label style={{ ...field, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <input
                type="checkbox"
                checked={ep.ignoreTls}
                onChange={(e) => onChange({ ...ep, ignoreTls: e.target.checked }, ignoreTlsForCustom)}
              />
              <span>
                Ignore TLS warnings (self-signed certificate). Only for a server you trust on your own
                network.
              </span>
            </label>
          ) : null}
          <label style={field}>
            <span>API key (optional)</span>
            <input
              style={input}
              value={ep.apiKey ?? ''}
              onChange={(e) => onChange({ ...ep, apiKey: e.target.value || null }, ignoreTlsForCustom)}
            />
          </label>
        </>
      ) : null}
    </div>
  );
}

/**
 * Settings → Local speech models (Phase 11e).
 *
 * Installs on-device STT/TTS models (from the region catalog / built-in
 * fallback), shows how much RAM and VRAM is free, and configures the idle
 * auto-unload plus a custom self-hosted endpoint — including a self-signed TLS
 * acknowledgement.
 */
export function LocalVoicePanel() {
  const [state, setState] = useState<LocalVoiceState | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const refresh = useCallback(async () => {
    setState(await bridge.localVoiceGetState());
  }, []);

  useEffect(() => {
    void refresh();
    // Refresh periodically so a download's progress bar + a live VRAM bar move.
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, [refresh]);

  const patch = useCallback(
    async (next: Partial<LocalVoiceSettings>) => {
      setBusy(true);
      setSaved(false);
      try {
        setState(await bridge.localVoiceSetSettings(next));
        setSaved(true);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  if (!state) {
    return (
      <section style={section}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Local speech models</h2>
        <p style={{ margin: 0, color: '#6b7784', fontSize: 12 }}>Loading…</p>
      </section>
    );
  }

  const { settings, resources, models } = state;
  const sttModels = models.filter((m) => m.kind === 'stt');
  const ttsModels = models.filter((m) => m.kind === 'tts');

  return (
    <section style={section}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Local speech models</h2>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          style={ghostButton}
          disabled={busy}
          onClick={() => void refresh().then(() => bridge.localVoiceRefreshCatalog().then(setState))}
        >
          Refresh catalog
        </button>
      </div>
      <p style={{ margin: 0, color: '#6b7784', fontSize: 12 }}>
        Run speech-to-text and text-to-speech on this machine. Models install from public repositories
        (HuggingFace). The engine is only loaded while you are talking and is unloaded after the idle
        timeout to free VRAM. Models install to <code>{state.modelsDir}</code>.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0' }}>
        <ResourceBar
          label="GPU VRAM"
          freeBytes={resources.vram?.freeBytes ?? null}
          totalBytes={resources.vram?.totalBytes ?? null}
          note={resources.vram ? null : resources.vramReason}
          color="#4ade80"
        />
        <ResourceBar
          label="System RAM"
          freeBytes={resources.ram?.freeBytes ?? null}
          totalBytes={resources.ram?.totalBytes ?? null}
          color="#3f6cb0"
        />
      </div>

      <label style={{ ...field, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <input
          type="checkbox"
          checked={settings.enabled}
          disabled={busy}
          onChange={(e) => void patch({ enabled: e.target.checked })}
        />
        <span>Enable on-device speech engines</span>
      </label>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <label style={{ ...field, flex: 1, minWidth: 220 }}>
          <span>Speech-to-text engine</span>
          <select
            style={input}
            value={settings.sttEngine}
            disabled={busy}
            onChange={(e) => void patch({ sttEngine: e.target.value as 'cloud' | 'local' })}
          >
            <option value="cloud">Cloud (region inference)</option>
            <option value="local">On-device</option>
          </select>
        </label>
        <label style={{ ...field, flex: 1, minWidth: 220 }}>
          <span>Text-to-speech engine</span>
          <select
            style={input}
            value={settings.ttsEngine}
            disabled={busy}
            onChange={(e) => void patch({ ttsEngine: e.target.value as 'cloud' | 'local' })}
          >
            <option value="cloud">Cloud (region inference)</option>
            <option value="local">On-device</option>
          </select>
        </label>
        <label style={{ ...field, minWidth: 200 }}>
          <span>Unload after idle (seconds)</span>
          <input
            style={input}
            type="number"
            min={0}
            value={settings.idleTimeoutSeconds}
            disabled={busy}
            onChange={(e) => void patch({ idleTimeoutSeconds: Number(e.target.value) })}
          />
        </label>
      </div>

      <h3 style={{ margin: '8px 0 0', fontSize: 14 }}>Speech-to-text (Whisper)</h3>
      {sttModels.map((m) => (
        <ModelRow key={m.id} model={m} onChange={() => void refresh()} />
      ))}

      <h3 style={{ margin: '8px 0 0', fontSize: 14 }}>Text-to-speech</h3>
      {ttsModels.map((m) => (
        <ModelRow key={m.id} model={m} onChange={() => void refresh()} />
      ))}

      <h3 style={{ margin: '8px 0 0', fontSize: 14 }}>Custom endpoints</h3>
      <p style={{ margin: 0, color: '#6b7784', fontSize: 12 }}>
        Point at your own self-hosted server. Pick an API protocol from the system catalog and supply
        your own URL; a self-signed https endpoint requires the explicit acknowledgement below.
      </p>
      <EndpointEditor
        kind="stt"
        endpoint={settings.customSttEndpoint}
        ignoreTlsForCustom={settings.ignoreTlsForCustom}
        onChange={(ep, ignore) => void patch({ customSttEndpoint: ep, ignoreTlsForCustom: ignore })}
      />
      <EndpointEditor
        kind="tts"
        endpoint={settings.customTtsEndpoint}
        ignoreTlsForCustom={settings.ignoreTlsForCustom}
        onChange={(ep, ignore) => void patch({ customTtsEndpoint: ep, ignoreTlsForCustom: ignore })}
      />

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button type="button" style={ghostButton} disabled={busy} onClick={() => void bridge.localVoiceProbeResources().then(() => refresh())}>
          Re-probe RAM / VRAM
        </button>
        <span style={{ flex: 1 }} />
        {saved ? <span style={{ color: '#4ade80', fontSize: 12 }}>Saved</span> : null}
      </div>

      {state.engines.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, color: '#9aa7b5' }}>Engine state</span>
          {state.engines.map((e) => (
            <span key={e.id} style={{ fontSize: 11, color: '#6b7784' }}>
              {e.id} · {e.state}
              {e.lastUsedAtMs ? ` · used ${new Date(e.lastUsedAtMs).toLocaleTimeString()}` : ''}
              {e.error ? ` · ${e.error}` : ''}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}
