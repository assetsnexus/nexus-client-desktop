/**
 * Settings navigation metadata.
 *
 * One entry per section in the settings left nav. The `labelKey`/`helpKey` are
 * i18n keys (see `locales-settings.ts`); the icon is a plain emoji so the nav
 * needs no icon dependency. Kept separate from the section components so the nav
 * can render before any section is opened.
 */

import { createContext, useContext } from 'react';
import type { MessageKey } from '../../i18n/index.js';
import type { SettingsSectionId } from '../../../shared/ipc.js';

export type { SettingsSectionId };

export type SettingsNavEntry = {
  id: SettingsSectionId;
  labelKey: MessageKey;
  icon: string;
  /** Optional one-line summary rendered under the section title. */
  helpKey?: MessageKey;
};

/**
 * Nav order is deliberate: everyday preferences first (language, notifications,
 * the companion), then the per-agent overrides, then the deeper/technical
 * sections (wake, local AI, integrations), then the developer surfaces last.
 */
export const SETTINGS_NAV: readonly SettingsNavEntry[] = [
  { id: 'general', labelKey: 'settings.nav.general', icon: '⚙️', helpKey: 'settings.general.help' },
  {
    id: 'notifications',
    labelKey: 'settings.nav.notifications',
    icon: '🔔',
    helpKey: 'settings.notifications.help',
  },
  {
    id: 'companion',
    labelKey: 'settings.nav.companion',
    icon: '🧍',
    helpKey: 'settings.companion.help',
  },
  {
    id: 'voice',
    labelKey: 'settings.nav.voice',
    icon: '🗣️',
    helpKey: 'settings.voice.help',
  },
  { id: 'agents', labelKey: 'settings.nav.agents', icon: '🤖', helpKey: 'settings.agents.help' },
  { id: 'wake', labelKey: 'settings.nav.wake', icon: '🎙️', helpKey: 'settings.wake.help' },
  { id: 'localAi', labelKey: 'settings.nav.localAi', icon: '🧠', helpKey: 'settings.localAi.help' },
  {
    id: 'privacy',
    labelKey: 'settings.nav.privacy',
    icon: '🛡️',
    helpKey: 'settings.privacy.help',
  },
  {
    id: 'integrations',
    labelKey: 'settings.nav.integrations',
    icon: '🧩',
    helpKey: 'settings.integrations.help',
  },
  { id: 'security', labelKey: 'settings.nav.security', icon: '🔒', helpKey: 'settings.security.help' },
  {
    id: 'connection',
    labelKey: 'settings.nav.connection',
    icon: '🌐',
    helpKey: 'settings.connection.help',
  },
  {
    id: 'developer',
    labelKey: 'settings.nav.developer',
    icon: '🛠️',
    helpKey: 'settings.developer.help',
  },
];

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = 'general';

/**
 * Lets a section deep-link to another (e.g. the Companion section's "wake
 * words"/"notifications" links). The shell provides the setter; a section with
 * no provider (a unit test rendering one section alone) gets a no-op, so the
 * link still renders and simply does nothing.
 */
export const SettingsNavContext = createContext<(id: SettingsSectionId) => void>(() => {});

/** The section-navigation callback, safe to call without a provider. */
export function useSettingsNav(): (id: SettingsSectionId) => void {
  return useContext(SettingsNavContext);
}
