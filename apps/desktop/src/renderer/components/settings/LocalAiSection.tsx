/**
 * Settings → Local AI.
 *
 * The on-device model surfaces: the local model catalog (`LocalModelsPanel`),
 * the local speech models (`LocalVoicePanel`), and the audio device routing
 * (`AudioSettingsPanel`). Each is an existing, self-contained panel rendered
 * inside an `ErrorBoundary` so a failing panel degrades locally.
 */

import { useI18n } from '../../i18n/index.js';
import { ErrorBoundary } from '../ErrorBoundary.js';
import { LocalModelsPanel } from '../LocalModelsPanel.js';
import { LocalVoicePanel } from '../LocalVoicePanel.js';
import { AudioSettingsPanel } from '../AudioSettingsPanel.js';

export function LocalAiSection() {
  const { t } = useI18n();
  return (
    <>
      <ErrorBoundary label={t('settings.localAi.models')}>
        <LocalModelsPanel />
      </ErrorBoundary>

      <ErrorBoundary label={t('settings.localAi.speech')}>
        <LocalVoicePanel />
      </ErrorBoundary>

      <ErrorBoundary label={t('settings.localAi.audio')}>
        <AudioSettingsPanel />
      </ErrorBoundary>
    </>
  );
}
