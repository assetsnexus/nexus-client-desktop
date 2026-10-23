import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import {
  bridge,
  isSafeExternalUrl,
  MAX_CUSTOM_TRAY_APPS,
  type AppVisibilityMode,
  type CustomTrayApp,
  type InstalledNexusApp,
  type TrayAppItem,
  type TrayAppSettings,
} from '../bridge.js';

/**
 * Settings → "Nexus apps".
 *
 * Lets the user shape the tray context-menu app list: a mode toggle
 * (block-list vs allow-list), per-app visibility toggles over the apps the
 * region reports as *installed* (connected via Login with ANX), and custom
 * label+URL entries that are always shown.
 *
 * All validation lives in the main process settings store (URLs must be
 * http/https); this panel mirrors the checks only to give immediate feedback and
 * then renders whatever main persisted, so the two can never disagree.
 *
 * The bridge may be absent in a bare renderer (tests / non-Electron); every call
 * goes through `optional` so the panel degrades to an explanation instead of
 * throwing.
 */

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
  padding: '8px 0',
  borderTop: '1px solid #222b34',
};

const hint: CSSProperties = { margin: 0, color: '#6b7784', fontSize: 12 };
const errorText: CSSProperties = { color: '#f2a1a1', fontSize: 12 };

function optional<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return fn().catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}

export function NexusAppsPanel() {
  const [settings, setSettings] = useState<TrayAppSettings | null>(null);
  const [installed, setInstalled] = useState<InstalledNexusApp[] | null>(null);
  const [preview, setPreview] = useState<TrayAppItem[] | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState(false);

  const [newLabel, setNewLabel] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [ui, auth, apps, resolved] = await Promise.all([
      optional(() => bridge.getUiSettings()),
      optional(() => bridge.getAuthState()),
      optional(() => bridge.trayListApps()),
      optional(() => bridge.trayResolvedApps()),
    ]);
    const isSignedIn = auth?.status === 'signed_in';
    setSignedIn(isSignedIn);
    if (ui) setSettings(ui.trayApps);
    // The tray handlers return [] / custom-only when signed out, so an unauth
    // result is still a real answer, not a failure.
    setInstalled(isSignedIn ? (apps ?? []) : []);
    setPreview(resolved);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const patch = useCallback(
    async (next: Partial<TrayAppSettings>) => {
      if (!settings) return;
      setBusy(true);
      try {
        const ui = await optional(() => bridge.setUiSettings({ trayApps: { ...settings, ...next } }));
        if (ui) setSettings(ui.trayApps);
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [settings, refresh],
  );

  if (!settings) {
    return (
      <section style={section}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Nexus apps</h2>
        <p style={hint}>Loading…</p>
      </section>
    );
  }

  const listKey: 'allow' | 'deny' = settings.mode === 'allow' ? 'allow' : 'deny';
  const listed = new Set(settings[listKey]);

  function isVisible(clientId: string): boolean {
    // In allow mode an empty list means "unrestricted", matching the resolver.
    if (settings!.mode === 'allow') return listed.size === 0 || listed.has(clientId);
    return !listed.has(clientId);
  }

  function toggleApp(clientId: string) {
    const next = new Set(listed);
    if (next.has(clientId)) next.delete(clientId);
    else next.add(clientId);
    void patch({ [listKey]: Array.from(next) } as Partial<TrayAppSettings>);
  }

  function addCustom() {
    const url = newUrl.trim();
    const label = newLabel.trim();
    if (!label) {
      setFormError('Enter a label and a valid http(s) URL.');
      return;
    }
    // Mirror the main-process guard so an invalid URL never round-trips.
    if (!isSafeExternalUrl(url)) {
      setFormError('Enter a label and a valid http(s) URL.');
      return;
    }
    setFormError(null);
    const entry: CustomTrayApp = {
      id: `c-${Date.now()}-${settings!.custom.length}`,
      label,
      url,
    };
    setNewLabel('');
    setNewUrl('');
    void patch({ custom: [...settings!.custom, entry] });
  }

  function removeCustom(id: string) {
    void patch({ custom: settings!.custom.filter((c) => c.id !== id) });
  }

  return (
    <section style={section}>
      <h2 style={{ margin: 0, fontSize: 16 }}>Nexus apps</h2>
      <p style={hint}>
        Apps you connected with <strong>Login with ANX</strong> appear under “Nexus apps” in the tray
        icon menu. Choose whether to allow or block each app, and pin your own links.
      </p>

      <label style={field}>
        <span>Mode</span>
        <select
          style={input}
          value={settings.mode}
          disabled={busy}
          onChange={(e) => void patch({ mode: e.target.value as AppVisibilityMode })}
        >
          <option value="deny">Block listed apps (show the rest)</option>
          <option value="allow">Allow listed apps only</option>
        </select>
      </label>
      {settings.mode === 'allow' && settings.allow.length === 0 ? (
        <p style={hint}>No apps allowed yet — the list stays unrestricted until you add one.</p>
      ) : null}

      <div>
        <strong style={{ fontSize: 13 }}>Installed apps</strong>
        {!signedIn ? (
          <p style={hint}>Sign in to see the apps connected to your account.</p>
        ) : installed === null ? (
          <p style={hint}>Loading…</p>
        ) : installed.length === 0 ? (
          <p style={hint}>
            No connected apps found. Apps you connect with Login with ANX will show up here.
          </p>
        ) : (
          installed.map((app) => (
            <div key={app.clientId} style={row}>
              <strong style={{ fontSize: 13 }}>{app.label}</strong>
              {app.orgName ? <span style={hint}>{app.orgName}</span> : null}
              <span style={{ flex: 1 }} />
              <span style={{ ...hint, color: isVisible(app.clientId) ? '#4ade80' : '#8b95a1' }}>
                {isVisible(app.clientId) ? 'Shown' : 'Hidden'}
              </span>
              <button
                type="button"
                style={{ ...ghostButton, padding: '4px 10px' }}
                disabled={busy}
                onClick={() => toggleApp(app.clientId)}
              >
                {isVisible(app.clientId) ? 'Hide' : 'Show'}
              </button>
            </div>
          ))
        )}
      </div>

      <div>
        <strong style={{ fontSize: 13 }}>Custom entries</strong>
        <p style={hint}>
          Label + URL entries always shown in the tray app list, in the order added. Only http/https
          links are accepted.
        </p>
        {settings.custom.length ? (
          settings.custom.map((entry) => (
            <div key={entry.id} style={row}>
              <strong style={{ fontSize: 13 }}>{entry.label}</strong>
              <span style={hint}>{entry.url}</span>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                style={{ ...ghostButton, padding: '4px 10px' }}
                disabled={busy}
                onClick={() => removeCustom(entry.id)}
              >
                Remove
              </button>
            </div>
          ))
        ) : (
          <p style={hint}>No custom entries yet.</p>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <input
            style={{ ...input, flex: '0 0 160px' }}
            value={newLabel}
            placeholder="Label"
            onChange={(e) => setNewLabel(e.target.value)}
          />
          <input
            style={{ ...input, flex: 1 }}
            value={newUrl}
            placeholder="https://example.com"
            onChange={(e) => setNewUrl(e.target.value)}
          />
          <button
            type="button"
            style={button}
            disabled={busy || settings.custom.length >= MAX_CUSTOM_TRAY_APPS}
            onClick={addCustom}
          >
            Add
          </button>
        </div>
        {formError ? <p style={{ ...hint, ...errorText }}>{formError}</p> : null}
      </div>

      <div>
        <strong style={{ fontSize: 13 }}>Tray preview</strong>
        {preview && preview.length > 0 ? (
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: '#9aa7b5', fontSize: 12 }}>
            {preview.map((item) => (
              <li key={item.id}>
                {item.label}
                {item.orgName ? ` · ${item.orgName}` : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p style={hint}>Nothing will appear under “Nexus apps” yet.</p>
        )}
      </div>
    </section>
  );
}
