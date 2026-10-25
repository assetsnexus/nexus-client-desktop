/**
 * Companion avatar gallery (Deliverable 2).
 *
 * The gallery used to be a dead end — it could only offer whatever VRM the agent
 * happened to have configured. It is now a real, locally-maintained library:
 *
 *  - the agent's usable models (its configured VRM + verified catalog rows) and
 *    this device's own imported models (`nexus-avatar://…`) share one list;
 *  - "Add model" opens the native file picker (main copies the file into the
 *    library), "Remove" deletes a local entry, and picking a tile applies it;
 *  - a footer links to Settings for the client-remembered **agent ↔ avatar**
 *    mapping, which is per contact so several companions stay independent.
 *
 * Split from `CompanionView` so the gallery's own state (the local library, busy
 * flags, per-tile actions) does not bloat the companion view.
 */

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { CachedAvatarImage } from '@nexus/character-react';
import {
  bridge,
  callBridge,
  hasBridgeMethod,
  type LocalAvatarsConfig,
} from '../bridge.js';
import type {
  CompanionAvatarChoice,
  ResolvedCompanionAvatar,
} from '../companion/avatar-gallery.js';

const panel: CSSProperties = {
  position: 'absolute',
  top: 42,
  left: 8,
  zIndex: 20,
  width: 'min(380px, calc(100% - 16px))',
  maxHeight: '72%',
  overflowY: 'auto',
  padding: 10,
  borderRadius: 10,
  border: '1px solid #2a333d',
  background: 'rgba(15,20,26,0.98)',
  boxShadow: '0 8px 30px rgba(0,0,0,0.45)',
};

const btn: CSSProperties = {
  padding: '4px 9px',
  borderRadius: 8,
  border: '1px solid #3a4654',
  background: '#1c2430',
  color: '#e8eef4',
  cursor: 'pointer',
  fontSize: 12,
};

const btnActive: CSSProperties = {
  ...btn,
  border: '1px solid #3f6cb0',
  background: '#2f5c9e',
  color: '#fff',
};

const tile: CSSProperties = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  justifyContent: 'flex-start',
};

const muted: CSSProperties = { fontSize: 10, color: '#9aa7b5' };

const thumb = (active: boolean): CSSProperties => ({
  width: 32,
  height: 32,
  borderRadius: 6,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: '#0f141a',
  border: active ? '1px solid #3f6cb0' : '1px solid #2a333d',
  flexShrink: 0,
});

export type CompanionAvatarGalleryProps = {
  choices: CompanionAvatarChoice[];
  resolved: ResolvedCompanionAvatar | null;
  /** Apply a tile (persists the selection as presence + local pref). */
  onChoose: (choice: CompanionAvatarChoice) => void;
  onClose: () => void;
  /**
   * Ask the shell window to open its Settings surface (the agent ↔ avatar
   * mapping lives there). Optional so a headless/test host can omit it.
   */
  onOpenSettings?: () => void;
  /**
   * Called after the library changed (an import or a removal) with the new
   * config, so the parent can rebuild its choices without a focus round-trip.
   */
  onLibraryChange?: (config: LocalAvatarsConfig) => void;
};

/**
 * The gallery card. Owns the local-library read/add/remove cycle; the *selection*
 * stays with the parent (it also writes presence), so this is a mostly
 * presentational surface with one piece of local state.
 */
export function CompanionAvatarGallery({
  choices,
  resolved,
  onChoose,
  onClose,
  onOpenSettings,
  onLibraryChange,
}: CompanionAvatarGalleryProps) {
  const [local, setLocal] = useState<LocalAvatarsConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The bridge method may be missing on a preload that predates this feature
  // (renderer reload without a main restart) — the library then hides itself
  // instead of throwing.
  const hasLocalLibrary = hasBridgeMethod(bridge, 'localAvatarsList');

  useEffect(() => {
    if (!hasLocalLibrary) return;
    let cancelled = false;
    void callBridge<LocalAvatarsConfig | null>(bridge, 'localAvatarsList', null).then((config) => {
      if (!cancelled) setLocal(config);
    });
    return () => {
      cancelled = true;
    };
  }, [hasLocalLibrary]);

  const pick = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await bridge.localAvatarsPick();
      setLocal(next);
      onLibraryChange?.(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not import that file.');
    } finally {
      setBusy(false);
    }
  }, [onLibraryChange]);

  const remove = useCallback(async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const next = await bridge.localAvatarsRemove(id);
      setLocal(next);
      onLibraryChange?.(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove that entry.');
    } finally {
      setBusy(false);
    }
  }, [onLibraryChange]);

  const libraryCount = local?.avatars.length ?? 0;

  return (
    <div style={panel} role="dialog" aria-label="Avatar gallery">
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8, gap: 6 }}>
        <strong style={{ fontSize: 12 }}>Avatar library</strong>
        <span style={{ flex: 1 }} />
        <button type="button" style={btn} onClick={onClose} aria-label="Close gallery">
          ×
        </button>
      </div>

      {hasLocalLibrary ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <button
            type="button"
            style={btn}
            disabled={busy}
            onClick={() => void pick()}
            title="Pick a .vrm or .glb from this computer"
          >
            {busy ? 'Importing…' : '+ Add model'}
          </button>
          <span style={muted}>
            {libraryCount === 0
              ? 'No models in your library yet.'
              : `${libraryCount} model${libraryCount === 1 ? '' : 's'} in your library`}
          </span>
        </div>
      ) : null}

      {error ? (
        <p style={{ fontSize: 11, color: '#f2a1a1', margin: '0 0 8px' }}>{error}</p>
      ) : null}

      {choices.length === 0 ? (
        <p style={{ ...muted, fontSize: 12, margin: 0 }}>
          {hasLocalLibrary
            ? 'No avatar yet. Add a .vrm or .glb from this computer, or keep the profile image.'
            : 'No avatar yet. Upload a VRM in the main window’s chat config, or keep the profile image.'}
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
          {choices.map((choice) => {
            const active = choice.id === resolved?.choice.id;
            return (
              <li key={choice.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <button
                  type="button"
                  style={{ ...(active ? btnActive : btn), ...tile }}
                  onClick={() => onChoose(choice)}
                  aria-pressed={active}
                >
                  {choice.kind === 'image' && choice.url ? (
                    <CachedAvatarImage
                      src={choice.url}
                      alt=""
                      style={{ width: 32, height: 32, borderRadius: 6, objectFit: 'cover' }}
                      fallback={'🖼'}
                    />
                  ) : (
                    <span style={thumb(active)} aria-hidden>
                      🧍
                    </span>
                  )}
                  <span
                    style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 0 }}
                  >
                    <span
                      style={{
                        fontSize: 12,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        maxWidth: 220,
                      }}
                    >
                      {choice.label}
                    </span>
                    <span style={muted}>
                      {choice.kind === 'vrm'
                        ? choice.local
                          ? '3D model · local library'
                          : '3D model (VRM)'
                        : 'profile image'}
                      {active ? ' · in use' : ''}
                    </span>
                  </span>
                </button>
                {choice.local && choice.localAvatarId && hasLocalLibrary ? (
                  <button
                    type="button"
                    style={btn}
                    disabled={busy}
                    aria-label={`Remove ${choice.label} from the library`}
                    title="Remove from your library"
                    onClick={() => void remove(choice.localAvatarId!)}
                  >
                    Remove
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <div
        style={{
          marginTop: 10,
          paddingTop: 8,
          borderTop: '1px solid #222b34',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span style={{ ...muted, flex: 1 }}>
          Remember which model each agent uses in Settings.
        </span>
        <button
          type="button"
          style={btn}
          onClick={() => onOpenSettings?.()}
          title="Open Settings to map agents to library models"
        >
          Manage mappings
        </button>
      </div>
    </div>
  );
}
