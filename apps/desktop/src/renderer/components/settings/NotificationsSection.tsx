/**
 * Settings → Notifications.
 *
 * OS card presentation (master switch, style, sender/preview, sound, lock
 * privacy) plus the two delivery rails added with the inbox: auto-open the
 * sender's companion window and speak the message aloud, both only while the
 * window is unattended. Settings are read from `getUiSettings` and patched
 * through `setUiSettings`, which the main process re-validates on every read.
 */

import { useCallback, useEffect, useState } from 'react';
import { bridge, type NotificationSettings } from '../../bridge.js';
import { useI18n } from '../../i18n/index.js';
import {
  CheckboxField,
  Field,
  SectionCard,
  settingsButton,
  settingsField,
  settingsHint,
  settingsInput,
} from './settings-ui.js';

export function NotificationsSection() {
  const { t } = useI18n();
  const [notifications, setNotifications] = useState<NotificationSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [testSent, setTestSent] = useState(false);

  useEffect(() => {
    void bridge.getUiSettings().then((ui) => setNotifications(ui.notifications));
  }, []);

  const patch = useCallback(
    async (next: Partial<NotificationSettings>) => {
      if (!notifications) return;
      setBusy(true);
      setTestSent(false);
      try {
        const ui = await bridge.setUiSettings({ notifications: { ...notifications, ...next } });
        setNotifications(ui.notifications);
      } finally {
        setBusy(false);
      }
    },
    [notifications],
  );

  const sendTest = useCallback(async () => {
    await bridge.notifyIncoming(
      {
        messageId: `test-${Date.now()}`,
        conversationId: null,
        contactId: null,
        agentId: null,
        senderName: 'Nexus',
        preview: 'This is what a new-message notification looks like.',
        title: 'Nexus',
      },
      { force: true },
    );
    setTestSent(true);
  }, []);

  if (!notifications) {
    return (
      <SectionCard title={t('settings.notifications')} help={t('settings.notifications.help')}>
        <p style={settingsHint}>{t('settings.loading')}</p>
      </SectionCard>
    );
  }

  const off = busy || !notifications.enabled;

  return (
    <SectionCard title={t('settings.notifications')} help={t('settings.notifications.help')}>
      <CheckboxField
        checked={notifications.enabled}
        disabled={busy}
        onChange={(v) => void patch({ enabled: v })}
        label={t('settings.notifications.enabled')}
      />

      <Field label={t('settings.notifications.cardMode')}>
        <select
          style={settingsInput}
          value={notifications.cardMode}
          disabled={off}
          onChange={(e) =>
            void patch({ cardMode: e.target.value === 'title_only' ? 'title_only' : 'full' })
          }
        >
          <option value="full">{t('settings.notifications.cardMode.full')}</option>
          <option value="title_only">{t('settings.notifications.cardMode.titleOnly')}</option>
        </select>
      </Field>

      <CheckboxField
        checked={notifications.showSender}
        disabled={off}
        onChange={(v) => void patch({ showSender: v })}
        label={t('settings.notifications.showSender')}
      />

      <CheckboxField
        checked={notifications.showPreview}
        disabled={off || notifications.cardMode === 'title_only'}
        onChange={(v) => void patch({ showPreview: v })}
        label={t('settings.notifications.showPreview')}
      />

      <CheckboxField
        checked={notifications.sound}
        disabled={off}
        onChange={(v) => void patch({ sound: v })}
        label={t('settings.notifications.sound')}
        hint={t('settings.notifications.sound.help')}
      />

      <CheckboxField
        checked={notifications.suppressWhenLocked}
        disabled={off}
        onChange={(v) => void patch({ suppressWhenLocked: v })}
        label={t('settings.notifications.suppressWhenLocked')}
        hint={
          notifications.suppressWhenLocked
            ? t('settings.notifications.suppressWhenLocked.on')
            : t('settings.notifications.suppressWhenLocked.off')
        }
      />

      <CheckboxField
        checked={notifications.openCompanionOnMessage}
        disabled={busy}
        onChange={(v) => void patch({ openCompanionOnMessage: v })}
        label={t('settings.notifications.openCompanion')}
        hint={t('settings.notifications.openCompanion.help')}
      />

      <CheckboxField
        checked={notifications.speakMessages}
        disabled={busy}
        onChange={(v) => void patch({ speakMessages: v })}
        label={t('settings.notifications.speak')}
        hint={t('settings.notifications.speak.help')}
      />

      <div style={{ ...settingsField, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <button
          type="button"
          style={{ ...settingsButton, background: '#1c2430', borderColor: '#3a4654' }}
          onClick={() => void sendTest()}
          disabled={busy}
        >
          {t('settings.notifications.test')}
        </button>
        {testSent ? (
          <span style={{ color: '#4ade80', fontSize: 12 }}>
            {t('settings.notifications.testSent')}
          </span>
        ) : null}
      </div>
    </SectionCard>
  );
}
