/**
 * Settings → Companion.
 *
 * The whole "how the companion behaves" story in one place:
 *
 *  - **Avatar**: user-facing liveliness (click nod, head-turn / tilt cones) plus
 *    the **default VRM model** every agent without a model of its own renders
 *    with (from this device's avatar library).
 *  - **Placement**: where a newly opened companion appears (corner/edge, margin,
 *    per-agent position memory, bring the main window forward) and **how big** it
 *    opens (three presets or custom pixels).
 *  - **Waking & popping up**: short links to the two surfaces that decide when a
 *    companion opens on its own (wake words, and the new-message behaviour in
 *    Notifications) rather than duplicating those controls here.
 *  - **Reply voice**: the **app-default TTS** model + voice used by an agent that
 *    has no voice of its own, with a test button.
 *  - **Debug**: developer-only surfaces (motion feed / gesture tester / status
 *    motions / walkable scene). All off by default.
 *
 * Wired to the Phase-A placement contract and the shared TTS settings; the main
 * process re-normalizes on every read.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  listAudioModels,
  type AudioModelListItem,
  type CommandClient,
} from '@nexus/chat-core';
import {
  bridge,
  COMPANION_PLACEMENT_MODES,
  COMPANION_GAP_MIN_PX,
  COMPANION_GAP_MAX_PX,
  COMPANION_SIZE_PRESET_IDS,
  COMPANION_SIZE_MIN,
  COMPANION_SIZE_MAX,
  COMPANION_CAMERA_PRESET_IDS,
  COMPANION_CAMERA_MIN_M,
  COMPANION_CAMERA_MAX_M,
  COMPANION_CAMERA_MIN_PITCH_DEG,
  COMPANION_CAMERA_MAX_PITCH_DEG,
  COMPANION_CAMERA_MIN_FOV_DEG,
  COMPANION_CAMERA_MAX_FOV_DEG,
  normalizeCompanionCamera,
  normalizeCompanionAvatarSettings,
  type AppDefaultTtsSettings,
  type CompanionAvatarSettings,
  type CompanionCameraPreset,
  type CompanionDebugSettings,
  type CompanionPlacementMode,
  type CompanionPlacementSettings,
  type CompanionSizePreset,
  type LocalAvatarsConfig,
} from '../../bridge.js';
import { useI18n, type MessageKey } from '../../i18n/index.js';
import { useSettingsNav } from './sections.js';
import { createDesktopCommandClient, type DesktopIdentity } from './desktopCommandClient.js';
import { TtsVoicePicker, TtsVoiceSampleField } from './TtsVoicePicker.js';
import { ttsModelSupportsVoiceSample } from '../../../shared/tts.js';
import {
  CheckboxField,
  Field,
  Hint,
  SectionCard,
  settingsGhostButton,
  settingsHint,
  settingsInput,
} from './settings-ui.js';

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

/** i18n key for each size preset's label. */
const SIZE_PRESET_LABEL: Record<CompanionSizePreset, MessageKey> = {
  compact: 'settings.companion.size.compact',
  standard: 'settings.companion.size.standard',
  large: 'settings.companion.size.large',
  custom: 'settings.companion.size.custom',
};

export function CompanionSection() {
  const { t } = useI18n();
  const navigate = useSettingsNav();
  const [avatar, setAvatar] = useState<CompanionAvatarSettings | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [debug, setDebug] = useState<CompanionDebugSettings | null>(null);
  const [debugBusy, setDebugBusy] = useState(false);
  const [placement, setPlacement] = useState<CompanionPlacementSettings | null>(null);
  const [placementBusy, setPlacementBusy] = useState(false);
  const [tts, setTts] = useState<AppDefaultTtsSettings | null>(null);
  const [avatars, setAvatars] = useState<LocalAvatarsConfig | null>(null);
  const [avatarLibraryBusy, setAvatarLibraryBusy] = useState(false);
  const [ttsModels, setTtsModels] = useState<AudioModelListItem[]>([]);
  const [client, setClient] = useState<CommandClient | null>(null);

  useEffect(() => {
    void bridge.getUiSettings().then((ui) => {
      // Tolerate an older main-process bundle: normalize so a missing
      // `camera` (added later) cannot crash the section on `camera.preset`.
      setAvatar(normalizeCompanionAvatarSettings(ui?.companionAvatar));
      setDebug(ui.companionDebug);
      setPlacement(ui.companionPlacement);
      setTts(ui.appDefaultTts);
    });
    void bridge.localAvatarsList().then(setAvatars).catch(() => setAvatars(null));
    // The app-default voice is chosen from the models the entitlement exposes,
    // so load them (and the region client) the same way the agent rows do.
    void (async () => {
      try {
        const [connection, auth] = await Promise.all([
          bridge.getConnectionConfig(),
          bridge.getAuthState(),
        ]);
        if (auth.status !== 'signed_in') return;
        const identity: DesktopIdentity = {
          token: auth.token,
          userId: auth.identity.userId ?? null,
          orgId: auth.identity.orgId ?? null,
          role: auth.identity.role ?? null,
          deviceId: auth.identity.deviceId ?? null,
        };
        const next = createDesktopCommandClient({ apiBaseUrl: connection.regionUrl, identity });
        setClient(next);
        const models = await listAudioModels(next, 'tts').catch(() => [] as AudioModelListItem[]);
        setTtsModels(models);
      } catch {
        /* the section still renders; the picker shows "none" */
      }
    })();
  }, []);

  const patchAvatar = useCallback(
    async (next: Partial<CompanionAvatarSettings>) => {
      if (!avatar) return;
      setAvatarBusy(true);
      try {
        const saved = (await bridge.setUiSettings({ companionAvatar: { ...avatar, ...next } }))
          .companionAvatar;
        setAvatar(normalizeCompanionAvatarSettings(saved ?? { ...avatar, ...next }));
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

  const patchTts = useCallback(
    async (next: Partial<AppDefaultTtsSettings>) => {
      if (!tts) return;
      setTts((await bridge.setUiSettings({ appDefaultTts: { ...tts, ...next } })).appDefaultTts);
    },
    [tts],
  );

  const setDefaultAvatar = useCallback(async (avatarId: string | null) => {
    setAvatarLibraryBusy(true);
    try {
      setAvatars(await bridge.localAvatarsSetDefault(avatarId));
    } finally {
      setAvatarLibraryBusy(false);
    }
  }, []);

  const runnableTtsModels = useMemo(() => ttsModels.filter((m) => m.runnable), [ttsModels]);
  const library = avatars?.avatars ?? [];
  const defaultAvatarId = avatars?.defaultAvatarId ?? '';

  return (
    <>
      {/* Waking & popping up — links, not duplicates. The actual controls live in
          the two surfaces that own them, and one of them (an unattended-message
          pop) is a Notifications-level decision, not a companion-level one. */}
      <SectionCard
        title={t('settings.companion.wake')}
        help={t('settings.companion.wake.help')}
      >
        <Field label={t('settings.companion.wake.onWake')} hint={t('settings.companion.wake.onWake.help')}>
          <button type="button" style={settingsGhostButton} onClick={() => navigate('wake')}>
            {t('settings.companion.wake.openWake')}
          </button>
        </Field>
        <Field
          label={t('settings.companion.wake.onMessage')}
          hint={t('settings.companion.wake.onMessage.help')}
        >
          <button type="button" style={settingsGhostButton} onClick={() => navigate('notifications')}>
            {t('settings.companion.wake.openNotifications')}
          </button>
        </Field>
      </SectionCard>

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

            {/* Camera framing: a named shot (face / bust / full-body) or a
                custom dial-in. Applied live to the 3D stage. */}
            <Field label={t('settings.companion.camera')} hint={t('settings.companion.camera.help')}>
              <select
                style={settingsInput}
                value={avatar.camera.preset}
                disabled={avatarBusy}
                onChange={(e) => {
                  const preset = COMPANION_CAMERA_PRESET_IDS.includes(
                    e.target.value as CompanionCameraPreset,
                  )
                    ? (e.target.value as CompanionCameraPreset)
                    : 'bust';
                  void patchAvatar({ camera: normalizeCompanionCamera({ ...avatar.camera, preset }) });
                }}
              >
                <option value="face">{t('settings.companion.camera.face')}</option>
                <option value="bust">{t('settings.companion.camera.bust')}</option>
                <option value="full-body">{t('settings.companion.camera.fullBody')}</option>
                <option value="custom">{t('settings.companion.camera.custom')}</option>
              </select>
            </Field>

            {avatar.camera.preset === 'custom' ? (
              <>
                <Field
                  label={t('settings.companion.camera.distance', { m: avatar.camera.distanceM })}
                  hint={t('settings.companion.camera.distance.help')}
                >
                  <input
                    type="range"
                    min={COMPANION_CAMERA_MIN_M}
                    max={COMPANION_CAMERA_MAX_M}
                    step={0.1}
                    value={avatar.camera.distanceM}
                    disabled={avatarBusy}
                    onChange={(e) =>
                      void patchAvatar({
                        camera: normalizeCompanionCamera({
                          ...avatar.camera,
                          distanceM: Number(e.target.value),
                        }),
                      })
                    }
                  />
                </Field>
                <Field
                  label={t('settings.companion.camera.height', { m: avatar.camera.heightM })}
                  hint={t('settings.companion.camera.height.help')}
                >
                  <input
                    type="range"
                    min={COMPANION_CAMERA_MIN_M}
                    max={COMPANION_CAMERA_MAX_M}
                    step={0.05}
                    value={avatar.camera.heightM}
                    disabled={avatarBusy}
                    onChange={(e) =>
                      void patchAvatar({
                        camera: normalizeCompanionCamera({
                          ...avatar.camera,
                          heightM: Number(e.target.value),
                        }),
                      })
                    }
                  />
                </Field>
                <Field
                  label={t('settings.companion.camera.pitch', { deg: avatar.camera.pitchDeg })}
                  hint={t('settings.companion.camera.pitch.help')}
                >
                  <input
                    type="range"
                    min={COMPANION_CAMERA_MIN_PITCH_DEG}
                    max={COMPANION_CAMERA_MAX_PITCH_DEG}
                    step={1}
                    value={avatar.camera.pitchDeg}
                    disabled={avatarBusy}
                    onChange={(e) =>
                      void patchAvatar({
                        camera: normalizeCompanionCamera({
                          ...avatar.camera,
                          pitchDeg: Number(e.target.value),
                        }),
                      })
                    }
                  />
                </Field>
                <Field
                  label={t('settings.companion.camera.fov', { deg: avatar.camera.fovDeg })}
                  hint={t('settings.companion.camera.fov.help')}
                >
                  <input
                    type="range"
                    min={COMPANION_CAMERA_MIN_FOV_DEG}
                    max={COMPANION_CAMERA_MAX_FOV_DEG}
                    step={1}
                    value={avatar.camera.fovDeg}
                    disabled={avatarBusy}
                    onChange={(e) =>
                      void patchAvatar({
                        camera: normalizeCompanionCamera({
                          ...avatar.camera,
                          fovDeg: Number(e.target.value),
                        }),
                      })
                    }
                  />
                </Field>
              </>
            ) : null}
          </>
        ) : (
          <p style={settingsHint}>{t('settings.loading')}</p>
        )}

        {/* Default VRM model: the fallback for every agent with no model of its
            own, so a fresh agent still gets a real 3D avatar. */}
        <Field
          label={t('settings.companion.defaultVrm')}
          hint={t('settings.companion.defaultVrm.help')}
        >
          <select
            style={settingsInput}
            value={library.some((a) => a.id === defaultAvatarId) ? defaultAvatarId : ''}
            disabled={avatarLibraryBusy || !library.length}
            onChange={(e) => void setDefaultAvatar(e.target.value || null)}
          >
            <option value="">{t('settings.companion.defaultVrm.none')}</option>
            {library.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </Field>
        {!library.length ? (
          <Field label={t('settings.companion.defaultVrm.empty')}>
            <button
              type="button"
              style={settingsGhostButton}
              disabled={avatarLibraryBusy}
              onClick={() => navigate('agents')}
            >
              {t('settings.companion.defaultVrm.openLibrary')}
            </button>
          </Field>
        ) : null}
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

            {/* Window size: three presets or custom pixels. Applies to the next
                open, so it never resizes a companion the user already placed. */}
            <Field label={t('settings.companion.size')} hint={t('settings.companion.size.help')}>
              <select
                style={settingsInput}
                value={placement.windowSize.preset}
                disabled={placementBusy}
                onChange={(e) =>
                  void patchPlacement({
                    windowSize: {
                      ...placement.windowSize,
                      preset: e.target.value as CompanionSizePreset,
                    },
                  })
                }
              >
                {COMPANION_SIZE_PRESET_IDS.map((preset) => (
                  <option key={preset} value={preset}>
                    {t(SIZE_PRESET_LABEL[preset])}
                  </option>
                ))}
              </select>
            </Field>

            {placement.windowSize.preset === 'custom' ? (
              <div style={{ display: 'flex', gap: 10 }}>
                <Field
                  label={t('settings.companion.size.width')}
                  rowStyle={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, fontSize: 12, color: '#9aa7b5' }}
                >
                  <input
                    type="number"
                    min={COMPANION_SIZE_MIN.width}
                    max={COMPANION_SIZE_MAX.width}
                    step={10}
                    value={placement.windowSize.width}
                    disabled={placementBusy}
                    style={settingsInput}
                    onChange={(e) =>
                      void patchPlacement({
                        windowSize: { ...placement.windowSize, width: Number(e.target.value) },
                      })
                    }
                  />
                </Field>
                <Field
                  label={t('settings.companion.size.height')}
                  rowStyle={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, fontSize: 12, color: '#9aa7b5' }}
                >
                  <input
                    type="number"
                    min={COMPANION_SIZE_MIN.height}
                    max={COMPANION_SIZE_MAX.height}
                    step={10}
                    value={placement.windowSize.height}
                    disabled={placementBusy}
                    style={settingsInput}
                    onChange={(e) =>
                      void patchPlacement({
                        windowSize: { ...placement.windowSize, height: Number(e.target.value) },
                      })
                    }
                  />
                </Field>
              </div>
            ) : (
              <Hint>
                {t('settings.companion.size.preview', {
                  w: placement.windowSize.width,
                  h: placement.windowSize.height,
                })}
              </Hint>
            )}

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

      {/* App-default reply voice: what an agent with no voice of its own speaks
          with. A test button proves the exact model + voice before saving. */}
      <SectionCard title={t('settings.companion.tts')} help={t('settings.companion.tts.help')}>
        {tts ? (
          <>
            <CheckboxField
              checked={tts.enabled}
              disabled={!client}
              onChange={(v) => void patchTts({ enabled: v })}
              label={t('settings.companion.tts.enabled')}
              hint={t('settings.companion.tts.enabled.help')}
            />
            <TtsVoicePicker
              client={client}
              models={runnableTtsModels}
              modelId={tts.modelId ?? ''}
              voiceId={tts.voiceId ?? ''}
              disabled={!tts.enabled}
              onModelChange={(modelId) =>
                // A new model invalidates the old voice + clone sample (both
                // belong to the previous model), so clear them with the switch.
                void patchTts({
                  modelId: modelId || null,
                  voiceId: null,
                  voiceSampleRef: null,
                  voiceSampleTranscript: null,
                })
              }
              onVoiceChange={(voiceId) => void patchTts({ voiceId: voiceId || null })}
            />
            {/* A clone sample for a `voice-cloning` model, so the app default can
                be the user's own voice rather than only a catalog preset. */}
            <TtsVoiceSampleField
              client={client}
              disabled={!tts.enabled}
              supportsSample={ttsModelSupportsVoiceSample(
                ttsModels.find((m) => m.id === tts.modelId)?.capabilities,
              )}
              canSet
              currentRef={tts.voiceSampleRef}
              transcript={tts.voiceSampleTranscript ?? ''}
              onRefChange={(ref) => void patchTts({ voiceSampleRef: ref })}
              onTranscriptChange={(text) => void patchTts({ voiceSampleTranscript: text || null })}
              onClear={() => void patchTts({ voiceSampleRef: null, voiceSampleTranscript: null })}
            />
            {!client ? <Hint>{t('settings.companion.tts.signIn')}</Hint> : null}
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
