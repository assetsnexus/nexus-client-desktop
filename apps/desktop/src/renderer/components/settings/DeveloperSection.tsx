/**
 * Settings → Developer.
 *
 * The technical, mostly-local surfaces:
 *  - **Local command skills**: the per-OS commands exposed as client tools.
 *  - **Client-tool audit trail** (`AuditPanel`) and **chat cache** (`ChatCachePanel`),
 *    each already self-contained and rendered inside an `ErrorBoundary` so one
 *    failing panel cannot blank the whole settings view.
 *
 * Agent workspaces (the directories an agent may read/write) moved to the
 * Storage hub's **Agent folders** section, which also owns the per-agent ACL.
 */

import type { LocalCommandSkill, ToolsConfig } from '../../bridge.js';
import { bridge } from '../../bridge.js';
import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n/index.js';
import { ErrorBoundary } from '../ErrorBoundary.js';
import { AuditPanel } from '../AuditPanel.js';
import { ChatCachePanel } from '../ChatCachePanel.js';
import { SectionCard, settingsGhostButton, settingsRow } from './settings-ui.js';

export function DeveloperSection() {
  const { t } = useI18n();
  const [tools, setTools] = useState<ToolsConfig | null>(null);

  useEffect(() => {
    void bridge.getToolsConfig().then(setTools);
  }, []);

  return (
    <>
      <SectionCard title={t('settings.workspaces')} help={t('settings.workspaces.help')}>
        <button
          type="button"
          style={settingsGhostButton}
          onClick={() => void bridge.openStorage('folders')}
        >
          {t('settings.workspaces')} → {t('storage.nav.folders')}
        </button>
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
