/**
 * Settings → Companion.
 *
 * Three related blocks for the immersive companion window, grouped so the whole
 * "how the companion behaves" story is in one place:
 *
 *  - **Avatar**: user-facing liveliness (click nod, head-turn / tilt cones).
 *  - **Placement**: where a newly opened companion appears (corner/edge, margin,
 *    per-agent position memory, bring the main window forward). Wired to the
 *    Phase-A placement contract; the main process re-normalizes on every read.
 *  - **Debug**: developer-only surfaces (motion feed / gesture tester / status
 *    motions / walkable scene). All off by default.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  bridge,
  COMPANION_PLACEMENT_MODES,
  COMPANION_GAP_MIN_PX,
  COMPANION_GAP_MAX_PX,
  type CompanionAvatarSettings,
  type CompanionDebugSettings,
  type CompanionPlacementMode,
  type CompanionPlacementSettings,
} from '../../bridge.js';
import { useI18n, type MessageKey } from '../../i18n/index.js';
import { CheckboxField, Field, Hint, SectionCard, settingsHint, settingsInput } from './settings-ui.js';

/** i18n key for each placement mode's label. */
const PLACEMENT_MODE_LABEL: Record<CompanionPlacementMode, MessageKey> = {
  'bottom-right': 'settings.companion.placement.mode.bottomRight',
  'bottom-left': 'settings.companion.placement.mode.bottomLeft',
  'top-right': 'settings.companion.placement.mode.topRight',
  'top-left': 'settings.companion.placement.mode.topLeft',
  center: 'settings.companion.placement.mode.center',
  'right-of-main': 'settings.companion.placement.mode.rightOfMain',
  'remember-last': 'settings.companion.placement.mode.rememberLast',
};

export function CompanionSection() {
  const { t } = useI18n();
  const [avatar, setAvatar] = useState<CompanionAvatarSettings | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [debug, setDebug] = useState<CompanionDebugSettings | null>(null);
  const [debugBusy, setDebugBusy] = useState(false);
  const [placement, setPlacement] = useState<CompanionPlacementSettings | null>(null);
  const [placementBusy, setPlacementBusy] = useState(false);

  useEffect(() => {
    void bridge.getUiSettings().then((ui) => {
      setAvatar(ui.companionAvatar);
      setDebug(ui.companionDebug);
      setPlacement(ui.companionPlacement);
    });
  }, []);

  const patchAvatar = useCallback(
    async (next: Partial<CompanionAvatarSettings>) => {
      if (!avatar) return;
      setAvatarBusy(true);
      try {
        setAvatar((await bridge.setUiSettings({ companionAvatar: { ...avatar, ...next } })).companionAvatar);
      } finally {
        setAvatarBusy(false);
      }
    },
    [avatar],
  );

  const patchDebug = useCallback(
    async (next: Partial<CompanionDebugSettings>) => {
      if (!debug) return;
      setDebugBusy(true);
      try {
        setDebug((await bridge.setUiSettings({ companionDebug: { ...debug, ...next } })).companionDebug);
      } finally {
        setDebugBusy(false);
      }
    },
    [debug],
  );

  const patchPlacement = useCallback(
    async (next: Partial<CompanionPlacementSettings>) => {
      if (!placement) return;
      setPlacementBusy(true);
      try {
        setPlacement(
          (await bridge.setUiSettings({ companionPlacement: { ...placement, ...next } }))
            .companionPlacement,
        );
      } finally {
        setPlacementBusy(false);
      }
    },
    [placement],
  );

  return (
    <>
      <SectionCard title={t('settings.companion.avatar')} help={t('settings.companion.avatar.help')}>
        {avatar ? (
          <>
            <CheckboxField
              checked={avatar.clickNod}
              disabled={avatarBusy}
              onChange={(v) => void patchAvatar({ clickNod: v })}
              label={t('settings.companion.clickNod')}
              hint={t('settings.companion.clickNod.help')}
            />

            <Field
              label={t('settings.companion.clickNodGesture')}
              hint={t('settings.companion.clickNodGesture.help')}
            >
              <input
                type="text"
                value={avatar.clickNodGesture}
                disabled={avatarBusy || !avatar.clickNod}
                onChange={(e) => void patchAvatar({ clickNodGesture: e.target.value })}
                placeholder="nod"
                style={settingsInput}
              />
            </Field>

            <Field label={t('settings.companion.gazeYaw', { deg: avatar.gazeYawMaxDeg })} hint={t('settings.companion.gazeYaw.help')}>
              <input
                type="range"
                min={10}
                max={60}
                step={1}
                value={avatar.gazeYawMaxDeg}
                disabled={avatarBusy}
                onChange={(e) => void patchAvatar({ gazeYawMaxDeg: Number(e.target.value) })}
              />
            </Field>

            <Field label={t('settings.companion.gazePitch', { deg: avatar.gazePitchMaxDeg })} hint={t('settings.companion.gazePitch.help')}>
              <input
                type="range"
                min={8}
                max={40}
                step={1}
                value={avatar.gazePitchMaxDeg}
                disabled={avatarBusy}
                onChange={(e) => void patchAvatar({ gazePitchMaxDeg: Number(e.target.value) })}
              />
            </Field>
          </>
        ) : (
          <p style={settingsHint}>{t('settings.loading')}</p>
        )}
      </SectionCard>

      <SectionCard
        title={t('settings.companion.placement')}
        help={t('settings.companion.placement.help')}
      >
        {placement ? (
          <>
            <Field label={t('settings.companion.placement.mode')}>
              <select
                style={settingsInput}
                value={placement.mode}
                disabled={placementBusy}
                onChange={(e) =>
                  void patchPlacement({ mode: e.target.value as CompanionPlacementMode })
                }
              >
                {COMPANION_PLACEMENT_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {t(PLACEMENT_MODE_LABEL[mode])}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label={t('settings.companion.placement.gap', { px: placement.gapPx })}
              hint={t('settings.companion.placement.gap.help')}
            >
              <input
                type="range"
                min={COMPANION_GAP_MIN_PX}
                max={COMPANION_GAP_MAX_PX}
                step={2}
                value={placement.gapPx}
                disabled={placementBusy}
                onChange={(e) => void patchPlacement({ gapPx: Number(e.target.value) })}
              />
            </Field>

            <CheckboxField
              checked={placement.rememberPerAgent}
              disabled={placementBusy}
              onChange={(v) => void patchPlacement({ rememberPerAgent: v })}
              label={t('settings.companion.placement.rememberPerAgent')}
              hint={t('settings.companion.placement.rememberPerAgent.help')}
            />

            <CheckboxField
              checked={placement.bringMainToFront}
              disabled={placementBusy}
              onChange={(v) => void patchPlacement({ bringMainToFront: v })}
              label={t('settings.companion.placement.bringMainToFront')}
              hint={t('settings.companion.placement.bringMainToFront.help')}
            />
          </>
        ) : (
          <p style={settingsHint}>{t('settings.loading')}</p>
        )}
      </SectionCard>

      <SectionCard title={t('settings.companion.debug')} help={t('settings.companion.debug.help')}>
        {debug ? (
          <>
            {(
              [
                ['motionFeed', 'settings.companion.debug.motionFeed', 'settings.companion.debug.motionFeed.help'],
                ['gestureTest', 'settings.companion.debug.gestureTest', 'settings.companion.debug.gestureTest.help'],
                ['statusMotions', 'settings.companion.debug.statusMotions', 'settings.companion.debug.statusMotions.help'],
                ['sceneMode', 'settings.companion.debug.sceneMode', 'settings.companion.debug.sceneMode.help'],
              ] as const
            ).map(([key, labelKey, helpKey]) => (
              <CheckboxField
                key={key}
                checked={debug[key]}
                disabled={debugBusy}
                onChange={(v) => void patchDebug({ [key]: v })}
                label={t(labelKey)}
                hint={t(helpKey)}
              />
            ))}
            <Hint>{t('settings.companion.debug.forceHint')}</Hint>
          </>
        ) : (
          <p style={settingsHint}>{t('settings.loading')}</p>
        )}
      </SectionCard>
    </>
  );
}
