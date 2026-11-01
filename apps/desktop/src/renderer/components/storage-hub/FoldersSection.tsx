/**
 * Storage hub → Agent folders.
 *
 * The local directories agents may read/write, moved here out of Settings →
 * Developer, extended with a per-agent ACL: each root names which agents (by
 * desktop contact id) may use it. The sandbox in the main process is the real
 * boundary; this surface only edits the catalog.
 *
 * A root with `['*']` (or a root persisted before the ACL, migrated to `['*']`)
 * is granted to every agent.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  bridge,
  type ToolsConfig,
  type WakeAgentRow,
  type WorkspaceRoot,
} from '../../bridge.js';
import { useI18n } from '../../i18n/index.js';
import {
  Field,
  SectionCard,
  settingsButton,
  settingsInput,
  settingsMuted,
  settingsRow,
  settingsTinyButton,
} from '../settings/settings-ui.js';

/** The sentinel meaning "every agent" (mirrors `@nexus/client-tools` ANY_AGENT). */
const ANY_AGENT = '*';

function agentIdsOf(root: WorkspaceRoot): string[] {
  const ids = Array.isArray(root.agentContactIds) ? root.agentContactIds : [];
  return ids.length ? ids : [ANY_AGENT];
}

export function FoldersSection({
  initialPath = null,
  onPathConsumed,
}: {
  /** A path to prefill the "add folder" field (Access → Grant access…). */
  initialPath?: string | null;
  onPathConsumed?: () => void;
}) {
  const { t } = useI18n();
  const [tools, setTools] = useState<ToolsConfig | null>(null);
  const [agents, setAgents] = useState<WakeAgentRow[]>([]);
  const [newPath, setNewPath] = useState(initialPath ?? '');
  const [newMode, setNewMode] = useState<WorkspaceRoot['mode']>('read-write');
  const [newAgents, setNewAgents] = useState<string[]>([ANY_AGENT]);

  useEffect(() => {
    void bridge.getToolsConfig().then(setTools);
    void bridge.wakeListAgents().then(setAgents).catch(() => setAgents([]));
  }, []);

  // Consume a deep-linked prefill once (Access → "Grant access…").
  useEffect(() => {
    if (initialPath) {
      setNewPath(initialPath);
      onPathConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPath]);

  const save = useCallback(async (next: WorkspaceRoot[]) => {
    setTools(await bridge.setWorkspaces(next));
  }, []);

  const add = useCallback(async () => {
    const path = newPath.trim();
    if (!path || !tools) return;
    const next = await bridge.setWorkspaces([
      ...tools.workspaces,
      {
        id: `ws-${Date.now()}`,
        label: path.split('/').filter(Boolean).pop() || path,
        path,
        mode: newMode,
        agentContactIds: newAgents.length ? newAgents : [ANY_AGENT],
      },
    ]);
    setTools(next);
    setNewPath('');
    setNewAgents([ANY_AGENT]);
  }, [newPath, tools, newMode, newAgents]);

  const remove = useCallback(
    async (id: string) => {
      if (!tools) return;
      await save(tools.workspaces.filter((w) => w.id !== id));
    },
    [tools, save],
  );

  const toggleMode = useCallback(
    async (id: string) => {
      if (!tools) return;
      await save(
        tools.workspaces.map((w) =>
          w.id === id ? { ...w, mode: w.mode === 'read-write' ? 'read-only' : 'read-write' } : w,
        ),
      );
    },
    [tools, save],
  );

  const updateRootAgents = useCallback(
    async (id: string, ids: string[]) => {
      if (!tools) return;
      await save(
        tools.workspaces.map((w) =>
          w.id === id ? { ...w, agentContactIds: ids.length ? ids : [ANY_AGENT] } : w,
        ),
      );
    },
    [tools, save],
  );

  return (
    <SectionCard title={t('storage.folders.title')} help={t('storage.folders.help')}>
      {tools?.workspaces.length ? (
        tools.workspaces.map((w) => (
          <RootRow
            key={w.id}
            root={w}
            agents={agents}
            onToggleMode={() => void toggleMode(w.id)}
            onRemove={() => void remove(w.id)}
            onSetAgents={(ids) => void updateRootAgents(w.id, ids)}
          />
        ))
      ) : (
        <p style={settingsMuted}>{t('storage.folders.empty')}</p>
      )}

      <Field label={t('storage.folders.title')} hint={t('storage.folders.agents.help')}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            style={{ ...settingsInput, flex: 1, minWidth: 220 }}
            value={newPath}
            placeholder={t('storage.folders.pathPlaceholder')}
            onChange={(e) => setNewPath(e.target.value)}
          />
          <select
            style={settingsInput}
            value={newMode}
            onChange={(e) => setNewMode(e.target.value as WorkspaceRoot['mode'])}
          >
            <option value="read-write">read-write</option>
            <option value="read-only">read-only</option>
          </select>
        </div>
      </Field>

      <AgentPicker
        agents={agents}
        selected={newAgents}
        onChange={setNewAgents}
      />

      <button type="button" style={settingsButton} onClick={() => void add()} disabled={!newPath.trim()}>
        {t('storage.folders.add')}
      </button>
    </SectionCard>
  );
}

function RootRow({
  root,
  agents,
  onToggleMode,
  onRemove,
  onSetAgents,
}: {
  root: WorkspaceRoot;
  agents: WakeAgentRow[];
  onToggleMode: () => void;
  onRemove: () => void;
  onSetAgents: (ids: string[]) => void;
}) {
  const { t } = useI18n();
  const ids = agentIdsOf(root);
  const everyone = ids.includes(ANY_AGENT);
  return (
    <div style={{ borderTop: '1px solid #222b34', paddingTop: 8 }}>
      <div style={settingsRow}>
        <strong style={{ fontSize: 13 }}>{root.label}</strong>
        <span style={settingsMuted}>{root.path}</span>
        <span style={{ flex: 1 }} />
        <button type="button" style={settingsTinyButton} onClick={onToggleMode}>
          {root.mode}
        </button>
        <button type="button" style={settingsTinyButton} onClick={onRemove}>
          {t('storage.folders.remove')}
        </button>
      </div>
      <p style={{ ...settingsMuted, margin: '0 0 4px' }}>
        {t('storage.folders.agents')}:{' '}
        {everyone
          ? t('storage.folders.agents.all')
          : t('storage.folders.agents.some', { count: ids.length })}
      </p>
      <AgentPicker agents={agents} selected={ids} onChange={onSetAgents} />
    </div>
  );
}

/** A checkbox list of agents plus an "All agents" toggle. */
function AgentPicker({
  agents,
  selected,
  onChange,
}: {
  agents: WakeAgentRow[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const { t } = useI18n();
  const everyone = selected.includes(ANY_AGENT);
  const toggleAgent = (id: string) => {
    const withoutAll = selected.filter((x) => x !== ANY_AGENT);
    if (withoutAll.includes(id)) onChange(withoutAll.filter((x) => x !== id));
    else onChange([...withoutAll, id]);
  };
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, margin: '4px 0' }}>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#e8eef4' }}>
        <input
          type="checkbox"
          checked={everyone}
          onChange={(e) => onChange(e.target.checked ? [ANY_AGENT] : [])}
        />
        {t('storage.folders.agents.all')}
      </label>
      {!everyone
        ? agents.map((a) => (
            <label
              key={a.contactId}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#cbd5e1' }}
            >
              <input
                type="checkbox"
                checked={selected.includes(a.contactId)}
                onChange={() => toggleAgent(a.contactId)}
              />
              {a.name}
            </label>
          ))
        : null}
      {!everyone && !agents.length ? (
        <span style={settingsMuted}>{t('storage.folders.agents.none')}</span>
      ) : null}
    </div>
  );
}
