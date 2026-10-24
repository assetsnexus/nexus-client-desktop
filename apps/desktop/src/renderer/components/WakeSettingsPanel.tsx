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
 * Layout is deliberately compact: each binding is a single dense card, and the
 * "readiness" checklist highlights exactly which field still needs configuring
 * so a user who installed a model can see *why* a wake is not listening yet.
 *
 * TRUST: this panel only configures *detection*. The copy is explicit that a wake
 * word is not authentication and cannot approve anything.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
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
  MAX_WAKE_ALIASES,
  SUGGESTED_SUBMIT_PHRASES,
  WAKE_TIMEOUT_MAX_SECONDS,
  WAKE_TIMEOUT_MIN_SECONDS,
  aliasKey,
  aliasesForPhrase,
  bindingPhrases,
  isLargeWakeModel,
  normalizeAliasPhrase,
} from '../../shared/wake.js';
import { agentIsAutoMapped, isAutoBinding, phraseFromAgentName } from '../../shared/wake-automap.js';
import { reloadWakeDirector } from '../wake/director-host.js';
import { createUtteranceSource } from '../wake/utterance.js';
import { startEnrollment, type EnrollmentSession } from '../wake/enroll.js';
import { createWakeLiveTest, type WakeLiveTest, type WakeLiveTestState } from '../wake/live-test.js';
import { useVoiceSnapshot } from '../voice/use-voice-store.js';

/**
 * Where to learn how to train and add a custom wake-word model. The text-based
 * path needs no training at all (a speech model matches the phrase), so this is
 * offered as the *optional* "bring your own trained model" route.
 */
const CUSTOM_WAKE_GUIDE_URL = 'https://github.com/dscripka/openWakeWord#training-new-models';
const CUSTOM_WAKE_NOTEBOOK_URL =
  'https://colab.research.google.com/drive/1q1oe2zOyZp7UsB3jJiQ1IFn8z5YfjwEb';

const section: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: 14,
  borderRadius: 12,
  background: '#151b22',
  border: '1px solid #2a333d',
};

const field: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 12,
  color: '#9aa7b5',
};

const input: CSSProperties = {
  padding: '6px 9px',
  borderRadius: 8,
  border: '1px solid #3a4654',
  background: '#0f1419',
  color: '#e8eef4',
  fontSize: 13,
};

/** Input that is missing a required value, so the user sees what to fill in. */
const inputNeedsAttention: CSSProperties = {
  ...input,
  borderColor: '#a16207',
  boxShadow: '0 0 0 2px rgba(234,179,8,0.14)',
};

const button: CSSProperties = {
  alignSelf: 'flex-start',
  padding: '5px 11px',
  borderRadius: 8,
  border: '1px solid #3f6cb0',
  background: '#2f5c9e',
  color: '#fff',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
};

const ghostButton: CSSProperties = {
  ...button,
  background: '#1c2430',
  borderColor: '#3a4654',
  color: '#e8eef4',
  fontWeight: 500,
};

const tinyButton: CSSProperties = {
  ...ghostButton,
  padding: '2px 8px',
  fontSize: 11,
};

const recordButtonActive: CSSProperties = {
  ...button,
  background: '#9f1239',
  borderColor: '#e11d48',
};

const card: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 10,
  borderRadius: 10,
  background: '#0f1419',
  border: '1px solid #2a333d',
};

const chip: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '2px 8px',
  borderRadius: 999,
  background: '#1c2430',
  border: '1px solid #3a4654',
  fontSize: 11,
  color: '#cbd5e1',
};

const linkButton: CSSProperties = {
  padding: 0,
  border: 'none',
  background: 'none',
  color: '#7fb2ff',
  cursor: 'pointer',
  fontSize: 11,
  textDecoration: 'underline',
};

/** Suggested phrases matching the built-in wake models. */
const SUGGESTED_PHRASES = ['Hey Jarvis', 'Alexa', 'Hey Mycroft'];

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

/** A small inline link that opens a documentation URL in the system browser. */
function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <button type="button" style={linkButton} title={href} onClick={() => void bridge.openExternal(href)}>
      {children}
    </button>
  );
}

/**
 * Readiness checklist for speech-model (`stt_phrase`) wake words. Turns an opaque
 * "cannot listen yet" banner into a concrete list that highlights the exact step
 * still missing (install a model, install the runner, or free the port).
 */
function SpeechModelReadiness({ status }: { status: WakeSttStatus | null }) {
  const steps = useMemo(() => {
    if (status?.usingCustomEndpoint) {
      return [
        {
          label: status.ready
            ? 'Local speech endpoint reachable'
            : 'Configure a local (loopback/LAN) speech endpoint',
          done: status.ready,
        },
      ];
    }
    const hasModel = Boolean(status?.modelId);
    const hasRunner = status?.runnerInstalled === true;
    return [
      {
        label: hasModel
          ? `Speech model installed${status?.modelLabel ? ` — ${status.modelLabel}` : ''}`
          : 'Install a speech-to-text model under “Local speech models” above',
        done: hasModel,
      },
      {
        label: hasRunner
          ? 'Speech engine runner available (whisper-server)'
          : 'Install the whisper.cpp runner (Speech engine runner → Install)',
        done: hasRunner,
      },
    ];
  }, [status]);

  if (!status) return null;
  if (status.ready) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          borderRadius: 8,
          background: '#0f1f18',
          border: '1px solid #2f7d5f',
          fontSize: 11,
          color: '#8fe3c0',
        }}
      >
        <span style={{ color: '#4ade80' }}>✓</span>
        <span>
          Speech-model wakes are ready
          {status.modelLabel ? ` — using ${status.modelLabel}` : ''}
          {status.threads ? ` on ${status.threads} CPU threads` : ''}.{' '}
          {isLargeWakeModel(status.modelLabel)
            ? 'This model is large, so on-device recognition lags speech; install “Whisper Base/Tiny” for near-realtime wakes.'
            : 'Near-realtime on-device recognition.'}
        </span>
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '8px 10px',
        borderRadius: 8,
        background: '#2a2312',
        border: '1px solid #6b5518',
        fontSize: 11,
        color: '#ffd479',
      }}
    >
      <strong>A speech-model wake cannot listen yet</strong>
      {status.reason ? <span>{status.reason}</span> : null}
      <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {steps.map((step) => (
          <li key={step.label} style={{ color: step.done ? '#8fe3c0' : '#ffd479' }}>
            {step.done ? '✓ ' : '• '}
            {step.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Live detection test: arms one detector for the typed phrase and lights up. */
function LiveDetectionTest({
  phrase,
  modelId,
  sensitivity,
  disabled,
  blockedReason,
}: {
  phrase: string;
  modelId: string | null;
  sensitivity: number;
  disabled: boolean;
  /**
   * Set when the test cannot possibly work (e.g. a speech model with the local
   * runner missing). The reason is shown and Start is disabled, rather than
   * letting the user talk into a listener that can never transcribe.
   */
  blockedReason?: string | null;
}) {
  const [test, setTest] = useState<WakeLiveTest | null>(null);
  const [state, setState] = useState<WakeLiveTestState>('idle');
  const [score, setScore] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      void test?.stop();
    };
  }, [test]);

  const start = useCallback(async () => {
    setError(null);
    try {
      const session = createWakeLiveTest({
        phrase,
        modelId,
        sensitivity,
        onLevel: (level) => setScore(level),
        onState: (next) => setState(next),
      });
      const ok = await session.start();
      if (!ok) {
        setError(blockedReason ?? 'No installed wake model matches this phrase yet — pick a model or install one.');
        return;
      }
      setTest(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the test.');
    }
  }, [blockedReason, modelId, phrase, sensitivity]);

  const stop = useCallback(async () => {
    await test?.stop();
    setTest(null);
    setState('idle');
    setScore(0);
  }, [test]);

  return (
    <div style={{ ...card, background: '#101823' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ fontSize: 12, color: '#e8eef4' }}>Test detection</strong>
        <span style={{ fontSize: 11, color: '#6b7784' }}>
          runs on this machine; nothing is sent and nothing opens
        </span>
        <span style={{ flex: 1 }} />
        {test ? (
          <button type="button" style={tinyButton} onClick={() => void stop()}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            style={{ ...button, padding: '3px 10px' }}
            disabled={disabled || !phrase.trim() || Boolean(blockedReason)}
            onClick={() => void start()}
          >
            Start
          </button>
        )}
      </div>
      {blockedReason ? <span style={{ fontSize: 11, color: '#ffd479' }}>{blockedReason}</span> : null}
      {test ? (
        <span
          style={{
            fontSize: 11,
            color: state === 'unavailable' ? '#fbbf24' : state === 'fired' ? '#4ade80' : '#9aa7b5',
          }}
        >
          {state === 'unavailable'
            ? 'Detector unavailable'
            : state === 'fired'
              ? 'Detected — the phrase works'
              : 'Listening — say the phrase'}
        </span>
      ) : null}
      <div
        style={{
          position: 'relative',
          height: 6,
          borderRadius: 999,
          background: '#0f1419',
          border: '1px solid #2a333d',
          overflow: 'hidden',
        }}
        aria-hidden
      >
        <div
          style={{
            height: '100%',
            width: `${Math.round(Math.min(1, Math.max(0, score)) * 100)}%`,
            background: 'linear-gradient(90deg,#2f7d5f,#4ade80)',
            transition: 'width 0.08s linear',
          }}
        />
      </div>
      {error ? <span style={{ color: '#f87171', fontSize: 11 }}>{error}</span> : null}
    </div>
  );
}

/** One editable tag list for the 0..n submit phrases. */
function SubmitPhraseEditor({
  phrases,
  busy,
  onChange,
}: {
  phrases: string[];
  busy: boolean;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const value = draft.trim().replace(/\s+/g, ' ').toLowerCase();
    setDraft('');
    if (!value || phrases.includes(value)) return;
    onChange([...phrases, value]);
  };
  return (
    <div style={field}>
      <span>Submit phrases (0 = submit only by clicking Send)</span>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {phrases.map((p) => (
          <span key={p} style={chip}>
            “{p}”
            <button
              type="button"
              style={{ border: 'none', background: 'transparent', color: '#f2a1a1', cursor: 'pointer', fontSize: 12 }}
              disabled={busy}
              onClick={() => onChange(phrases.filter((x) => x !== p))}
            >
              ×
            </button>
          </span>
        ))}
        {!phrases.length ? <span style={{ color: '#6b7784' }}>None</span> : null}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          style={{ ...input, flex: 1 }}
          value={draft}
          disabled={busy}
          placeholder="e.g. submit, answer now"
          list="wake-submit-suggestions"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" style={tinyButton} disabled={busy || !draft.trim()} onClick={add}>
          Add
        </button>
      </div>
      <datalist id="wake-submit-suggestions">
        {SUGGESTED_SUBMIT_PHRASES.filter((p) => !phrases.includes(p)).map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
    </div>
  );
}

/**
 * Alternate phrases for one binding ("Zeni" for "Xeni"). Aliases are matched by
 * on-device speech recognition, exactly like the primary phrase, and all route
 * to the same agent. Only meaningful for a speech-model (STT) engine — a fixed
 * keyword model can only fire on the phrase it was trained for — so the editor
 * says so rather than silently doing nothing.
 */
function AliasEditor({
  aliases,
  primary,
  enabled,
  busy,
  onChange,
}: {
  aliases: string[];
  primary: string;
  /** False when the chosen engine cannot match arbitrary phrases (fixed keyword). */
  enabled: boolean;
  busy: boolean;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    setDraft('');
    const alias = normalizeAliasPhrase(draft, primary);
    if (!alias) return;
    if (aliases.some((a) => a.toLowerCase() === alias.toLowerCase())) return;
    if (aliases.length >= MAX_WAKE_ALIASES) return;
    onChange([...aliases, alias]);
  };
  return (
    <div style={field}>
      <span>Also wake on (aliases — e.g. a nickname)</span>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {aliases.map((a) => (
          <span key={a} style={chip}>
            “{a}”
            <button
              type="button"
              style={{ border: 'none', background: 'transparent', color: '#f2a1a1', cursor: 'pointer', fontSize: 12 }}
              disabled={busy}
              onClick={() => onChange(aliases.filter((x) => x !== a))}
            >
              ×
            </button>
          </span>
        ))}
        {!aliases.length ? <span style={{ color: '#6b7784' }}>None</span> : null}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          style={{ ...input, flex: 1 }}
          value={draft}
          disabled={busy || !enabled}
          placeholder={enabled ? 'e.g. Zeni' : 'Pick a speech model to use aliases'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" style={tinyButton} disabled={busy || !enabled || !draft.trim()} onClick={add}>
          Add
        </button>
      </div>
      <span style={{ color: '#6b7784' }}>
        {enabled
          ? 'Any of these phrases wakes the same agent. Matched by on-device speech recognition.'
          : 'Aliases need a speech model — a wake-word model only fires on its own fixed phrase.'}
      </span>
    </div>
  );
}

/**
 * One editable alias row for a single agent/word (a phrase + its nicknames).
 * Keyed by the phrase, not the agent id, so it works for auto-mapped agents
 * whose binding is re-derived on every arm and therefore cannot hold aliases.
 */
function AliasRow({
  phrase,
  label,
  aliases,
  enabled,
  busy,
  onChange,
}: {
  phrase: string;
  label: string;
  aliases: string[];
  enabled: boolean;
  busy: boolean;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    setDraft('');
    const alias = normalizeAliasPhrase(draft, phrase);
    if (!alias) return;
    if (aliases.some((a) => a.toLowerCase() === alias.toLowerCase())) return;
    if (aliases.length >= MAX_WAKE_ALIASES) return;
    onChange([...aliases, alias]);
  };
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        flexWrap: 'wrap',
        padding: '6px 0',
        borderTop: '1px solid #1f2833',
      }}
    >
      <span style={{ minWidth: 120, fontSize: 12, color: '#e8eef4' }}>{label}</span>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flex: 1, minWidth: 140 }}>
        {aliases.map((a) => (
          <span key={a} style={chip}>
            “{a}”
            <button
              type="button"
              style={{ border: 'none', background: 'transparent', color: '#f2a1a1', cursor: 'pointer', fontSize: 12 }}
              disabled={busy}
              onClick={() => onChange(aliases.filter((x) => x !== a))}
            >
              ×
            </button>
          </span>
        ))}
        {!aliases.length ? <span style={{ fontSize: 11, color: '#6b7784' }}>No nicknames</span> : null}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          style={{ ...input, width: 150 }}
          value={draft}
          disabled={busy || !enabled}
          placeholder={enabled ? `e.g. ${phrase}…` : 'Needs a speech model'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" style={tinyButton} disabled={busy || !enabled || !draft.trim()} onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
}

/**
 * Per-agent nicknames (e.g. "Zeni" for "Xeni"). Shown for every agent that a
 * wake can address — the auto-mapped ones included, which is the whole point:
 * an auto-mapped agent has no editable binding, so this list is where its alias
 * has to live. Only meaningful for speech-model wakes (a keyword model can only
 * fire on its trained phrase), so it is disabled when no speech model is set up.
 */
function AgentAliasesEditor({
  rows,
  agentAliases,
  enabled,
  busy,
  onChange,
}: {
  rows: { phrase: string; label: string }[];
  agentAliases: Record<string, string[]>;
  enabled: boolean;
  busy: boolean;
  onChange: (next: Record<string, string[]>) => void;
}) {
  const setAliases = (phrase: string, aliases: string[]) => {
    const key = aliasKey(phrase);
    const next = { ...agentAliases };
    if (aliases.length) next[key] = aliases;
    else delete next[key];
    onChange(next);
  };
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ fontSize: 12, color: '#e8eef4' }}>Agent nicknames</strong>
        <span style={{ flex: 1 }} />
        {!enabled ? (
          <span style={{ fontSize: 11, color: '#fbbf24' }}>Pick a speech model to use nicknames</span>
        ) : null}
      </div>
      <span style={{ fontSize: 11, color: '#6b7784' }}>
        Additional phrases that wake a given agent — e.g. “Zeni” for “Xeni”. Matched by on-device
        speech recognition, exactly like the agent&apos;s name, and they work for auto-mapped agents
        too.
      </span>
      {rows.length ? (
        rows.map((row) => (
          <AliasRow
            key={row.phrase}
            phrase={row.phrase}
            label={row.label}
            aliases={aliasesForPhrase(agentAliases, row.phrase)}
            enabled={enabled}
            busy={busy}
            onChange={(aliases) => setAliases(row.phrase, aliases)}
          />
        ))
      ) : (
        <span style={{ fontSize: 11, color: '#6b7784' }}>
          Sign in to list agents, or add a wake word below.
        </span>
      )}
    </div>
  );
}

function BindingEditor({
  binding,
  agents,
  wakeModels,
  busy,
  isSttModel,
  onChange,
  onRemove,
}: {
  binding: WakeWordBinding;
  agents: WakeAgentRow[];
  wakeModels: LocalVoiceState['models'];
  busy: boolean;
  /** True when the chosen model transcribes on-device (a speech model). */
  isSttModel: (modelId: string | null) => boolean;
  onChange: (next: WakeWordBinding) => void;
  onRemove: () => void;
}) {
  const [recording, setRecording] = useState<EnrollmentSession | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const auto = isAutoBinding(binding);

  const startRecording = useCallback(async () => {
    setRecordError(null);
    try {
      const session = await startEnrollment(createUtteranceSource());
      setRecording(session);
    } catch (err) {
      setRecordError(err instanceof Error ? err.message : 'Could not start recording.');
    }
  }, []);

  const finishRecording = useCallback(async () => {
    const session = recording;
    setRecording(null);
    if (!session) return;
    const result = await session.finish();
    if (!result) {
      setRecordError('No audio was captured. Try again closer to the microphone.');
      return;
    }
    // A recorded sample switches this binding to the on-device custom detector.
    onChange({ ...binding, sampleFingerprint: result.fingerprint, sampleRef: null });
  }, [binding, onChange, recording]);

  // Highlight the fields that still block this binding from arming, so a user
  // who added a wake word knows exactly what is left to configure.
  const sttChosen = isSttModel(binding.modelId);
  const missingPhrase = !binding.phrase.trim();
  const missingAgent = !binding.agentId;
  const missingModel = !binding.modelId && !binding.sampleFingerprint;
  const modelNeedsInstall =
    missingModel === false &&
    !binding.sampleFingerprint &&
    wakeModels.find((m) => m.id === binding.modelId)?.installState !== 'installed';

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <label style={{ ...field, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={binding.enabled}
            disabled={busy}
            onChange={(e) => onChange({ ...binding, enabled: e.target.checked })}
          />
          <span style={{ color: '#e8eef4', fontWeight: 600 }}>
            {binding.phrase || 'New wake word'}
          </span>
        </label>
        {auto ? (
          <span style={{ ...chip, borderColor: '#6a3f9e', color: '#d8a5ff' }} title="From the agent's name">
            auto
          </span>
        ) : null}
        {sttChosen ? (
          <span style={{ ...chip, borderColor: '#2f5c9e', color: '#7fb2ff' }} title="Matched by on-device speech recognition">
            any phrase
          </span>
        ) : null}
        {sttChosen && binding.aliases.length ? (
          <span
            style={{ ...chip, borderColor: '#2f5c9e', color: '#7fb2ff' }}
            title={`Also wakes on: ${bindingPhrases(binding).slice(1).join(', ')}`}
          >
            +{binding.aliases.length} alias{binding.aliases.length === 1 ? '' : 'es'}
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        <button type="button" style={tinyButton} disabled={busy} onClick={onRemove}>
          {auto ? 'Remove (adds to the auto-map blocklist)' : 'Remove'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <label style={{ ...field, flex: 1, minWidth: 190 }}>
          <span>
            Spoken phrase
            {missingPhrase ? <span style={{ color: '#fbbf24' }}> · required</span> : null}
          </span>
          <input
            style={missingPhrase ? inputNeedsAttention : input}
            value={binding.phrase}
            placeholder="Hey Jarvis — or any phrase, e.g. an agent name"
            list={`wake-phrases-${binding.id}`}
            disabled={busy}
            onChange={(e) => onChange({ ...binding, phrase: e.target.value })}
          />
          <datalist id={`wake-phrases-${binding.id}`}>
            {SUGGESTED_PHRASES.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </label>

        <label style={{ ...field, flex: 1, minWidth: 190 }}>
          <span>
            Activates agent
            {missingAgent ? <span style={{ color: '#fbbf24' }}> · suggested</span> : null}
          </span>
          <select
            style={missingAgent ? inputNeedsAttention : input}
            value={binding.agentId ?? ''}
            disabled={busy}
            onChange={(e) => {
              const agent = agents.find((a) => a.contactId === e.target.value) ?? null;
              onChange({
                ...binding,
                agentId: agent?.contactId ?? null,
                agentName: agent?.name ?? null,
              });
            }}
          >
            <option value="">Choose an agent…</option>
            {agents.map((agent) => (
              <option key={agent.contactId} value={agent.contactId}>
                {agent.name}
                {agent.canConfigure ? '' : ' (public)'}
              </option>
            ))}
          </select>
        </label>
      </div>

      <AliasEditor
        aliases={binding.aliases}
        primary={binding.phrase}
        enabled={sttChosen}
        busy={busy}
        onChange={(aliases) => onChange({ ...binding, aliases })}
      />

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <label style={{ ...field, flex: 1, minWidth: 190 }}>
          <span>
            Engine
            {missingModel ? <span style={{ color: '#fbbf24' }}> · required</span> : null}
          </span>

          <select
            style={missingModel || modelNeedsInstall ? inputNeedsAttention : input}
            value={binding.modelId ?? ''}
            disabled={busy || Boolean(binding.sampleFingerprint)}
            onChange={(e) => onChange({ ...binding, modelId: e.target.value || null })}
          >
            <option value="">Choose a model…</option>
            {wakeModels.some((m) => m.kind === 'stt') ? (
              <optgroup label="Speech model — wake on ANY phrase (recommended for names)">
                {wakeModels
                  .filter((m) => m.kind === 'stt')
                  .map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                      {model.installState === 'installed' ? ' ✓ installed' : ' (not installed)'}
                    </option>
                  ))}
              </optgroup>
            ) : null}
            {wakeModels.some((m) => m.kind === 'wake') ? (
              <optgroup label="Wake-word model — fires on its own fixed phrase only">
                {wakeModels
                  .filter((m) => m.kind === 'wake')
                  .map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                      {model.installState === 'installed' ? ' ✓ installed' : ' (not installed)'}
                    </option>
                  ))}
              </optgroup>
            ) : null}
          </select>
          {binding.sampleFingerprint ? (
            <span style={{ color: '#6b7784' }}>Using your recorded sample instead of a model.</span>
          ) : sttChosen ? (
            <span style={{ color: '#7fb2ff' }}>
              Transcribes on this machine and matches the phrase as text — works for any phrase,
              including this agent&apos;s name.
            </span>
          ) : missingModel ? (
            <span style={{ color: '#fbbf24' }}>
              Pick a speech model to wake on any phrase, or install a wake-word model.
            </span>
          ) : modelNeedsInstall ? (
            <span style={{ color: '#fbbf24' }}>Download the chosen model above to use it.</span>
          ) : (
            <span style={{ color: '#6b7784' }}>
              A wake-word model only fires on its own phrase. Pick a speech model to wake on any phrase.
            </span>
          )}
        </label>

        <label style={{ ...field, minWidth: 150 }}>
          <span>Sensitivity</span>
          <input
            style={input}
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={binding.sensitivity}
            disabled={busy}
            onChange={(e) => onChange({ ...binding, sensitivity: Number(e.target.value) })}
          />
          <span style={{ color: '#6b7784' }}>{binding.sensitivity.toFixed(2)} · higher fires more easily</span>
        </label>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        {recording ? (
          <button type="button" style={recordButtonActive} onClick={() => void finishRecording()}>
            ■ Stop &amp; save sample
          </button>
        ) : (
          <button type="button" style={tinyButton} disabled={busy} onClick={() => void startRecording()}>
            ● Record a voice sample (optional)
          </button>
        )}
        {recording ? (
          <span style={{ color: '#fbbf24', fontSize: 11 }}>Recording… say “{binding.phrase || 'your phrase'}”.</span>
        ) : null}
        {binding.sampleFingerprint ? (
          <button
            type="button"
            style={tinyButton}
            disabled={busy}
            onClick={() => onChange({ ...binding, sampleFingerprint: null })}
          >
            Clear sample
          </button>
        ) : null}
        {recordError ? <span style={{ color: '#f87171', fontSize: 11 }}>{recordError}</span> : null}
      </div>

      <span style={{ fontSize: 11, color: '#6b7784' }}>
        Detection runs entirely on this machine. A wake word is not sign-in: it only opens the
        agent&apos;s chat and starts dictation — it can never approve a payment or a 2FA prompt.
      </span>
    </div>
  );
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

  const persist = useCallback(
    async (next: WakeSettings) => {
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
    },
    [],
  );

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
        <ExternalLink href={CUSTOM_WAKE_GUIDE_URL}>How to train a custom model</ExternalLink>
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
