/**
 * Settings → General.
 *
 * The interface language for this desktop client. Kept tiny: the language picker
 * is the whole section, and it persists through the same i18n bridge every other
 * surface uses.
 */

import { LanguageSelector } from '../LanguageSelector.js';
import { useI18n } from '../../i18n/index.js';
import { SectionCard } from './settings-ui.js';

export function GeneralSection() {
  const { t } = useI18n();
  return (
    <SectionCard title={t('settings.language')} help={t('settings.language.help')}>
      <LanguageSelector variant="field" />
    </SectionCard>
  );
}
