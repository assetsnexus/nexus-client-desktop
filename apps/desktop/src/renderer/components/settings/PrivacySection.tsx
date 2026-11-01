/**
 * Settings → Privacy.
 *
 * Two read-only dashboards, deliberately factual (the app never claims privacy
 * it cannot prove):
 *
 *  1. A per-stage checklist of the *configured* pipeline (chat LLM, STT, TTS,
 *     wake word) labelled by where it actually runs — on this device, on your
 *     region node, or in a public cloud.
 *  2. A hosting breakdown of the model catalog your subscription exposes.
 *
 * All inputs come from existing surfaces: `localVoiceGetState` + `wakeGetSettings`
 * for the device side, and the region entitlement/audio commands for the catalog.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  listAudioModels,
  listAvailableChatModels,
  type AudioModelListItem,
} from '@nexus/chat-core';
import {
  bridge,
  type LocalVoiceState,
  type WakeSettings,
} from '../../bridge.js';
import { useI18n, type MessageKey } from '../../i18n/index.js';
import { createDesktopCommandClient, type DesktopIdentity } from './desktopCommandClient.js';
import { Hint, SectionCard, settingsHint, settingsRow } from './settings-ui.js';
import {
  classifyPipeline,
  countHostingClasses,
  type HostingClass,
  type PipelineLocation,
  type PipelineStageView,
} from '../../../shared/privacy.js';

const LOCATION_LABEL: Record<PipelineLocation, MessageKey> = {
  onDevice: 'settings.privacy.where.onDevice',
  region: 'settings.privacy.where.region',
  publicCloud: 'settings.privacy.where.publicCloud',
  unknown: 'settings.privacy.where.unknown',
};

const STAGE_LABEL: Record<PipelineStageView['id'], MessageKey> = {
  llm: 'settings.privacy.stage.llm',
  stt: 'settings.privacy.stage.stt',
  tts: 'settings.privacy.stage.tts',
  wake: 'settings.privacy.stage.wake',
};

const HOSTING_LABEL: Record<HostingClass, MessageKey> = {
  public_cloud: 'settings.privacy.badge.public_cloud',
  managed_cloud: 'settings.privacy.badge.managed_cloud',
  private_cloud: 'settings.privacy.badge.private_cloud',
  edge_processing: 'settings.privacy.badge.edge_processing',
};

export function PrivacySection() {
  const { t } = useI18n();
  const [voiceState, setVoiceState] = useState<LocalVoiceState | null>(null);
  const [wake, setWake] = useState<WakeSettings | null>(null);
  const [chatHosting, setChatHosting] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<{ hosting: HostingClass; count: number }[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);

  useEffect(() => {
    void bridge.localVoiceGetState().then(setVoiceState).catch(() => setVoiceState(null));
    void bridge.wakeGetSettings().then(setWake).catch(() => setWake(null));
  }, []);

  // Catalog + active chat model come from the region, so they need a signed-in
  // client. Failure is non-fatal: the checklist still renders from device state.
  useEffect(() => {
    void (async () => {
      try {
        const [connection, auth] = await Promise.all([
          bridge.getConnectionConfig(),
          bridge.getAuthState(),
        ]);
        if (auth.status !== 'signed_in') {
          setCatalogLoaded(true);
          return;
        }
        const identity: DesktopIdentity = {
          token: auth.token,
          userId: auth.identity.userId ?? null,
          orgId: auth.identity.orgId ?? null,
          role: auth.identity.role ?? null,
          deviceId: auth.identity.deviceId ?? null,
        };
        const client = createDesktopCommandClient({
          apiBaseUrl: connection.regionUrl,
          identity,
        });
        const [chat, audio] = await Promise.all([
          listAvailableChatModels(client).catch(() => ({ models: [] })),
          listAudioModels(client, 'both').catch(() => [] as AudioModelListItem[]),
        ]);
        setChatHosting(chat.models[0]?.availableHostingTypes ?? []);
        setCatalog(
          countHostingClasses([
            ...chat.models.map((m) => ({ availableHostingTypes: m.availableHostingTypes })),
            ...audio.map((m) => ({ availableHostingTypes: hostingForAudio(m) })),
          ]),
        );
      } catch {
        /* leave the catalog empty; the "not available" line renders */
      } finally {
        setCatalogLoaded(true);
      }
    })();
  }, []);

  const stages = useMemo<PipelineStageView[]>(() => {
    const settings = voiceState?.settings;
    const localSttModels = (voiceState?.models ?? []).filter((m) => m.kind === 'stt');
    const localTtsModels = (voiceState?.models ?? []).filter((m) => m.kind === 'tts');
    const installed = (rows: typeof localSttModels) =>
      rows.some((m) => m.installState === 'installed');
    const wakeBinding = (wake?.bindings ?? []).find((b) => b.enabled && b.modelId);
    return classifyPipeline({
      chatModelHosting: chatHosting,
      sttEngine: settings?.sttEngine,
      ttsEngine: settings?.ttsEngine,
      localSttAvailable: installed(localSttModels),
      localTtsAvailable: installed(localTtsModels),
      customSttEndpoint: Boolean(settings?.customSttEndpoint),
      customTtsEndpoint: Boolean(settings?.customTtsEndpoint),
      wakeEngine: wakeBinding?.modelId ?? null,
      // A wake word runs on-device (the model is installed locally); the wake
      // *turn* may then stream audio to region STT, which the STT row covers.
      wakeUsesCloud: false,
      wakeUnavailable: !wake?.enabled,
    });
  }, [voiceState, wake, chatHosting]);

  const chip = (label: string, muted = false) => (
    <span
      key={label}
      style={{
        fontSize: 11,
        borderRadius: 999,
        padding: '2px 10px',
        border: `1px solid ${muted ? '#3a4654' : '#3f6cb0'}`,
        color: muted ? '#8b95a1' : '#e8eef4',
      }}
    >
      {label}
    </span>
  );

  return (
    <>
      <SectionCard
        title={t('settings.privacy.pipeline')}
        help={t('settings.privacy.pipeline.help')}
      >
        {stages.map((stage) => (
          <div key={stage.id} style={{ ...settingsRow, justifyContent: 'space-between' }}>
            <span style={{ color: '#e8eef4', fontSize: 13 }}>{t(STAGE_LABEL[stage.id])}</span>
            {stage.location ? (
              <span style={{ display: 'flex', gap: 6 }}>
                {chip(t(LOCATION_LABEL[stage.location]), stage.location === 'unknown')}
              </span>
            ) : (
              <span style={settingsHint}>{t('settings.privacy.stage.unset')}</span>
            )}
          </div>
        ))}
      </SectionCard>

      <SectionCard title={t('settings.privacy.catalog')} help={t('settings.privacy.catalog.help')}>
        {!catalogLoaded ? (
          <p style={settingsHint}>{t('settings.loading')}</p>
        ) : catalog.length ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {catalog.map((row) =>
              chip(`${t(HOSTING_LABEL[row.hosting])} · ${row.count}`),
            )}
          </div>
        ) : (
          <p style={settingsHint}>{t('settings.privacy.catalog.empty')}</p>
        )}
        <Hint>{t('settings.privacy.catalog.help')}</Hint>
      </SectionCard>
    </>
  );
}

/**
 * Audio models expose a `dataPolicyBadges` list but no hosting classes, so map
 * the privacy badges onto the same four canonical classes: a self-hosted badge
 * means it can run privately, otherwise a cloud model is public.
 */
function hostingForAudio(model: AudioModelListItem): string[] {
  const badges = new Set(model.dataPolicyBadges ?? []);
  if (badges.has('self_hosted') || badges.has('edge') || badges.has('on_device')) {
    return ['private_cloud'];
  }
  if (badges.has('cloud') || badges.has('no_logging')) return ['public_cloud'];
  return [];
}
