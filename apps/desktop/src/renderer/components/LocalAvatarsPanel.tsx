/**
 * Settings → Local avatars.
 *
 * The companion's avatar gallery links here for the client-remembered
 * **agent (contact) ↔ library model** mapping (Deliverable 2). This panel is the
 * canonical place to curate the library and map it:
 *
 *  - the library list (imported `.vrm` / `.glb` models) with "Add model" (the
 *    native file picker) and per-entry removal;
 *  - a per-agent mapping table so several companions each render their own model
 *    (a mapping is deliberately per contact, never one global avatar);
 *  - both persist through the local-avatar store, so the companion picks the
 *    mapping up the next time it resolves its avatar.
 *
 * Kept its own component (not folded into `SettingsPanel`) so the settings view
 * stays readable and the mapping logic is unit-testable in isolation.
 */

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import {
  bridge,
  callBridge,
  hasBridgeMethod,
  type LocalAvatarsConfig,
  type WakeAgentRow,
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

const ghost: CSSProperties = {
  ...button,
  background: '#1c2430',
  borderColor: '#3a4654',
  color: '#e8eef4',
  fontWeight: 500,
  padding: '4px 10px',
};

const select: CSSProperties = {
  padding: '6px 8px',
  borderRadius: 8,
  border: '1px solid #3a4654',
  background: '#0f1419',
  color: '#e8eef4',
  fontSize: 13,
  minWidth: 200,
};

const row: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 0',
  borderTop: '1px solid #222b34',
};

const muted: CSSProperties = { color: '#6b7784', fontSize: 12 };

export function LocalAvatarsPanel() {
  const [config, setConfig] = useState<LocalAvatarsConfig | null>(null);
  const [agents, setAgents] = useState<WakeAgentRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The bridge method may be absent on a preload that predates this feature; the
  // panel then hides itself rather than throwing.
  const available = hasBridgeMethod(bridge, 'localAvatarsList');

  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    void callBridge<LocalAvatarsConfig | null>(bridge, 'localAvatarsList', null).then((next) => {
      if (!cancelled) setConfig(next ?? { avatars: [], contactMappings: {} });
    });
    // The agent list is the same one the wake settings use (owned + shared), so a
    // mapping can be created for any agent a wake can address.
    void callBridge<WakeAgentRow[]>(bridge, 'wakeListAgents', []).then((rows) => {
      if (!cancelled) setAgents(Array.isArray(rows) ? rows : []);
    });
    return () => {
      cancelled = true;
    };
  }, [available]);

  const pick = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setConfig(await bridge.localAvatarsPick());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not import that file.');
    } finally {
      setBusy(false);
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      setConfig(await bridge.localAvatarsRemove(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove that entry.');
    } finally {
      setBusy(false);
    }
  }, []);

  const map = useCallback(async (contactId: string, avatarId: string | null) => {
    setBusy(true);
    setError(null);
    try {
      setConfig(await bridge.localAvatarsSetMapping(contactId, avatarId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that mapping.');
    } finally {
      setBusy(false);
    }
  }, []);

  if (!available) {
    return (
      <section style={section}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Local avatars</h2>
        <p style={muted}>
          The local avatar library needs a newer app build. Restart the app to enable it.
        </p>
      </section>
    );
  }

  const avatars = config?.avatars ?? [];
  const mappings = config?.contactMappings ?? {};

  return (
    <section style={section}>
      <h2 style={{ margin: 0, fontSize: 16 }}>Local avatars</h2>
      <p style={muted}>
        Import <code>.vrm</code> / <code>.glb</code> models from this computer and choose which
        model each agent renders with. The library and the mapping live only on this device.
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button type="button" style={button} disabled={busy} onClick={() => void pick()}>
          {busy ? 'Importing…' : '+ Add model'}
        </button>
        <span style={muted}>
          {avatars.length === 0
            ? 'No models in your library yet.'
            : `${avatars.length} model${avatars.length === 1 ? '' : 's'}`}
        </span>
      </div>

      {error ? <span style={{ color: '#f2a1a1', fontSize: 12 }}>{error}</span> : null}

      {avatars.length === 0 ? (
        <p style={muted}>Add a model to map it to an agent below.</p>
      ) : (
        avatars.map((avatar) => (
          <div key={avatar.id} style={row}>
            <strong style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{avatar.label}</strong>
            <span style={muted}>
              {avatar.kind.toUpperCase()} · {Math.max(1, Math.round(avatar.sizeBytes / 1024))} KB
            </span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              style={ghost}
              disabled={busy}
              aria-label={`Remove ${avatar.label} from the library`}
              onClick={() => void remove(avatar.id)}
            >
              Remove
            </button>
          </div>
        ))
      )}

      <h3 style={{ margin: '8px 0 0', fontSize: 13 }}>Agent → model</h3>
      {agents.length === 0 ? (
        <p style={muted}>Sign in to list agents and map a model to each.</p>
      ) : (
        agents.map((agent) => {
          const mapped = mappings[agent.contactId] ?? '';
          // A mapping that points at a removed model is shown as unmapped so the
          // select never displays a value that is not one of its options.
          const known = avatars.some((a) => a.id === mapped);
          return (
            <div key={agent.contactId} style={row}>
              <strong style={{ fontSize: 13 }}>{agent.name}</strong>
              {!agent.canConfigure ? <span style={muted}>shared</span> : null}
              <span style={{ flex: 1 }} />
              <select
                style={select}
                value={known ? mapped : ''}
                disabled={busy}
                onChange={(e) => void map(agent.contactId, e.target.value || null)}
              >
                <option value="">Default (agent’s own avatar)</option>
                {avatars.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>
          );
        })
      )}
    </section>
  );
}
