/**
 * Settings → Developer.
 *
 * The technical, mostly-local surfaces:
 *  - **Agent workspaces**: the directories an agent may read/write (enforced in
 *    the main process; symlink escapes are refused).
 *  - **Local command skills**: the per-OS commands exposed as client tools.
 *  - **Client-tool audit trail** (`AuditPanel`) and **chat cache** (`ChatCachePanel`),
 *    each already self-contained and rendered inside an `ErrorBoundary` so one
 *    failing panel cannot blank the whole settings view.
 */

import { useEffect, useState } from 'react';
import type { LocalCommandSkill, ToolsConfig, WorkspaceRoot } from '../../bridge.js';
import { bridge } from '../../bridge.js';
import { useI18n } from '../../i18n/index.js';
import { ErrorBoundary } from '../ErrorBoundary.js';
import { AuditPanel } from '../AuditPanel.js';
import { ChatCachePanel } from '../ChatCachePanel.js';
import {
  SectionCard,
  settingsButton,
  settingsGhostButton,
  settingsInput,
  settingsMuted,
  settingsRow,
} from './settings-ui.js';

export function DeveloperSection() {
  const { t } = useI18n();
  const [tools, setTools] = useState<ToolsConfig | null>(null);
  const [newWorkspace, setNewWorkspace] = useState('');
  const [newWorkspaceMode, setNewWorkspaceMode] = useState<WorkspaceRoot['mode']>('read-write');

  useEffect(() => {
    void bridge.getToolsConfig().then(setTools);
  }, []);

  async function addWorkspace() {
    const path = newWorkspace.trim();
    if (!path || !tools) return;
    const next: ToolsConfig = await bridge.setWorkspaces([
      ...tools.workspaces,
      {
        id: `ws-${Date.now()}`,
        label: path.split('/').filter(Boolean).pop() || path,
        path,
        mode: newWorkspaceMode,
      },
    ]);
    setTools(next);
    setNewWorkspace('');
  }

  async function removeWorkspace(id: string) {
    if (!tools) return;
    setTools(await bridge.setWorkspaces(tools.workspaces.filter((w) => w.id !== id)));
  }

  async function toggleReadOnly(id: string) {
    if (!tools) return;
    setTools(
      await bridge.setWorkspaces(
        tools.workspaces.map((w) =>
          w.id === id ? { ...w, mode: w.mode === 'read-write' ? 'read-only' : 'read-write' } : w,
        ),
      ),
    );
  }

  return (
    <>
      <SectionCard title={t('settings.workspaces')} help={t('settings.workspaces.help')}>
        {tools?.workspaces.length ? (
          tools.workspaces.map((w) => (
            <div key={w.id} style={settingsRow}>
              <strong style={{ fontSize: 13 }}>{w.label}</strong>
              <span style={settingsMuted}>{w.path}</span>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                style={{ ...settingsGhostButton, padding: '4px 10px' }}
                onClick={() => void toggleReadOnly(w.id)}
              >
                {w.mode}
              </button>
              <button
                type="button"
                style={{ ...settingsGhostButton, padding: '4px 10px' }}
                onClick={() => void removeWorkspace(w.id)}
              >
                {t('settings.workspaces.remove')}
              </button>
            </div>
          ))
        ) : (
          <p style={settingsMuted}>{t('settings.workspaces.empty')}</p>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            style={{ ...settingsInput, flex: 1 }}
            value={newWorkspace}
            placeholder="/absolute/path/to/project"
            onChange={(e) => setNewWorkspace(e.target.value)}
          />
          <select
            style={settingsInput}
            value={newWorkspaceMode}
            onChange={(e) => setNewWorkspaceMode(e.target.value as WorkspaceRoot['mode'])}
          >
            <option value="read-write">read-write</option>
            <option value="read-only">read-only</option>
          </select>
          <button type="button" style={settingsButton} onClick={() => void addWorkspace()}>
            {t('settings.workspaces.add')}
          </button>
        </div>
      </SectionCard>

      <SectionCard title={t('settings.commands')} help={t('settings.commands.help')}>
        {(tools?.localCommands ?? []).map((skill) => (
          <LocalCommandRow key={skill.skillId} skill={skill} />
        ))}
      </SectionCard>

      <ErrorBoundary label={t('settings.audit')}>
        <AuditPanel />
      </ErrorBoundary>

      <ErrorBoundary label={t('settings.chatCache')}>
        <ChatCachePanel />
      </ErrorBoundary>
    </>
  );
}

function LocalCommandRow({ skill }: { skill: LocalCommandSkill }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={settingsRow}>
        <strong style={{ fontSize: 14 }}>{skill.title}</strong>
        <span style={{ color: '#9aa7b5', fontSize: 12 }}>{skill.oneLiner}</span>
      </div>
      <ul style={{ margin: '0 0 8px', paddingLeft: 18, color: '#6b7784', fontSize: 12 }}>
        {skill.commands.map((c) => (
          <li key={c.id}>
            <code>{c.os}</code> · {c.access}
            {c.approval === 'ask' ? ' · needs approval' : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}
