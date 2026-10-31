/**
 * Settings → Agents (per-agent overrides).
 *
 * One row per agent a wake can address (`bridge.wakeListAgents()`), gathering the
 * overrides that are genuinely per-agent — several of which already existed in
 * pieces elsewhere — into a single, discoverable place:
 *
 *  - **Avatar**: which local library model this agent renders as (the mapping
 *    table formerly living in `LocalAvatarsPanel`).
 *  - **Reply voice**: the contact-level TTS model + voice override
 *    (`anx.agents.contact-tts.get/set/clear`), set on the *contact* so a
 *    non-owner can personalise an agent's voice.
 *  - **Wake nickname**: extra phrases that wake this agent ("Zeni" for "Xeni"),
 *    stored in `WakeSettings.agentAliases` (phrase-keyed, so it also works for
 *    auto-mapped agents).
 *  - **Companion**: a placement-mode override (or inherit the global mode) and an
 *    "open on message" opt-in, both persisted in `UiSettings.contactOverrides`.
 *
 * The settings surface is mounted while chat is not, so this reads the region
 * through a small local `CommandClient` (the same ANX envelope every client uses)
 * rather than the chat SPA's client.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  clearContactTts,
  contactTtsNeedsSetup,
  getContactTts,
  listAudioModels,
  listTtsVoices,
  setContactTts,
  type AudioModelListItem,
  type ContactTtsView,
  type TtsVoiceListItem,
} from '@nexus/chat-core';
import {
  bridge,
  COMPANION_PLACEMENT_MODES,
  placementModeForContact,
  type CompanionPlacementMode,
  type ContactOverride,
  type ContactOverrides,
  type WakeAgentRow,
  type WakeSettings,
} from '../../bridge.js';
import {
  MAX_WAKE_ALIASES,
  aliasKey,
  aliasesForPhrase,
  normalizeAliasPhrase,
} from '../../../shared/wake.js';
import { useI18n, type MessageKey } from '../../i18n/index.js';
import { createDesktopCommandClient, type DesktopIdentity } from './desktopCommandClient.js';
import {
  Field,
  SectionCard,
  settingsButton,
  settingsChip,
  settingsGhostButton,
  settingsHint,
  settingsInput,
  settingsMuted,
  settingsTinyButton,
} from './settings-ui.js';

/** i18n key for a placement mode's label (shared with the companion section). */
const PLACEMENT_MODE_LABEL: Record<CompanionPlacementMode, MessageKey> = {
  'bottom-right': 'settings.companion.placement.mode.bottomRight',
  'bottom-left': 'settings.companion.placement.mode.bottomLeft',
  'top-right': 'settings.companion.placement.mode.topRight',
  'top-left': 'settings.companion.placement.mode.topLeft',
  center: 'settings.companion.placement.mode.center',
  'right-of-main': 'settings.companion.placement.mode.rightOfMain',
  'remember-last': 'settings.companion.placement.mode.rememberLast',
};

/** Per-row mutable editor state (loaded lazily; separate from persisted settings). */
type PerAgent = {
  tts: ContactTtsView | null;
  ttsModelId: string;
  ttsVoiceId: string;
  ttsBusy: boolean;
  ttsError: string | null;
  voices: TtsVoiceListItem[];
  voicesLoading: boolean;
};

function blankPerAgent(view: ContactTtsView | null): PerAgent {
  return {
    tts: view,
    ttsModelId: view?.ttsModelId ?? '',
    ttsVoiceId: view?.ttsVoicePreset ?? '',
    ttsBusy: false,
    ttsError: null,
    voices: [],
    voicesLoading: false,
  };
}

export function AgentsSection() {
  const { t } = useI18n();
  const [agents, setAgents] = useState<WakeAgentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [avatars, setAvatars] = useState<{ id: string; label: string }[]>([]);
  const [avatarMap, setAvatarMap] = useState<Record<string, string>>({});
  const [overrides, setOverrides] = useState<ContactOverrides>({});
  const [wake, setWake] = useState<WakeSettings | null>(null);
  const [ttsModels, setTtsModels] = useState<AudioModelListItem[]>([]);
  const [state, setState] = useState<Record<string, PerAgent>>({});
  const [client, setClient] = useState<ReturnType<typeof createDesktopCommandClient> | null>(null);
  const [busy, setBusy] = useState(false);

  // Build the command client (region URL + active identity) and load everything
  // the rows need. Any failure degrades locally: the section still lists agents.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [connection, auth, config, list, wakeSettings, ui] = await Promise.all([
          bridge.getConnectionConfig(),
          bridge.getAuthState(),
          bridge.localAvatarsList().catch(() => null),
          bridge.wakeListAgents().catch(() => [] as WakeAgentRow[]),
          bridge.wakeGetSettings().catch(() => null),
          bridge.getUiSettings(),
        ]);
        if (cancelled) return;
        setAvatars(config?.avatars.map((a) => ({ id: a.id, label: a.label })) ?? []);
        setAvatarMap(config?.contactMappings ?? {});
        setAgents(list);
        setWake(wakeSettings);
        setOverrides(ui.contactOverrides ?? {});

        if (auth.status === 'signed_in') {
          const identity: DesktopIdentity = {
            token: auth.token,
            userId: auth.identity.userId ?? null,
            orgId: auth.identity.orgId ?? null,
            role: auth.identity.role ?? null,
            deviceId: auth.identity.deviceId ?? null,
          };
          const next = createDesktopCommandClient({ apiBaseUrl: connection.regionUrl, identity });
          setClient(next);
          void listAudioModels(next, 'tts')
            .then((models) => !cancelled && setTtsModels(models))
            .catch(() => undefined);
          // Fetch each contact's current TTS override so the row shows the truth.
          const entries = await Promise.all(
            list.map(async (agent) => {
              const view = await getContactTts(next, { agentId: agent.contactId }).catch(() => null);
              return [agent.contactId, blankPerAgent(view)] as const;
            }),
          );
          if (!cancelled) setState(Object.fromEntries(entries));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const patchOverride = useCallback(
    async (contactId: string, next: Partial<ContactOverride>) => {
      setBusy(true);
      try {
        const current: ContactOverride = { ...(overrides[contactId] ?? {}), ...next };
        // Drop keys the user cleared (undefined) so the entry disappears cleanly.
        for (const key of Object.keys(current) as (keyof ContactOverride)[]) {
          if (current[key] === undefined) delete current[key];
        }
        const merged: ContactOverrides = { ...overrides };
        if (Object.keys(current).length) merged[contactId] = current;
        else delete merged[contactId];
        const ui = await bridge.setUiSettings({ contactOverrides: merged });
        setOverrides(ui.contactOverrides ?? {});
      } finally {
        setBusy(false);
      }
    },
    [overrides],
  );

  const mapAvatar = useCallback(async (contactId: string, avatarId: string | null) => {
    setBusy(true);
    try {
      const config = await bridge.localAvatarsSetMapping(contactId, avatarId);
      setAvatarMap(config.contactMappings ?? {});
    } finally {
      setBusy(false);
    }
  }, []);

  const patchAlias = useCallback(
    async (phrase: string, aliases: string[]) => {
      if (!wake) return;
      setBusy(true);
      try {
        const key = aliasKey(phrase);
        const nextAliases = { ...wake.agentAliases };
        if (aliases.length) nextAliases[key] = aliases;
        else delete nextAliases[key];
        setWake(await bridge.wakeSetSettings({ ...wake, agentAliases: nextAliases }));
      } finally {
        setBusy(false);
      }
    },
    [wake],
  );

  const update = useCallback((contactId: string, patch: Partial<PerAgent>) => {
    setState((cur) => ({
      ...cur,
      [contactId]: { ...(cur[contactId] ?? blankPerAgent(null)), ...patch },
    }));
  }, []);

  const loadVoices = useCallback(
    async (contactId: string, modelId: string) => {
      if (!client || !modelId) {
        update(contactId, { voices: [] });
        return;
      }
      update(contactId, { voicesLoading: true });
      try {
        const result = await listTtsVoices(client, { modelId });
        update(contactId, { voices: result.voices, voicesLoading: false });
      } catch {
        update(contactId, { voices: [], voicesLoading: false });
      }
    },
    [client, update],
  );

  const saveTts = useCallback(
    async (contactId: string) => {
      if (!client) return;
      const row = state[contactId];
      if (!row?.ttsModelId) return;
      update(contactId, { ttsBusy: true, ttsError: null });
      try {
        const view = await setContactTts(client, {
          agentId: contactId,
          ttsModelId: row.ttsModelId,
          ttsVoicePreset: row.ttsVoiceId || null,
        });
        update(contactId, { tts: view, ttsBusy: false });
      } catch (err) {
        update(contactId, {
          ttsBusy: false,
          ttsError: err instanceof Error ? err.message : t('settings.agents.tts.failed'),
        });
      }
    },
    [client, state, update, t],
  );

  const clearTts = useCallback(
    async (contactId: string) => {
      if (!client) return;
      update(contactId, { ttsBusy: true, ttsError: null });
      try {
        const view = await clearContactTts(client, { agentId: contactId });
        update(contactId, { tts: view, ttsModelId: '', ttsVoiceId: '', voices: [], ttsBusy: false });
      } catch (err) {
        update(contactId, {
          ttsBusy: false,
          ttsError: err instanceof Error ? err.message : t('settings.agents.tts.failed'),
        });
      }
    },
    [client, update, t],
  );

  const runnableTtsModels = useMemo(() => ttsModels.filter((m) => m.runnable), [ttsModels]);

  if (loading) {
    return (
      <SectionCard title={t('settings.agents')} help={t('settings.agents.help')}>
        <p style={settingsMuted}>{t('settings.loading')}</p>
      </SectionCard>
    );
  }

  if (!agents.length) {
    return (
      <SectionCard title={t('settings.agents')} help={t('settings.agents.help')}>
        <p style={settingsMuted}>{t('settings.agents.empty')}</p>
      </SectionCard>
    );
  }

  // The global placement mode the per-agent override inherits (shown in the
  // "inherit" option so the user sees what the default actually is).
  const inheritMode = placementModeForContact({ overrides: {}, contactId: null, globalMode: 'bottom-right' });

  return (
    <SectionCard title={t('settings.agents')} help={t('settings.agents.help')}>
      {agents.map((agent) => {
        const row = state[agent.contactId] ?? blankPerAgent(null);
        const override = overrides[agent.contactId] ?? {};
        const aliases = aliasesForPhrase(wake?.agentAliases ?? {}, agent.name);
        const mappedAvatar = avatarMap[agent.contactId] ?? '';
        const avatarValue = avatars.some((a) => a.id === mappedAvatar) ? mappedAvatar : '';
        return (
          <div key={agent.contactId} style={agentCard}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong style={{ fontSize: 13 }}>{agent.name}</strong>
              {!agent.canConfigure ? <span style={settingsMuted}>{t('settings.agents.shared')}</span> : null}
              <span style={{ flex: 1 }} />
            </div>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {/* Avatar from the local library. */}
              <Field label={t('settings.agents.avatar')} rowStyle={{ ...agentField, flex: 1, minWidth: 180 }}>
                <select
                  style={settingsInput}
                  value={avatarValue}
                  disabled={busy}
                  onChange={(e) => void mapAvatar(agent.contactId, e.target.value || null)}
                >
                  <option value="">{t('settings.agents.avatar.default')}</option>
                  {avatars.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </Field>

              {/* Companion placement override (or inherit the global mode). */}
              <Field label={t('settings.agents.placement')} rowStyle={{ ...agentField, flex: 1, minWidth: 180 }}>
                <select
                  style={settingsInput}
                  value={override.placementMode ?? ''}
                  disabled={busy}
                  onChange={(e) =>
                    void patchOverride(agent.contactId, {
                      placementMode: (e.target.value || undefined) as CompanionPlacementMode | undefined,
                    })
                  }
                >
                  <option value="">
                    {t('settings.agents.placement.inherit', { mode: t(PLACEMENT_MODE_LABEL[inheritMode]) })}
                  </option>
                  {COMPANION_PLACEMENT_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {t(PLACEMENT_MODE_LABEL[mode])}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            {/* Wake nicknames. */}
            <div style={agentField}>
              <span>{t('settings.agents.wakeAliases')}</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                {aliases.map((a) => (
                  <span key={a} style={settingsChip}>
                    “{a}”
                    <button
                      type="button"
                      style={chipRemove}
                      disabled={busy}
                      onClick={() => void patchAlias(agent.name, aliases.filter((x) => x !== a))}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <AliasAdder
                  busy={busy || !wake || aliases.length >= MAX_WAKE_ALIASES}
                  primary={agent.name}
                  onAdd={(alias) => void patchAlias(agent.name, [...aliases, alias])}
                />
              </div>
              <span style={settingsHint}>{t('settings.agents.wakeAliases.help')}</span>
            </div>

            {/* Reply voice (contact-level TTS override). */}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Field label={t('settings.agents.ttsModel')} rowStyle={{ ...agentField, flex: 1, minWidth: 180 }}>
                <select
                  style={settingsInput}
                  value={row.ttsModelId}
                  disabled={row.ttsBusy || !client}
                  onChange={(e) => {
                    update(agent.contactId, { ttsModelId: e.target.value });
                    void loadVoices(agent.contactId, e.target.value);
                  }}
                >
                  <option value="">{t('settings.agents.tts.inherit')}</option>
                  {runnableTtsModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName || m.id}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('settings.agents.ttsVoice')} rowStyle={{ ...agentField, flex: 1, minWidth: 180 }}>
                <select
                  style={settingsInput}
                  value={row.ttsVoiceId}
                  disabled={row.ttsBusy || !row.voices.length}
                  onChange={(e) => update(agent.contactId, { ttsVoiceId: e.target.value })}
                >
                  <option value="">
                    {row.voicesLoading
                      ? t('settings.loading')
                      : row.voices.length
                        ? t('settings.agents.ttsVoice.default')
                        : t('settings.agents.ttsVoice.none')}
                  </option>
                  {row.voices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.title || v.id}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                type="button"
                style={settingsButton}
                disabled={row.ttsBusy || !row.ttsModelId || !client}
                onClick={() => void saveTts(agent.contactId)}
              >
                {t('settings.agents.tts.save')}
              </button>
              <button
                type="button"
                style={settingsGhostButton}
                disabled={row.ttsBusy || !client}
                onClick={() => void clearTts(agent.contactId)}
              >
                {t('settings.agents.tts.clear')}
              </button>
              {row.tts && !contactTtsNeedsSetup(row.tts) ? (
                <span style={{ color: '#4ade80', fontSize: 11 }}>
                  {t('settings.agents.tts.effective', {
                    model: row.tts.effectiveTtsModelId ?? '—',
                    voice: row.tts.effectiveVoicePreset ?? t('settings.agents.ttsVoice.default'),
                  })}
                </span>
              ) : null}
              {row.ttsError ? <span style={{ color: '#f2a1a1', fontSize: 11 }}>{row.ttsError}</span> : null}
            </div>

            {/* Open this agent's companion on an unattended message. */}
            <label style={{ ...agentField, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={override.openCompanionOnMessage === true}
                disabled={busy}
                onChange={(e) =>
                  void patchOverride(agent.contactId, {
                    openCompanionOnMessage: e.target.checked ? true : undefined,
                  })
                }
              />
              <span style={{ color: '#e8eef4' }}>{t('settings.agents.openCompanion')}</span>
            </label>
          </div>
        );
      })}
    </SectionCard>
  );
}

/** A throwaway row: an input + Add button for a new nickname. */
function AliasAdder({
  primary,
  busy,
  onAdd,
}: {
  primary: string;
  busy: boolean;
  onAdd: (alias: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const alias = normalizeAliasPhrase(draft, primary);
    setDraft('');
    if (alias) onAdd(alias);
  };
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <input
        style={{ ...settingsInput, width: 140 }}
        value={draft}
        disabled={busy}
        placeholder="e.g. nickname"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add();
          }
        }}
      />
      <button type="button" style={settingsTinyButton} disabled={busy || !draft.trim()} onClick={add}>
        +
      </button>
    </span>
  );
}

const agentCard: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: 12,
  borderRadius: 10,
  background: '#0f1419',
  border: '1px solid #2a333d',
};

const agentField: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 12,
  color: '#9aa7b5',
};

const chipRemove: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: '#f2a1a1',
  cursor: 'pointer',
  fontSize: 12,
};
