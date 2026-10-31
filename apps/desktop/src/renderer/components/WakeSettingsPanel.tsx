/**
 * Settings → Wake words.
 *
 * Lets the user:
 *  - arm a spoken phrase per agent (manually, or auto-mapped from each agent's
 *    chat name), pick the on-device engine that listens for it, tune
 *    sensitivity, and optionally record a voice sample for a custom on-device
 *    detector;
 *  - add *custom* wake words: any text phrase, matched by on-device speech
 *    recognition (a speech model), or optionally a trained openWakeWord `.onnx`
 *    keyword model the user supplies;
 *  - choose what a wake *does* (open chat / show a compact widget / open the
 *    companion window), whether the transcript is reviewed before it is sent,
 *    the 0..n spoken submit phrases, and what happens to an unsubmitted
 *    transcript after the inactivity timeout;
 *  - run a live detection test right below the master switch.
 *
 * This file is the container: the "what a wake does" form lives here, and the
 * heavier editors (binding card, nickname list, submit phrases, live test,
 * readiness checklist) live under `components/wake/` so no single file grows
 * unmanageable.
 *
 * TRUST: this panel only configures *detection*. The copy is explicit that a wake
 * word is not authentication and cannot approve anything.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  bridge,
  type LocalVoiceState,
  type WakeActivationMode,
  type WakeAgentRow,
  type WakeAutoMapMode,
  type WakeCaptureMode,
  type WakeSettings,
  type WakeSttStatus,
  type WakeUnsentPolicy,
  type WakeWordBinding,
} from '../bridge.js';
import {
  WAKE_TIMEOUT_MAX_SECONDS,
  WAKE_TIMEOUT_MIN_SECONDS,
  aliasKey,
} from '../../shared/wake.js';
import { agentIsAutoMapped, isAutoBinding, phraseFromAgentName } from '../../shared/wake-automap.js';
import { reloadWakeDirector } from '../wake/director-host.js';
import { useVoiceSnapshot } from '../voice/use-voice-store.js';
import { AgentAliasesEditor } from './wake/AgentAliasesEditor.js';
import { BindingEditor } from './wake/BindingEditor.js';
import { LiveDetectionTest } from './wake/LiveDetectionTest.js';
import { SpeechModelReadiness } from './wake/SpeechModelReadiness.js';
import { SubmitPhraseEditor } from './wake/SubmitPhraseEditor.js';
import {
  SUGGESTED_PHRASES,
  ExternalLink,
  button,
  card,
  chip,
  field,
  input,
  inputNeedsAttention,
  section,
  tinyButton,
} from './wake/parts.js';

/**
 * Where to learn how to train and add a custom wake-word model. The text-based
 * path needs no training at all (a speech model matches the phrase), so this is
 * offered as the *optional* "bring your own trained model" route.
 */
const CUSTOM_WAKE_GUIDE_URL = 'https://github.com/dscripka/openWakeWord#training-new-models';
const CUSTOM_WAKE_NOTEBOOK_URL =
  'https://colab.research.google.com/drive/1q1oe2zOyZp7UsB3jJiQ1IFn8z5YfjwEb';

const ACTIVATION_MODES: { id: WakeActivationMode; label: string; help: string }[] = [
  {
    id: 'chat',
    label: 'Open chat and dictate',
    help: "Open the agent's conversation and dictate into the composer with a live transcript.",
  },
  {
    id: 'widget',
    label: 'Compact widget only',
    help: 'Show a small floating card (soundwave, live transcript, agent avatar) without opening chat.',
  },
  {
    id: 'companion',
    label: 'Open the companion view',
    help: "Open the agent's immersive companion window in voice mode, driven by the wake word.",
  },
];

const CAPTURE_MODES: { id: WakeCaptureMode; label: string; help: string }[] = [
  {
    id: 'both',
    label: 'Live preview + audio batch',
    help: 'Stream an on-device transcript as you speak *and* record the audio, so you can send either.',
  },
  {
    id: 'live',
    label: 'Live transcript only',
    help: 'Stream the on-device transcript into the field with no audio recording.',
  },
  {
    id: 'batch',
    label: 'Audio batch only',
    help: 'Record the audio and send it as a voice message (cloud/custom STT); no live preview.',
  },
];

const UNSENT_POLICIES: { id: WakeUnsentPolicy; label: string; help: string }[] = [
  {
    id: 'discard',
    label: 'Discard after the timeout',
    help: 'An accidental background activation is dropped — nothing is kept.',
  },
  {
    id: 'queue',
    label: 'Keep for review',
    help: 'Park the transcript and show it the next time chat opens, so you can send or dismiss it.',
  },
];

function newBindingId(): string {
  return `wake-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function emptyBinding(): WakeWordBinding {
  return {
    id: newBindingId(),
    phrase: '',
    aliases: [],
    agentId: null,
    agentName: null,
    modelId: null,
    sensitivity: 0.5,
    enabled: true,
    sampleRef: null,
    sampleFingerprint: null,
  };
}

export function WakeSettingsPanel() {
  const [settings, setSettings] = useState<WakeSettings | null>(null);
  const [agents, setAgents] = useState<WakeAgentRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  /** The phrase/model the live test should arm (defaults to the first binding). */
  const [testPhrase, setTestPhrase] = useState('');
  const [testModelId, setTestModelId] = useState<string | null>(null);
  const testInit = useRef(false);
  /** Whether the custom-wake-word "how to train" help is expanded. */
  const [showTrainingHelp, setShowTrainingHelp] = useState(false);

  // Local-voice facts (models, runner, wake STT readiness) come from the shared
  // store, so installing a model in the panel above is reflected here live.
  const snapshot = useVoiceSnapshot();
  const voice = snapshot.state;
  const sttStatus: WakeSttStatus | null = snapshot.wakeStt;
  const binary = snapshot.binary;

  const refreshSettings = useCallback(async () => {
    setSettings(await bridge.wakeGetSettings());
  }, []);

  useEffect(() => {
    void refreshSettings();
    // The agent directory needs a signed-in sender; a failure just leaves it empty.
    void bridge.wakeListAgents().then(setAgents).catch(() => setAgents([]));
  }, [refreshSettings]);

  // Seed the live-test fields from the first binding once, so the test box is
  // useful without extra typing.
  useEffect(() => {
    if (testInit.current || !settings) return;
    const first = settings.bindings[0];
    if (first) {
      testInit.current = true;
      setTestPhrase(first.phrase);
      setTestModelId(first.modelId);
    }
  }, [settings]);

  const persist = useCallback(async (next: WakeSettings) => {
    setBusy(true);
    setSaved(false);
    try {
      const written = await bridge.wakeSetSettings(next);
      setSettings(written);
      // Reconcile the live director so the change applies without a restart.
      await reloadWakeDirector();
      setSaved(true);
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * When auto-mapping is on but no model is chosen, default to the first
   * installed speech model. Auto-mapping maps an agent to its own name, which
   * only a speech model can match, so without this the feature is silently inert.
   */
  useEffect(() => {
    if (!settings || !voice || !settings.autoMapAgents || settings.autoMapModelId) return;
    const installed = voice.models.find((m) => m.kind === 'stt' && m.installState === 'installed');
    if (installed) void persist({ ...settings, autoMapModelId: installed.id });
  }, [settings, voice, persist]);

  const manualBindings = useMemo(
    () => (settings?.bindings ?? []).filter((b) => !isAutoBinding(b)),
    [settings],
  );

  /**
   * Every phrase a wake can be addressed by, for the nickname editor: the manual
   * bindings plus each auto-mapped agent's derived name (so an alias can be
   * given to an agent the user never hand-configured). Binding/agent names are
   * deduped case-insensitively, and a phrase already covered by a manual binding
   * is not listed twice.
   *
   * NOTE: this hook must run on *every* render, so it is deliberately above the
   * `if (!settings)` loading return — placing it after caused React's
   * "Rendered more hooks than during the previous render" crash.
   */
  const aliasRows = useMemo(() => {
    const rows: { phrase: string; label: string }[] = [];
    const seen = new Set<string>();
    const push = (phrase: string | null, label: string) => {
      const trimmed = (phrase ?? '').trim();
      if (!trimmed) return;
      const key = aliasKey(trimmed);
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({ phrase: trimmed, label });
    };
    for (const b of manualBindings) push(b.phrase, b.agentName ?? b.phrase);
    if (settings?.autoMapAgents) {
      for (const agent of agents) {
        if (!agentIsAutoMapped(agent.contactId, settings.autoMapMode, settings.autoMapIds)) continue;
        if (manualBindings.some((b) => b.agentId === agent.contactId)) continue;
        push(phraseFromAgentName(agent.name), agent.name);
      }
    }
    return rows;
  }, [agents, manualBindings, settings]);

  if (!settings) {
    return (
      <section style={section}>
        <h2 style={{ margin: 0, fontSize: 15 }}>Wake words</h2>
        <p style={{ margin: 0, color: '#6b7784', fontSize: 12 }}>Loading…</p>
      </section>
    );
  }

  const wakeModels = (voice?.models ?? []).filter((m) => m.kind === 'wake');
  const sttModels = (voice?.models ?? []).filter((m) => m.kind === 'stt');
  // Both flavours are selectable as a wake engine: a fixed-phrase keyword model,
  // or an installed speech model that lets the binding wake on ANY phrase.
  const patternModels: LocalVoiceState['models'] = [...wakeModels, ...sttModels];
  const installedStt = sttModels.filter((m) => m.installState === 'installed');
  /** A chosen model that needs on-device transcription rather than a keyword hit. */
  const isSttModel = (modelId: string | null) =>
    Boolean(modelId && sttModels.some((m) => m.id === modelId));
  const updateBinding = (id: string, next: WakeWordBinding) =>
    void persist({
      ...settings,
      bindings: settings.bindings.map((b) => (b.id === id ? next : b)),
    });

  /** Removing an auto-mapped binding excludes that agent from auto-mapping. */
  const removeBinding = (binding: WakeWordBinding) => {
    if (isAutoBinding(binding) && binding.agentId) {
      const autoMapIds = settings.autoMapIds.includes(binding.agentId)
        ? settings.autoMapIds
        : [...settings.autoMapIds, binding.agentId];
      void persist({ ...settings, autoMapIds });
      return;
    }
    void persist({
      ...settings,
      bindings: settings.bindings.filter((b) => b.id !== binding.id),
    });
  };

  /** Toggle an agent's membership in the auto-map list (block vs allow list). */
  const toggleAutoMapId = (contactId: string, listed: boolean) =>
    void persist({
      ...settings,
      autoMapIds: listed
        ? settings.autoMapIds.filter((id) => id !== contactId)
        : [...settings.autoMapIds, contactId],
    });

  /** Add a fresh custom wake word (any text phrase; model optional). */
  const addWakeWord = () => {
    // Pre-select the first installed speech model so a new word is usable at once.
    const fallbackModel = settings.autoMapModelId ?? installedStt[0]?.id ?? null;
    void persist({
      ...settings,
      bindings: [...settings.bindings, { ...emptyBinding(), modelId: fallbackModel }],
    });
  };

  /** True when the live-test model is a speech model (test supports both now). */
  const testUsesStt = isSttModel(testModelId);

  /**
   * True when this configuration depends on on-device wake transcription: at
   * least one binding uses a speech model, or auto-mapping is on (it maps each
   * agent to its own name, which only a speech model can match). Surfaced so the
   * panel can explain an inert setup instead of failing silently.
   */
  const needsStt =
    settings.autoMapAgents ||
    settings.bindings.some((b) => isSttModel(b.modelId)) ||
    isSttModel(settings.autoMapModelId);

  return (
    <section style={section}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 15 }}>Wake words</h2>
        <span style={{ flex: 1 }} />
        {saved ? <span style={{ color: '#4ade80', fontSize: 12 }}>Saved</span> : null}
      </div>
      <p style={{ margin: 0, color: '#6b7784', fontSize: 11, lineHeight: 1.5 }}>
        Say a phrase to open an agent&apos;s chat and start dictation. Detection runs{' '}
        <strong>entirely on this device</strong> — nothing is reported, not even that a word fired.
        Install a speech model in “Local speech models” above to wake on <em>any</em> phrase
        (including each agent&apos;s name), or a wake-word model for a fixed phrase.
      </p>

      <label style={{ ...field, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <input
          type="checkbox"
          checked={settings.enabled}
          disabled={busy}
          onChange={(e) => void persist({ ...settings, enabled: e.target.checked })}
        />
        <span style={{ color: '#e8eef4' }}>Listen for wake words on this device</span>
        <span style={{ flex: 1 }} />
        {binary ? (
          <span style={{ fontSize: 11, color: binary.installed ? '#4ade80' : '#6b7784' }}>
            engine {binary.installed ? 'ready' : 'not installed'}
          </span>
        ) : null}
      </label>

      {/* Live detection test sits right below the switch. */}
      <LiveDetectionTest
        phrase={testPhrase}
        modelId={testModelId}
        sensitivity={0.5}
        disabled={busy}
        blockedReason={testUsesStt && sttStatus && !sttStatus.ready ? sttStatus.reason : null}
      />
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <label style={{ ...field, flex: 1, minWidth: 180 }}>
          <span>Test phrase</span>
          <input
            style={input}
            value={testPhrase}
            placeholder="Hey Jarvis"
            list="wake-phrases-test"
            disabled={busy}
            onChange={(e) => setTestPhrase(e.target.value)}
          />
          <datalist id="wake-phrases-test">
            {SUGGESTED_PHRASES.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </label>
        <label style={{ ...field, flex: 1, minWidth: 180 }}>
          <span>Test engine</span>
          <select
            style={input}
            value={testModelId ?? ''}
            disabled={busy}
            onChange={(e) => setTestModelId(e.target.value || null)}
          >
            <option value="">Choose a model…</option>
            {patternModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
                {model.kind === 'stt' ? ' · speech' : ''}
                {model.installState === 'installed' ? ' ✓ installed' : ' (not installed)'}
              </option>
            ))}
          </select>
        </label>
      </div>

      {needsStt ? <SpeechModelReadiness status={sttStatus} /> : null}

      <label style={field}>
        <span>What a wake does</span>
        <select
          style={input}
          value={settings.activationMode}
          disabled={busy}
          onChange={(e) =>
            void persist({ ...settings, activationMode: e.target.value as WakeActivationMode })
          }
        >
          {ACTIVATION_MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <span style={{ color: '#6b7784' }}>
          {ACTIVATION_MODES.find((m) => m.id === settings.activationMode)?.help}
        </span>
      </label>

      <label style={field}>
        <span>Capture</span>
        <select
          style={input}
          value={settings.captureMode}
          disabled={busy}
          onChange={(e) =>
            void persist({ ...settings, captureMode: e.target.value as WakeCaptureMode })
          }
        >
          {CAPTURE_MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <span style={{ color: '#6b7784' }}>
          {CAPTURE_MODES.find((m) => m.id === settings.captureMode)?.help}
        </span>
      </label>

      <label style={{ ...field, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <input
          type="checkbox"
          checked={settings.companionOnWake}
          disabled={busy}
          onChange={(e) => void persist({ ...settings, companionOnWake: e.target.checked })}
        />
        <span>
          Open the referenced agent in the companion window + voice mode on a wake (overrides the
          mode above; also toggleable from the listening widget)
        </span>
      </label>

      <label style={{ ...field, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <input
          type="checkbox"
          checked={settings.reviewBeforeSend}
          disabled={busy}
          onChange={(e) => void persist({ ...settings, reviewBeforeSend: e.target.checked })}
        />
        <span>
          Review the transcript before sending (a wake never auto-sends; realtime voice calls still do)
        </span>
      </label>

      <SubmitPhraseEditor
        phrases={settings.submitPhrases}
        busy={busy}
        onChange={(submitPhrases) => void persist({ ...settings, submitPhrases })}
      />

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <label style={{ ...field, minWidth: 190 }}>
          <span>Timeout for an unsubmitted transcript (seconds)</span>
          <input
            style={input}
            type="number"
            min={WAKE_TIMEOUT_MIN_SECONDS}
            max={WAKE_TIMEOUT_MAX_SECONDS}
            value={settings.activationTimeoutSeconds}
            disabled={busy}
            onChange={(e) =>
              void persist({ ...settings, activationTimeoutSeconds: Number(e.target.value) })
            }
          />
        </label>
        <label style={{ ...field, flex: 1, minWidth: 190 }}>
          <span>When the timeout fires</span>
          <select
            style={input}
            value={settings.unsentPolicy}
            disabled={busy}
            onChange={(e) => void persist({ ...settings, unsentPolicy: e.target.value as WakeUnsentPolicy })}
          >
            {UNSENT_POLICIES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <span style={{ color: '#6b7784' }}>
            {UNSENT_POLICIES.find((p) => p.id === settings.unsentPolicy)?.help}
          </span>
        </label>
      </div>

      <div style={card}>
        <label style={{ ...field, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <input
            type="checkbox"
            checked={settings.autoMapAgents}
            disabled={busy}
            onChange={(e) => void persist({ ...settings, autoMapAgents: e.target.checked })}
          />
          <span style={{ color: '#e8eef4' }}>
            Auto-map agents to wake words (each agent&apos;s chat name)
          </span>
        </label>
        {settings.autoMapAgents ? (
          <>
            <label style={field}>
              <span>
                Auto-map engine
                {!settings.autoMapModelId && installedStt.length ? (
                  <span style={{ color: '#fbbf24' }}> · selecting…</span>
                ) : null}
              </span>
              <select
                style={!settings.autoMapModelId ? inputNeedsAttention : input}
                value={settings.autoMapModelId ?? ''}
                disabled={busy}
                onChange={(e) => void persist({ ...settings, autoMapModelId: e.target.value || null })}
              >
                <option value="">Choose a speech model…</option>
                {sttModels.length ? (
                  sttModels.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                      {model.installState === 'installed' ? ' ✓ installed' : ' (not installed)'}
                    </option>
                  ))
                ) : (
                  <option value="" disabled>
                    No speech model installed — add one in Local speech models
                  </option>
                )}
              </select>
              <span style={{ color: '#6b7784' }}>
                An agent is woken by its own name, so auto-mapped agents use a speech model that
                transcribes locally and matches the name as text.
              </span>
            </label>
            <label style={field}>
              <span>Auto-map mode</span>
              <select
                style={input}
                value={settings.autoMapMode}
                disabled={busy}
                onChange={(e) =>
                  void persist({ ...settings, autoMapMode: e.target.value as WakeAutoMapMode })
                }
              >
                <option value="blocklist">Blocklist — map every agent except the ones I exclude</option>
                <option value="whitelist">Whitelist — map only the agents I include</option>
              </select>
            </label>
            <div style={field}>
              <span>Agents</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {agents.length ? (
                  agents.map((agent) => {
                    const listed = settings.autoMapIds.includes(agent.contactId);
                    return (
                      <label key={agent.contactId} style={{ ...chip, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={listed}
                          disabled={busy}
                          onChange={() => toggleAutoMapId(agent.contactId, listed)}
                        />
                        {agent.name}
                      </label>
                    );
                  })
                ) : (
                  <span style={{ color: '#6b7784' }}>Sign in to list agents.</span>
                )}
              </div>
              <span style={{ color: '#6b7784' }}>
                {settings.autoMapMode === 'blocklist'
                  ? 'Checked agents are excluded from auto-mapping.'
                  : 'Only checked agents are auto-mapped.'}
              </span>
            </div>
          </>
        ) : null}
      </div>

      <AgentAliasesEditor
        rows={aliasRows}
        agentAliases={settings.agentAliases}
        enabled={installedStt.length > 0}
        busy={busy}
        onChange={(agentAliases) => void persist({ ...settings, agentAliases })}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ fontSize: 12, color: '#9aa7b5' }}>Your wake words</strong>
        <span style={{ flex: 1 }} />
        <ExternalWakeLinks />
      </div>

      {manualBindings.length ? (
        manualBindings.map((binding) => (
          <BindingEditor
            key={binding.id}
            binding={binding}
            agents={agents}
            wakeModels={patternModels}
            busy={busy}
            isSttModel={isSttModel}
            onChange={(next) => updateBinding(binding.id, next)}
            onRemove={() => removeBinding(binding)}
          />
        ))
      ) : (
        <span style={{ fontSize: 11, color: '#6b7784' }}>
          No custom wake words yet. Add one below, or turn on auto-mapping to use each agent&apos;s
          name.
        </span>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" style={button} disabled={busy} onClick={addWakeWord}>
          + Add a wake word
        </button>
        <button
          type="button"
          style={tinyButton}
          onClick={() => setShowTrainingHelp((v) => !v)}
        >
          {showTrainingHelp ? 'Hide training guide' : 'Train your own wake word'}
        </button>
        {!patternModels.length ? (
          <span style={{ color: '#fbbf24', fontSize: 11 }}>
            No wake or speech models in the catalog yet — use “Refresh catalog” in Local speech models.
          </span>
        ) : installedStt.length === 0 && wakeModels.every((m) => m.installState !== 'installed') ? (
          <span style={{ color: '#fbbf24', fontSize: 11 }}>
            Install a speech model (any phrase) or a wake-word model above to arm a wake word.
          </span>
        ) : null}
      </div>

      {showTrainingHelp ? (
        <div style={{ ...card, background: '#101823' }}>
          <strong style={{ fontSize: 12, color: '#e8eef4' }}>Custom wake words</strong>
          <p style={{ margin: 0, fontSize: 11, color: '#9aa7b5', lineHeight: 1.55 }}>
            A wake word is just text by default: any phrase (an agent name, a nickname) is matched by
            on-device speech recognition — no training needed. Optionally, you can bring your own
            trained <strong>openWakeWord</strong> keyword model for a fixed phrase; it fires faster
            on low-power machines.
          </p>
          <ol style={{ margin: 0, paddingLeft: 16, fontSize: 11, color: '#9aa7b5', lineHeight: 1.6 }}>
            <li>
              Text-only (recommended): install a speech model above, add a wake word, and choose the
              speech model as its engine.
            </li>
            <li>
              Trained model: train an openWakeWord <code>.onnx</code> for your phrase, then install it
              under “Local speech models”.
            </li>
          </ol>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <ExternalLink href={CUSTOM_WAKE_GUIDE_URL}>openWakeWord training guide</ExternalLink>
            <ExternalLink href={CUSTOM_WAKE_NOTEBOOK_URL}>Training notebook (Colab)</ExternalLink>
            <ExternalLink href="https://github.com/ggerganov/whisper.cpp">
              whisper.cpp (speech models)
            </ExternalLink>
          </div>
        </div>
      ) : null}

      {!agents.length ? (
        <span style={{ color: '#6b7784', fontSize: 11 }}>
          Sign in to list the agents a wake word can activate.
        </span>
      ) : null}
    </section>
  );
}

/** The "how to train a custom model" link, kept out of the main JSX for length. */
function ExternalWakeLinks() {
  return (
    <ExternalLink href={CUSTOM_WAKE_GUIDE_URL}>How to train a custom model</ExternalLink>
  );
}
