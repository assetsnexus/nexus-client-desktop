/**
 * Settings → Local models.
 *
 * The user configures 0..n local model instances (several Ollama boxes, a ComfyUI
 * rig, …) and how a job is routed across them. Each instance carries its own TLS
 * policy: a self-signed `https` server on the user's own network needs either an
 * explicit "ignore TLS" opt-in or a PEM CA bundle to trust.
 *
 * Everything is probed on this machine by the main process — region node and
 * inference are cloud stacks. A dead instance simply drops out of rotation.
 */

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import {
  bridge,
  type LocalModelBackend,
  type LocalModelBackendKind,
  type LocalModelBackendStatus,
  type LocalModelsConfig,
  type LocalModelsRoutingPolicy,
  type LocalModelsSnapshot,
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

const card: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: 12,
  borderRadius: 10,
  background: '#0f1419',
  border: '1px solid #2a333d',
};

const healthColors: Record<string, string> = {
  healthy: '#4ade80',
  unreachable: '#f2a1a1',
  disabled: '#8b95a1',
  checking: '#fbbf24',
  unknown: '#8b95a1',
};

function HealthChip({ health }: { health: string }) {
  const color = healthColors[health] ?? '#8b95a1';
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        color,
        border: `1px solid ${color}`,
        borderRadius: 999,
        padding: '2px 8px',
        textTransform: 'uppercase',
        letterSpacing: 0.4,
        whiteSpace: 'nowrap',
      }}
    >
      {health}
    </span>
  );
}

const POLICIES: { id: LocalModelsRoutingPolicy; label: string; help: string }[] = [
  {
    id: 'first_available',
    label: 'First available',
    help: 'Send each job to the first idle, healthy instance (in the order below).',
  },
  {
    id: 'least_busy',
    label: 'Least busy',
    help: 'Prefer the healthy instance with the fewest loaded/queued jobs.',
  },
  {
    id: 'round_robin',
    label: 'Round robin',
    help: 'Rotate through the healthy instances one job at a time.',
  },
];

function newInstanceId(kind: LocalModelBackendKind): string {
  return `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** A blank instance for the "Add" flow, defaulting to a loopback Ollama box. */
function blankInstance(): LocalModelBackend {
  return {
    id: newInstanceId('ollama'),
    kind: 'ollama',
    label: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434',
    enabled: true,
    ignoreTls: false,
    apiKey: null,
    customCaPem: null,
  };
}

/** One editable instance card with staged edits + a Test button. */
function InstanceCard({
  instance,
  status,
  busy,
  onSave,
  onRemove,
}: {
  instance: LocalModelBackend;
  status: LocalModelBackendStatus | undefined;
  busy: boolean;
  onSave: (next: LocalModelBackend) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState<LocalModelBackend>(instance);
  const [testResult, setTestResult] = useState<LocalModelBackendStatus | null>(null);
  const [testing, setTesting] = useState(false);

  // Re-sync when the persisted instance changes underneath us (e.g. after a save).
  useEffect(() => {
    setDraft(instance);
  }, [instance]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(instance);
  const isHttps = /^https:\/\//i.test(draft.baseUrl.trim());
  const shown = testResult ?? status;

  async function runTest() {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await bridge.localModelsTest(draft));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <label style={{ ...field, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
          />
          <span style={{ color: '#e8eef4', fontWeight: 600 }}>{draft.label || 'Untitled instance'}</span>
        </label>
        {shown ? <HealthChip health={shown.health} /> : null}
        {shown?.busy ? (
          <span style={{ fontSize: 11, color: '#fbbf24' }} title="Reports in-flight work">
            busy
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          style={{ ...ghostButton, padding: '3px 10px' }}
          disabled={busy}
          onClick={onRemove}
        >
          Remove
        </button>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <label style={{ ...field, flex: 1, minWidth: 180 }}>
          <span>Label</span>
          <input
            style={input}
            value={draft.label}
            disabled={busy}
            placeholder="GPU box"
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          />
        </label>
        <label style={{ ...field, minWidth: 150 }}>
          <span>Kind</span>
          <select
            style={input}
            value={draft.kind}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, kind: e.target.value as LocalModelBackendKind })}
          >
            <option value="ollama">Ollama</option>
            <option value="comfyui">ComfyUI</option>
          </select>
        </label>
      </div>

      <label style={field}>
        <span>Base URL</span>
        <input
          style={input}
          value={draft.baseUrl}
          disabled={busy}
          placeholder="http://127.0.0.1:11434"
          onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
        />
      </label>

      <label style={field}>
        <span>API key (optional)</span>
        <input
          style={input}
          value={draft.apiKey ?? ''}
          disabled={busy}
          placeholder="Bearer token for a protected instance"
          onChange={(e) => setDraft({ ...draft, apiKey: e.target.value || null })}
        />
      </label>

      {isHttps ? (
        <>
          <label style={{ ...field, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <input
              type="checkbox"
              checked={draft.ignoreTls}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, ignoreTls: e.target.checked })}
            />
            <span>
              Ignore TLS errors (self-signed certificate). Only for a server you trust on your own
              network.
            </span>
          </label>
          {!draft.ignoreTls ? (
            <label style={field}>
              <span>Custom CA (PEM, optional — trust a private CA instead of ignoring TLS)</span>
              <textarea
                style={{ ...input, minHeight: 70, fontFamily: 'monospace' }}
                value={draft.customCaPem ?? ''}
                disabled={busy}
                placeholder="-----BEGIN CERTIFICATE-----"
                onChange={(e) => setDraft({ ...draft, customCaPem: e.target.value || null })}
              />
            </label>
          ) : null}
        </>
      ) : null}

      {shown?.models.length ? (
        <ul style={{ margin: 0, paddingLeft: 18, color: '#9aa7b5', fontSize: 12 }}>
          {shown.models.slice(0, 12).map((m) => (
            <li key={m.id}>{m.name}</li>
          ))}
          {shown.models.length > 12 ? <li>… {shown.models.length - 12} more</li> : null}
        </ul>
      ) : shown?.detail ? (
        <span style={{ fontSize: 11, color: '#6b7784' }}>{shown.detail}</span>
      ) : null}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          style={button}
          disabled={busy || !dirty}
          onClick={() => onSave(draft)}
        >
          {dirty ? 'Save instance' : 'Saved'}
        </button>
        <button type="button" style={ghostButton} disabled={busy || testing} onClick={() => void runTest()}>
          {testing ? 'Testing…' : 'Test'}
        </button>
        {dirty ? <span style={{ fontSize: 11, color: '#fbbf24' }}>Unsaved changes</span> : null}
      </div>
    </div>
  );
}

export function LocalModelsPanel() {
  const [config, setConfig] = useState<LocalModelsConfig | null>(null);
  const [snapshot, setSnapshot] = useState<LocalModelsSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [next, probed] = await Promise.all([bridge.localModelsGetConfig(), bridge.listLocalModels(true)]);
    setConfig(next);
    setSnapshot(probed);
  }, []);

  useEffect(() => {
    void refresh();
    // Refresh so the up/busy chips stay current while the panel is open.
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [refresh]);

  const persist = useCallback(
    async (fn: () => Promise<LocalModelsConfig>) => {
      setBusy(true);
      setError(null);
      try {
        setConfig(await fn());
        setSnapshot(await bridge.listLocalModels(true));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not save.');
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  if (!config) {
    return (
      <section style={section}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Local models</h2>
        <p style={{ margin: 0, color: '#6b7784', fontSize: 12 }}>Loading…</p>
      </section>
    );
  }

  const statusById = new Map((snapshot?.backends ?? []).map((s) => [s.backend.id, s]));
  const routed = snapshot?.routedBackendId
    ? config.instances.find((i) => i.id === snapshot.routedBackendId)
    : null;

  return (
    <section style={section}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Local models</h2>
        <span style={{ flex: 1 }} />
        <button type="button" style={ghostButton} disabled={busy} onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      <p style={{ margin: 0, color: '#6b7784', fontSize: 12 }}>
        Ollama and ComfyUI instances on this machine or your own network. Add as many as you like;
        jobs are routed across the healthy, idle ones. Each instance can use a self-signed{' '}
        <code>https</code> endpoint with an explicit TLS opt-in or a custom CA.
      </p>

      <label style={field}>
        <span>Routing across instances</span>
        <select
          style={input}
          value={config.policy}
          disabled={busy}
          onChange={(e) =>
            void persist(() =>
              bridge.localModelsSetPolicy(e.target.value as LocalModelsRoutingPolicy),
            )
          }
        >
          {POLICIES.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <span style={{ color: '#6b7784' }}>
          {POLICIES.find((p) => p.id === config.policy)?.help}
        </span>
      </label>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <HealthChip health={routed ? 'healthy' : 'disabled'} />
        <span style={{ color: '#6b7784', fontSize: 12 }}>
          {routed ? `Next job routes to “${routed.label}”` : 'No healthy instance to route to'}
        </span>
      </div>

      {config.instances.map((instance) => (
        <InstanceCard
          key={instance.id}
          instance={instance}
          status={statusById.get(instance.id)}
          busy={busy}
          onSave={(next) => void persist(() => bridge.localModelsUpsert(next))}
          onRemove={() => void persist(() => bridge.localModelsRemove(instance.id))}
        />
      ))}

      {!config.instances.length ? (
        <p style={{ margin: 0, color: '#6b7784', fontSize: 12 }}>
          No instances configured. ComfyUI is a preview: Ollama exposes model listing and load
          state, ComfyUI exposes health and its queue.
        </p>
      ) : null}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button
          type="button"
          style={button}
          disabled={busy}
          onClick={() => void persist(() => bridge.localModelsUpsert(blankInstance()))}
        >
          Add an instance
        </button>
        {error ? <span style={{ color: '#f87171', fontSize: 12 }}>{error}</span> : null}
      </div>
    </section>
  );
}
