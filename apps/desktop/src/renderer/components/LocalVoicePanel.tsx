import { useCallback, useState, type CSSProperties } from 'react';
import {
  bridge,
  type LocalVoiceEndpoint,
  type LocalVoiceModelKind,
  type LocalVoiceModelRow,
  type LocalVoiceProtocol,
  type LocalVoiceSettings,
  type LocalVoiceState,
  type VoiceBinaryStatus,
} from '../bridge.js';
import { useVoiceSnapshot, refreshVoiceState } from '../voice/use-voice-store.js';

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

const tinyButton: CSSProperties = {
  ...ghostButton,
  padding: '2px 8px',
  fontSize: 11,
};

/** Inline "project / model card" link (opens in the system browser). */
const sourceLink: CSSProperties = {
  padding: 0,
  border: 'none',
  background: 'none',
  color: '#7fb2ff',
  cursor: 'pointer',
  fontSize: 11,
  textDecoration: 'underline',
};

/**
 * Short, honest label for a model's project page: name the host and the repo so
 * a link is never a bare URL the user cannot judge before clicking.
 */
function sourceLabel(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === 'github.com') {
      return `Source: github.com/${u.pathname.split('/').filter(Boolean).slice(0, 2).join('/')}`;
    }
    if (u.hostname.endsWith('huggingface.co')) {
      return `Source: huggingface.co/${u.pathname.split('/').filter(Boolean).slice(0, 2).join('/')}`;
    }
    return `Source: ${u.hostname}`;
  } catch {
    return 'Source';
  }
}

const row: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 0',
  borderTop: '1px solid #222b34',
};

/** Per-kind badge colors, so new modalities do not fall back to a wrong hue. */
const KIND_BADGE: Record<string, { color: string; border: string }> = {
  stt: { color: '#7fb2ff', border: '#2f5c9e' },
  tts: { color: '#ffb27f', border: '#8a5a2a' },
  vad: { color: '#8fe3c0', border: '#2f7d5f' },
  wake: { color: '#d8a5ff', border: '#6a3f9e' },
};

const PROTOCOLS: { id: LocalVoiceProtocol; label: string }[] = [  { id: 'openai_audio', label: 'OpenAI-compatible audio' },
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

function ModelRow({
  model,
  onChange,
  highlight,
}: {
  model: LocalVoiceModelRow;
  onChange: () => void;
  /** True when this row is the recommended install to make wakes work. */
  highlight?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const downloading = model.installState === 'downloading';
  const installed = model.installState === 'installed';
  const error = model.installState === 'error';

  async function act(fn: () => Promise<LocalVoiceState>) {
    setBusy(true);
    try {
      await fn();
      // Push the new state to every panel at once (wake words reads the same store).
      await refreshVoiceState();
      onChange();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        ...row,
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: 4,
        padding: '8px 10px',
        borderRadius: 8,
        background: highlight ? '#101823' : 'transparent',
        border: highlight ? '1px solid #2f5c9e' : '1px solid transparent',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            textTransform: 'uppercase',
            color: KIND_BADGE[model.kind]?.color ?? '#9aa7b5',
            border: `1px solid ${KIND_BADGE[model.kind]?.border ?? '#3a4654'}`,
            borderRadius: 999,
            padding: '1px 7px',
          }}
        >
          {model.kind}
        </span>
        <strong style={{ fontSize: 12 }}>{model.label}</strong>
        <span style={{ flex: 1 }} />
        {installed ? (
          <span style={{ fontSize: 11, color: '#4ade80', fontWeight: 600 }}>✓ Installed</span>
        ) : error ? (
          <span style={{ fontSize: 11, color: '#f2a1a1' }}>Failed</span>
        ) : (
          <span style={{ fontSize: 11, color: '#6b7784' }}>Not installed</span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 11, color: '#6b7784' }}>
        {model.sizeBytes ? <span>{formatBytes(model.sizeBytes)}</span> : null}
        {model.vramGiB ? <span>~{model.vramGiB} GB VRAM</span> : null}
        {model.runtime ? <span>{model.runtime}</span> : null}
        {model.licenseKeys.length ? <span>{model.licenseKeys.join(', ')}</span> : null}
        {model.sourceUrl ? (
          <button
            type="button"
            style={sourceLink}
            title={model.sourceUrl}
            onClick={() => void bridge.openExternal(model.sourceUrl!)}
          >
            {sourceLabel(model.sourceUrl)}
          </button>
        ) : null}
      </div>

      {downloading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ height: 6, borderRadius: 999, background: '#0f1419', border: '1px solid #2a333d', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${model.downloadPercent ?? 0}%`, background: '#3f6cb0' }} />
          </div>
          <div style={{ display: 'flex', fontSize: 11, color: '#6b7784', alignItems: 'center' }}>
            <span>
              {formatBytes(model.installedBytes)}
              {model.sizeBytes ? ` / ${formatBytes(model.sizeBytes)}` : ''}
            </span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              style={tinyButton}
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

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {installed ? (
          <>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              style={tinyButton}
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
              style={{ ...button, padding: '3px 12px' }}
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

/**
 * Speech-engine runner binary row: the executable (`whisper-server`) the local
 * STT / wake engines spawn. Lets the user install it with one click instead of
 * setting up a system PATH manually, and shows honest per-OS steps when a
 * prebuilt does not exist (macOS).
 */
function VoiceBinaryRow({ status }: { status: VoiceBinaryStatus | null }) {
  const [busy, setBusy] = useState(false);
  const [showSteps, setShowSteps] = useState(false);

  async function act(fn: () => Promise<VoiceBinaryStatus>) {
    setBusy(true);
    try {
      await fn();
      // Push the new state everywhere (wake words reads the same store).
      await refreshVoiceState();
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;
  const working =
    status.state === 'downloading' || status.state === 'extracting' || status.state === 'installing';

  return (
    <div
      style={{
        ...row,
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: 4,
        padding: '8px 10px',
        borderRadius: 8,
        background: status.installed ? 'transparent' : '#101823',
        border: status.installed ? '1px solid transparent' : '1px solid #6b5518',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            textTransform: 'uppercase',
            color: '#8fe3c0',
            border: '1px solid #2f7d5f',
            borderRadius: 999,
            padding: '1px 7px',
          }}
        >
          engine
        </span>
        <strong style={{ fontSize: 12 }}>Speech engine runner (whisper-server)</strong>
        <span style={{ flex: 1 }} />
        {status.installed ? (
          <span style={{ fontSize: 11, color: '#4ade80', fontWeight: 600 }}>
            {status.source === 'path' ? '✓ Found on PATH' : '✓ Installed'}
          </span>
        ) : (
          <span style={{ fontSize: 11, color: '#fbbf24', fontWeight: 600 }}>
            Required for speech-model wakes — not installed
          </span>
        )}
      </div>
      <span style={{ fontSize: 11, color: '#6b7784' }}>
        The executable the on-device speech models run on.{' '}
        {status.assetLabel ? `Downloads: ${status.assetLabel}` : ''}
        {status.assetSizeBytes ? ` (${formatBytes(status.assetSizeBytes)})` : ''}
      </span>
      {status.path ? (
        <span style={{ fontSize: 11, color: '#6b7784' }}>
          Using <code>{status.path}</code>
        </span>
      ) : null}

      {working ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ height: 6, borderRadius: 999, background: '#0f1419', border: '1px solid #2a333d', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${status.downloadPercent ?? 0}%`, background: '#3f6cb0' }} />
          </div>
          <div style={{ display: 'flex', fontSize: 11, color: '#6b7784', alignItems: 'center' }}>
            <span>
              {status.state === 'downloading'
                ? `Downloading… ${status.downloadPercent ?? 0}%`
                : status.state === 'extracting'
                  ? 'Extracting…'
                  : 'Installing…'}
            </span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              style={tinyButton}
              onClick={() => void act(() => bridge.voiceBinaryCancelInstall())}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {status.error && !working ? (
        <span style={{ fontSize: 11, color: '#f2a1a1' }}>{status.error}</span>
      ) : null}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {status.installed ? (
          status.source === 'managed' ? (
            <button
              type="button"
              style={tinyButton}
              disabled={busy}
              onClick={() => void act(() => bridge.voiceBinaryRemove())}
            >
              Remove
            </button>
          ) : null
        ) : status.canInstall ? (
          <button
            type="button"
            style={{ ...button, padding: '3px 12px' }}
            disabled={busy || working}
            onClick={() => void act(() => bridge.voiceBinaryInstall())}
          >
            Install (one click)
          </button>
        ) : null}
        <button type="button" style={tinyButton} onClick={() => setShowSteps((v) => !v)}>
          {showSteps ? 'Hide setup steps' : 'Manual setup'}
        </button>
      </div>

      {showSteps ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            padding: '8px 10px',
            borderRadius: 8,
            background: '#0f1419',
            border: '1px solid #2a333d',
          }}
        >
          {status.instructions.command ? (
            <code style={{ fontSize: 11, color: '#7fb2ff' }}>{status.instructions.command}</code>
          ) : null}
          <ol style={{ margin: 0, paddingLeft: 18, fontSize: 11, color: '#9aa7b5', lineHeight: 1.6 }}>
            {status.instructions.steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </div>
      ) : null}
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
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  // One shared snapshot drives this panel *and* the wake-words panel, so an
  // install here shows up there immediately (and vice versa).
  const snapshot = useVoiceSnapshot();
  const state = snapshot.state;

  const refresh = useCallback(async () => {
    await refreshVoiceState();
  }, []);

  const patch = useCallback(
    async (next: Partial<LocalVoiceSettings>) => {
      setBusy(true);
      setSaved(false);
      try {
        await bridge.localVoiceSetSettings(next);
        await refreshVoiceState();
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
        <h2 style={{ margin: 0, fontSize: 15 }}>Local speech models</h2>
        <p style={{ margin: 0, color: '#6b7784', fontSize: 12 }}>Loading…</p>
      </section>
    );
  }

  const { settings, resources, models } = state;
  const binary = snapshot.binary;
  const sttModels = models.filter((m) => m.kind === 'stt');
  const ttsModels = models.filter((m) => m.kind === 'tts');
  const vadModels = models.filter((m) => m.kind === 'vad');
  const wakeModels = models.filter((m) => m.kind === 'wake');
  const installedStt = sttModels.filter((m) => m.installState === 'installed');
  // The first not-installed speech model is the suggested one to install: the
  // user needs *a* speech model for any-phrase wakes, and any will do.
  const suggestedStt = installedStt[0] ? null : sttModels.find((m) => m.downloadUrl) ?? null;

  return (
    <section style={section}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 15 }}>Local speech models</h2>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          style={tinyButton}
          disabled={busy}
          onClick={() => void bridge.localVoiceRefreshCatalog().then(() => refresh())}
        >
          Refresh catalog
        </button>
      </div>
      <p style={{ margin: 0, color: '#6b7784', fontSize: 11, lineHeight: 1.5 }}>
        Run speech-to-text and text-to-speech on this machine. Models install from public
        repositories (each row links to its source) into <code>{state.modelsDir}</code>. The engine
        loads only while you are talking and unloads after the idle timeout.
      </p>

      {/* A concrete "what to install for wake words" pointer, since a speech model
          + the runner are what make any-phrase wakes work. */}
      {suggestedStt || (binary && !binary.installed) ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
            padding: '8px 10px',
            borderRadius: 8,
            background: '#101823',
            border: '1px solid #2f5c9e',
            fontSize: 11,
            color: '#9aa7b5',
          }}
        >
          <strong style={{ color: '#7fb2ff' }}>To wake on an agent&apos;s name (any phrase)</strong>
          <span>
            {suggestedStt ? (
              <>
                Install a speech model — we suggest <strong>{suggestedStt.label}</strong> (highlighted
                below).
              </>
            ) : (
              'A speech model is installed ✓'
            )}{' '}
            {binary && !binary.installed
              ? 'Then install the speech engine runner below (one click).'
              : 'The speech engine runner is ready ✓'}
          </span>
        </div>
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '2px 0' }}>
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

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <label style={{ ...field, flex: 1, minWidth: 200 }}>
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
        <label style={{ ...field, flex: 1, minWidth: 200 }}>
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
        <label style={{ ...field, minWidth: 180 }}>
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

      <h3 style={{ margin: '4px 0 0', fontSize: 13 }}>Speech-to-text (Whisper)</h3>
      {sttModels.map((m) => (
        <ModelRow
          key={m.id}
          model={m}
          highlight={suggestedStt?.id === m.id}
          onChange={() => void refresh()}
        />
      ))}

      <h3 style={{ margin: '4px 0 0', fontSize: 13 }}>Speech engine runner</h3>
      <p style={{ margin: 0, color: '#6b7784', fontSize: 11 }}>
        A speech model is just weights — it needs an executable to run them. Install the whisper.cpp
        runner here and the on-device models (and any-phrase wakes) become runnable without any
        manual setup.
      </p>
      <VoiceBinaryRow status={binary} />

      <h3 style={{ margin: '4px 0 0', fontSize: 13 }}>Text-to-speech</h3>
      {ttsModels.map((m) => (
        <ModelRow key={m.id} model={m} onChange={() => void refresh()} />
      ))}

      <h3 style={{ margin: '4px 0 0', fontSize: 13 }}>Voice-activity detection (VAD)</h3>
      <p style={{ margin: 0, color: '#6b7784', fontSize: 11 }}>
        Runs locally in the desktop app to detect when you are speaking. Used to gate wake-word
        listening and to end a dictation turn on silence. Never sent to the cloud.
      </p>
      {vadModels.length === 0 ? (
        <span style={{ fontSize: 11, color: '#fbbf24' }}>
          No VAD model in the catalog. Use “Refresh catalog” above to fetch it (a signed-in region
          session is required to list models).
        </span>
      ) : null}
      {vadModels.map((m) => (
        <ModelRow key={m.id} model={m} onChange={() => void refresh()} />
      ))}

      <h3 style={{ margin: '4px 0 0', fontSize: 13 }}>Wake-word models (fixed phrases)</h3>
      <p style={{ margin: 0, color: '#6b7784', fontSize: 11 }}>
        Small on-device keyword models that fire on their own fixed phrase. For any phrase (an
        agent&apos;s name), install a speech model above instead. Detection runs entirely on this
        machine — nothing leaves the device, not even a detection event.
      </p>
      {wakeModels.map((m) => (
        <ModelRow key={m.id} model={m} onChange={() => void refresh()} />
      ))}

      <h3 style={{ margin: '4px 0 0', fontSize: 13 }}>Custom endpoints</h3>
      <p style={{ margin: 0, color: '#6b7784', fontSize: 11 }}>
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
        <button
          type="button"
          style={tinyButton}
          disabled={busy}
          onClick={() => void bridge.localVoiceProbeResources().then(() => refresh())}
        >
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
