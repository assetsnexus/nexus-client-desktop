/**
 * Settings → Voice.
 *
 * The companion conversation rail: turn-based speech vs a live WebRTC call, and
 * what a new user input does to speech that is still playing or queued. The
 * auto-speak toggle deliberately shares the chat composer's "Auto voice" flag
 * (`anx-chat-auto-voice`) so the two controls can never disagree.
 *
 * Reads/persists through `getUiSettings`/`setUiSettings`; the main process
 * re-normalizes `voiceModes` on every read, so a bad value cannot persist.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  bridge,
  normalizeVoiceModeSettings,
  type VoiceModeSettings,
} from '../../bridge.js';
import { readAutoVoice, writeAutoVoice } from '@nexus/chat-react';
import { useI18n } from '../../i18n/index.js';
import { CheckboxField, Field, SectionCard, settingsHint, settingsInput } from './settings-ui.js';

export function VoiceSection() {
  const { t } = useI18n();
  const [voiceModes, setVoiceModes] = useState<VoiceModeSettings | null>(null);
  const [autoVoice, setAutoVoice] = useState(() => readAutoVoice(false));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void bridge
      .getUiSettings()
      .then((ui) => setVoiceModes(normalizeVoiceModeSettings(ui?.voiceModes)));
  }, []);

  const patch = useCallback(
    async (next: Partial<VoiceModeSettings>) => {
      if (!voiceModes) return;
      setBusy(true);
      try {
        const ui = await bridge.setUiSettings({ voiceModes: { ...voiceModes, ...next } });
        setVoiceModes(normalizeVoiceModeSettings(ui?.voiceModes ?? { ...voiceModes, ...next }));
      } finally {
        setBusy(false);
      }
    },
    [voiceModes],
  );

  const toggleAutoSpeak = useCallback((value: boolean) => {
    writeAutoVoice(value);
    setAutoVoice(value);
  }, []);

  if (!voiceModes) {
    return (
      <SectionCard title={t('settings.voice')} help={t('settings.voice.help')}>
        <p style={settingsHint}>{t('settings.loading')}</p>
      </SectionCard>
    );
  }

  return (
    <SectionCard title={t('settings.voice')} help={t('settings.voice.help')}>
      <Field label={t('settings.voice.mode')} hint={t('settings.voice.mode.help')}>
        <select
          style={settingsInput}
          value={voiceModes.mode}
          disabled={busy}
          onChange={(e) =>
            void patch({ mode: e.target.value === 'realtime' ? 'realtime' : 'turns' })
          }
        >
          <option value="turns">{t('settings.voice.mode.turns')}</option>
          <option value="realtime">{t('settings.voice.mode.realtime')}</option>
        </select>
      </Field>

      <Field label={t('settings.voice.interrupt')} hint={t('settings.voice.interrupt.help')}>
        <select
          style={settingsInput}
          value={voiceModes.interruptOnSend}
          disabled={busy}
          onChange={(e) => {
            const v = e.target.value;
            void patch({
              interruptOnSend:
                v === 'clear_queue' || v === 'off' ? v : 'skip_current',
            });
          }}
        >
          <option value="skip_current">{t('settings.voice.interrupt.skip_current')}</option>
          <option value="clear_queue">{t('settings.voice.interrupt.clear_queue')}</option>
          <option value="off">{t('settings.voice.interrupt.off')}</option>
        </select>
      </Field>

      <CheckboxField
        checked={autoVoice}
        disabled={busy}
        onChange={toggleAutoSpeak}
        label={t('settings.voice.autoSpeak')}
        hint={t('settings.voice.autoSpeak.help')}
      />
    </SectionCard>
  );
}
