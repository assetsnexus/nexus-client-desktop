/**
 * Storage hub shell.
 *
 * A left-nav layout that unifies what used to be three top-bar tabs
 * (Storage / Sync / Mounts) plus the agent workspace/ACL surfaces that lived in
 * Settings → Developer. One rail of sections (`STORAGE_NAV`) and a scrollable
 * detail pane that renders the active section; the rail collapses to a `<select>`
 * on a narrow window via a small CSS media query (no resize listener), exactly
 * like the Settings shell.
 *
 * The shell owns only the header + the current section id. A deep-link
 * (`openStorage`) can request a section (and a prefill path) — e.g. Access → the
 * "Grant access…" action lands on Agent folders with the path already typed.
 */

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { useI18n } from '../../i18n/index.js';
import { ErrorBoundary } from '../ErrorBoundary.js';
import { AccessSection } from './AccessSection.js';
import { FoldersSection } from './FoldersSection.js';
import { MountsSection } from './MountsSection.js';
import { SyncSection } from './SyncSection.js';
import { StorageExplorer } from '../StorageExplorer.js';
import {
  DEFAULT_STORAGE_SECTION,
  STORAGE_NAV,
  StorageNavContext,
  type StorageHubSectionId,
  type StorageNavTarget,
} from './sections.js';

const shell: CSSProperties = {
  height: '100%',
  width: '100%',
  boxSizing: 'border-box',
  minWidth: 0,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  background: '#0d1218',
};

const header: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '14px 20px',
  borderBottom: '1px solid #222b34',
  flexShrink: 0,
};

const body: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
};

const nav: CSSProperties = {
  width: 210,
  flexShrink: 0,
  boxSizing: 'border-box',
  padding: '10px 8px',
  borderRight: '1px solid #222b34',
  overflowY: 'auto',
};

const detail: CSSProperties = {
  flex: 1,
  minWidth: 0,
  boxSizing: 'border-box',
  overflowY: 'auto',
  overflowX: 'hidden',
  padding: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 20,
  maxWidth: 820,
};

function navButton(active: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    width: '100%',
    textAlign: 'left',
    padding: '8px 10px',
    marginBottom: 2,
    borderRadius: 8,
    border: '1px solid transparent',
    background: active ? '#1c2836' : 'transparent',
    color: active ? '#e8eef4' : '#9aa7b5',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: active ? 600 : 500,
  };
}

const doneButton: CSSProperties = {
  marginLeft: 'auto',
  padding: '7px 14px',
  borderRadius: 8,
  border: '1px solid #3a4654',
  background: '#1c2430',
  color: '#e8eef4',
  cursor: 'pointer',
  fontSize: 13,
};

export function StorageHubPanel({
  initialSection = null,
  initialPath = null,
  baseUrl = null,
  onSectionChange,
  onClose,
}: {
  /**
   * Section a deep-link asked for. While non-null the panel follows it; once the
   * user picks a section themselves the panel owns its own state again.
   */
  initialSection?: StorageHubSectionId | null;
  /** Optional path to prefill in the Agent-folders "add" field (Access → Grant). */
  initialPath?: string | null;
  /** Region/gateway origin used to absolutise a relative org logo in Browse. */
  baseUrl?: string | null;
  /** Notify the host so a later deep-link to the same section re-applies. */
  onSectionChange?: (section: StorageHubSectionId) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [active, setActive] = useState<StorageHubSectionId>(
    initialSection ?? DEFAULT_STORAGE_SECTION,
  );
  /** Path handed to Agent folders for prefill; cleared once consumed. */
  const [pendingPath, setPendingPath] = useState<string | null>(initialPath ?? null);
  /**
   * Workspace/folder handed to Mounts for prefill by the explorer's "Mount to
   * system dir" action; cleared once consumed so a later visit starts fresh.
   */
  const [pendingMount, setPendingMount] = useState<{ workspaceId?: string; remoteFolderId?: string } | null>(null);

  // Follow a deep-link that arrives while the panel is already open.
  useEffect(() => {
    if (initialSection) setActive(initialSection);
  }, [initialSection]);
  useEffect(() => {
    if (initialPath) setPendingPath(initialPath);
  }, [initialPath]);

  const selectSection = useCallback(
    (section: StorageHubSectionId) => {
      setActive(section);
      onSectionChange?.(section);
    },
    [onSectionChange],
  );

  const navigate = useCallback(
    ({ section, path, workspaceId, remoteFolderId }: StorageNavTarget) => {
      if (path) setPendingPath(path);
      if (workspaceId || remoteFolderId) setPendingMount({ workspaceId, remoteFolderId });
      selectSection(section);
    },
    [selectSection],
  );

  const activeEntry = STORAGE_NAV.find((entry) => entry.id === active) ?? STORAGE_NAV[0];

  return (
    <div style={shell}>
      <div style={header}>
        <h1 style={{ margin: 0, fontSize: 17 }}>{t('storage.title')}</h1>
        <button type="button" style={doneButton} onClick={onClose}>
          {t('storage.done')}
        </button>
      </div>

      {/* Collapse the rail to a select on a narrow window — CSS-only. */}
      <style>{`
        .nexus-storage-nav { display: block; }
        .nexus-storage-select { display: none; }
        @media (max-width: 720px) {
          .nexus-storage-nav { display: none; }
          .nexus-storage-select { display: block; margin: 10px 20px 0; }
        }
      `}</style>

      <select
        className="nexus-storage-select"
        style={{
          padding: '8px 10px',
          borderRadius: 8,
          border: '1px solid #3a4654',
          background: '#0f1419',
          color: '#e8eef4',
          fontSize: 13,
        }}
        value={active}
        onChange={(e) => selectSection(e.target.value as StorageHubSectionId)}
      >
        {STORAGE_NAV.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.icon} {t(entry.labelKey)}
          </option>
        ))}
      </select>

      <div style={body}>
        <nav className="nexus-storage-nav" style={nav}>
          {STORAGE_NAV.map((entry) => (
            <button
              key={entry.id}
              type="button"
              style={navButton(entry.id === active)}
              onClick={() => selectSection(entry.id)}
              title={entry.helpKey ? t(entry.helpKey) : undefined}
            >
              <span aria-hidden>{entry.icon}</span>
              <span>{t(entry.labelKey)}</span>
            </button>
          ))}
        </nav>

        {/* Browse is the full-height explorer (it owns its own workspace rail and
            detail column), so it escapes the max-width card column. */}
        {active === 'browse' ? (
          <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
            <ErrorBoundary key="browse" label={t('storage.nav.browse')}>
              <StorageExplorer baseUrl={baseUrl} />
            </ErrorBoundary>
          </div>
        ) : (
          <div style={detail}>
            <ErrorBoundary key={activeEntry.id} label={t(activeEntry.labelKey)}>
              <StorageNavContext.Provider value={navigate}>
                {active === 'mounts' ? (
                  <MountsSection
                    initialWorkspaceId={pendingMount?.workspaceId ?? null}
                    initialRemoteFolderId={pendingMount?.remoteFolderId ?? null}
                    onPrefillConsumed={() => setPendingMount(null)}
                  />
                ) : null}
                {active === 'sync' ? <SyncSection /> : null}
                {active === 'folders' ? (
                  <FoldersSection
                    initialPath={pendingPath}
                    onPathConsumed={() => setPendingPath(null)}
                  />
                ) : null}
                {active === 'access' ? <AccessSection /> : null}
              </StorageNavContext.Provider>
            </ErrorBoundary>
          </div>
        )}
      </div>
    </div>
  );
}
