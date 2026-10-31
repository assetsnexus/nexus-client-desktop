/**
 * Settings shell.
 *
 * A left-nav layout: one rail of sections (`SETTINGS_NAV`) and a scrollable
 * detail pane that renders the active section. The sections themselves live in
 * `./settings/*Section.tsx` — each one is self-contained and reads/writes its own
 * slice of `UiSettings`, so this file only decides *which* section is shown and
 * keeps the rail responsive (it collapses to a `<select>` on a narrow window via
 * a small CSS media query, not a resize listener).
 *
 * The shell owns only the two things every section shares: the title bar with a
 * Done button, and the current section id. Connection config is the one prop it
 * threads through, because saving it must notify the whole app (every window
 * picks up the new region URL without a restart).
 */

import { useState, type CSSProperties } from 'react';
import type { DesktopConnectionConfig } from '@nexus/node-core';
import { useI18n } from '../i18n/index.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { AgentsSection } from './settings/AgentsSection.js';
import { CompanionSection } from './settings/CompanionSection.js';
import { ConnectionSection } from './settings/ConnectionSection.js';
import { DeveloperSection } from './settings/DeveloperSection.js';
import { GeneralSection } from './settings/GeneralSection.js';
import { IntegrationsSection } from './settings/IntegrationsSection.js';
import { LocalAiSection } from './settings/LocalAiSection.js';
import { NotificationsSection } from './settings/NotificationsSection.js';
import { SecuritySection } from './settings/SecuritySection.js';
import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_NAV,
  SettingsNavContext,
  type SettingsSectionId,
} from './settings/sections.js';
import { WakeSettingsPanel } from './WakeSettingsPanel.js';

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

export function SettingsPanel({
  connection,
  onConnectionChange,
  onClose,
}: {
  connection: DesktopConnectionConfig;
  onConnectionChange: (next: DesktopConnectionConfig) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [active, setActive] = useState<SettingsSectionId>(DEFAULT_SETTINGS_SECTION);

  const activeEntry = SETTINGS_NAV.find((entry) => entry.id === active) ?? SETTINGS_NAV[0];

  return (
    <div style={shell}>
      <div style={header}>
        <h1 style={{ margin: 0, fontSize: 17 }}>{t('settings.title')}</h1>
        <button type="button" style={doneButton} onClick={onClose}>
          {t('settings.done')}
        </button>
      </div>

      {/* Collapse the rail to a select on a narrow window. A media query keeps
          this CSS-only, so no resize listener or extra state is needed. */}
      <style>{`
        .nexus-settings-nav { display: block; }
        .nexus-settings-select { display: none; }
        @media (max-width: 720px) {
          .nexus-settings-nav { display: none; }
          .nexus-settings-select { display: block; margin: 10px 20px 0; }
        }
      `}</style>

      <select
        className="nexus-settings-select"
        style={{
          padding: '8px 10px',
          borderRadius: 8,
          border: '1px solid #3a4654',
          background: '#0f1419',
          color: '#e8eef4',
          fontSize: 13,
        }}
        value={active}
        onChange={(e) => setActive(e.target.value as SettingsSectionId)}
      >
        {SETTINGS_NAV.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.icon} {t(entry.labelKey)}
          </option>
        ))}
      </select>

      <div style={body}>
        <nav className="nexus-settings-nav" style={nav}>
          {SETTINGS_NAV.map((entry) => (
            <button
              key={entry.id}
              type="button"
              style={navButton(entry.id === active)}
              onClick={() => setActive(entry.id)}
              title={entry.helpKey ? t(entry.helpKey) : undefined}
            >
              <span aria-hidden>{entry.icon}</span>
              <span>{t(entry.labelKey)}</span>
            </button>
          ))}
        </nav>

        <div style={detail}>
          <ErrorBoundary key={activeEntry.id} label={t(activeEntry.labelKey)}>
            <SettingsNavContext.Provider value={setActive}>
              {active === 'general' ? <GeneralSection /> : null}
              {active === 'notifications' ? <NotificationsSection /> : null}
              {active === 'companion' ? <CompanionSection /> : null}
              {active === 'agents' ? <AgentsSection /> : null}
              {active === 'wake' ? <WakeSettingsPanel /> : null}
              {active === 'localAi' ? <LocalAiSection /> : null}
              {active === 'integrations' ? <IntegrationsSection /> : null}
              {active === 'security' ? <SecuritySection /> : null}
              {active === 'connection' ? (
                <ConnectionSection
                  connection={connection}
                  onConnectionChange={onConnectionChange}
                  onClose={onClose}
                />
              ) : null}
              {active === 'developer' ? <DeveloperSection /> : null}
            </SettingsNavContext.Provider>
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
