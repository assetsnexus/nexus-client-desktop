/**
 * Storage hub → Access (preview + edit).
 *
 * Answers "which agents can reach this path / mount / sync / folder?" — three
 * lenses over the same catalog:
 *   1. by agent   — the roots (and modes) an agent can use,
 *   2. by path    — the covering root(s) and the agents each grants,
 *   3. mounts/syncs — bucket projections resolved by the local dir they land on.
 *
 * The preview is pure on the main side (`toolsPreviewAccess`), keyed on the same
 * workspace catalog the sandbox enforces, so it cannot over-claim. Agents only
 * ever touch local paths, so cloud reachability is always shown through the local
 * dir a mount/sync is projected to. A "Grant access…" action deep-links to Agent
 * folders with the path prefilled.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  bridge,
  type AccessPreview,
  type MountSnapshot,
  type StorageSyncState,
  type ToolsConfig,
  type WakeAgentRow,
  type WorkspaceRoot,
} from '../../bridge.js';
import { useI18n } from '../../i18n/index.js';
import { Field, SectionCard, settingsButton, settingsGhostButton, settingsInput, settingsMuted } from '../settings/settings-ui.js';
import { useStorageNav } from './sections.js';

const ANY_AGENT = '*';

function agentIdsOf(root: WorkspaceRoot): string[] {
  const ids = Array.isArray(root.agentContactIds) ? root.agentContactIds : [];
  return ids.length ? ids : [ANY_AGENT];
}

export function AccessSection() {
  const { t } = useI18n();
  const navigate = useStorageNav();
  const [tools, setTools] = useState<ToolsConfig | null>(null);
  const [agents, setAgents] = useState<WakeAgentRow[]>([]);
  const [path, setPath] = useState('');
  const [preview, setPreview] = useState<AccessPreview | null>(null);
  const [mounts, setMounts] = useState<MountSnapshot | null>(null);
  const [syncs, setSyncs] = useState<StorageSyncState | null>(null);

  useEffect(() => {
    void bridge.getToolsConfig().then(setTools);
    void bridge.wakeListAgents().then(setAgents).catch(() => setAgents([]));
    void bridge.mountSnapshot().then(setMounts).catch(() => setMounts(null));
    void bridge.syncGetState().then(setSyncs).catch(() => setSyncs(null));
  }, []);

  const check = useCallback(async (value: string) => {
    try {
      setPreview(await bridge.toolsPreviewAccess({ path: value }));
    } catch {
      setPreview(null);
    }
  }, []);

  const roots = tools?.workspaces ?? [];
  const nameOf = (contactId: string) =>
    agents.find((a) => a.contactId === contactId)?.name ?? contactId;

  /** Bucket projections: mounts + syncs, each with the local dir it lands on. */
  const projections = [
    ...(mounts?.sessions ?? []).map((s) => ({ kind: 'mount' as const, label: s.workspaceName ?? s.workspaceId, dir: s.mountpoint })),
    ...(syncs?.bindings ?? []).map((b) => ({ kind: 'sync' as const, label: b.name, dir: b.localDir })),
  ];
  const [projPreview, setProjPreview] = useState<Record<string, AccessPreview>>({});
  useEffect(() => {
    void (async () => {
      const entries = await Promise.all(
        projections.map(async (p) => {
          try {
            return [p.dir, await bridge.toolsPreviewAccess({ path: p.dir })] as const;
          } catch {
            return null;
          }
        }),
      );
      setProjPreview(Object.fromEntries(entries.filter((e): e is readonly [string, AccessPreview] => e != null)));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tools, mounts, syncs]);

  return (
    <>
      <SectionCard title={t('storage.access.byPath')} help={t('storage.access.help')}>
        <Field label={t('storage.access.pathPlaceholder')}>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              style={{ ...settingsInput, flex: 1 }}
              value={path}
              placeholder={t('storage.access.pathPlaceholder')}
              onChange={(e) => setPath(e.target.value)}
            />
            <button type="button" style={settingsGhostButton} onClick={() => void check(path)}>
              {t('storage.access.check')}
            </button>
          </div>
        </Field>
        {preview ? (
          preview.reachable ? (
            <div>
              <p style={{ ...settingsMuted, margin: '0 0 4px' }}>{t('storage.access.reachable')}</p>
              {preview.granted.map((g) => (
                <p key={g.rootId} style={{ margin: '2px 0', fontSize: 12, color: '#cbd5e1' }}>
                  {g.label} ({g.path}, {g.mode}) —{' '}
                  {g.everyone
                    ? t('storage.access.everyone')
                    : t('storage.access.agentCount', { count: g.agentContactIds.length })}
                </p>
              ))}
            </div>
          ) : (
            <p style={{ color: '#e6c07b', fontSize: 12, margin: 0 }}>{t('storage.access.unreachable')}</p>
          )
        ) : null}
      </SectionCard>

      <SectionCard title={t('storage.access.byAgent')}>
        {roots.length === 0 ? (
          <p style={settingsMuted}>{t('storage.access.empty')}</p>
        ) : (
          agents.map((a) => {
            const granted = roots.filter((r) => agentIdsOf(r).includes(ANY_AGENT) || agentIdsOf(r).includes(a.contactId));
            return (
              <div key={a.contactId} style={{ display: 'flex', gap: 8, padding: '4px 0', fontSize: 12 }}>
                <strong style={{ color: '#e8eef4', minWidth: 140 }}>{a.name}</strong>
                <span style={settingsMuted}>
                  {granted.length
                    ? granted.map((r) => `${r.label} (${r.mode})`).join(', ')
                    : t('storage.access.noAgents')}
                </span>
              </div>
            );
          })
        )}
      </SectionCard>

      <SectionCard title={`${t('storage.access.mounts')} / ${t('storage.access.syncs')}`}>
        {projections.length === 0 ? (
          <p style={settingsMuted}>{t('storage.sync.empty')}</p>
        ) : (
          projections.map((p) => {
            const pr = projPreview[p.dir];
            const names = (pr?.granted ?? []).flatMap((g) =>
              g.everyone ? [t('storage.access.everyone')] : g.agentContactIds.map(nameOf),
            );
            return (
              <div key={`${p.kind}:${p.dir}`} style={{ display: 'flex', gap: 8, padding: '4px 0', fontSize: 12 }}>
                <strong style={{ color: '#e8eef4', minWidth: 140 }}>{p.label}</strong>
                <span style={settingsMuted}>
                  {p.dir} — {names.length ? [...new Set(names)].join(', ') : t('storage.access.unreachable')}
                </span>
              </div>
            );
          })
        )}
      </SectionCard>

      <button
        type="button"
        style={settingsButton}
        onClick={() => navigate({ section: 'folders', path: path || undefined })}
      >
        {t('storage.access.grant')}
      </button>
    </>
  );
}
