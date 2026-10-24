import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WAKE_SETTINGS,
  MAX_WAKE_ALIASES,
  bindingEngineKind,
  bindingIsArmed,
  bindingPhrases,
  clampSensitivity,
  clampWakeTimeout,
  dequeueUtterance,
  dictationTranscribesInCloud,
  enqueueUtterance,
  aliasKey,
  aliasesForPhrase,
  mergeBindingAliases,
  normalizeAgentAliases,
  normalizeAliasList,
  normalizeAliasPhrase,
  normalizeSubmitPhrase,
  normalizeSubmitPhrases,
  normalizeUtteranceQueue,
  normalizeWakeBinding,
  normalizeWakeSettings,
  resolveWakeActivationMode,
  wakeRaisesMainWindow,
  type QueuedUtterance,
} from './wake.js';

describe('clampSensitivity', () => {
  it('clamps into 0..1', () => {
    expect(clampSensitivity(1.5)).toBe(1);
    expect(clampSensitivity(-2)).toBe(0);
    expect(clampSensitivity(0.42)).toBeCloseTo(0.42);
  });

  it('falls back for non-numbers', () => {
    expect(clampSensitivity('x', 0.3)).toBe(0.3);
    expect(clampSensitivity(undefined, 0.7)).toBe(0.7);
    expect(clampSensitivity(NaN)).toBe(0.5);
  });
});

describe('alias helpers', () => {
  it('rejects an alias equal to the primary phrase or blank', () => {
    expect(normalizeAliasPhrase('  Xeni ', 'Xeni')).toBeNull();
    expect(normalizeAliasPhrase('xeni', 'XENI')).toBeNull();
    expect(normalizeAliasPhrase('   ', 'Xeni')).toBeNull();
    expect(normalizeAliasPhrase('Zeni', 'Xeni')).toBe('Zeni');
  });

  it('trims, dedupes and drops the primary from an alias list', () => {
    const aliases = normalizeAliasList([' Zeni ', 'zeni', 'Xeni', '', 'Zenny'], 'Xeni');
    expect(aliases).toEqual(['Zeni', 'Zenny']);
  });

  it('caps the alias list', () => {
    const many = Array.from({ length: MAX_WAKE_ALIASES + 5 }, (_, i) => `alias ${i}`);
    expect(normalizeAliasList(many, 'Xeni')).toHaveLength(MAX_WAKE_ALIASES);
  });

  it('lists the primary phrase first, then aliases, deduped', () => {
    expect(bindingPhrases({ phrase: 'Xeni', aliases: ['Xeni', 'Zeni'] })).toEqual(['Xeni', 'Zeni']);
    expect(bindingPhrases({ phrase: 'Hey Jarvis', aliases: [] })).toEqual(['Hey Jarvis']);
  });

  it('round-trips aliases through normalizeWakeBinding', () => {
    const b = normalizeWakeBinding({ phrase: 'Xeni', aliases: ['Zeni', 'Zeni', 'Xeni'] });
    expect(b?.aliases).toEqual(['Zeni']);
  });
});

describe('agent aliases (per-phrase nicknames)', () => {
  it('keys phrases case- and whitespace-insensitively', () => {
    expect(aliasKey('  Xeni  Now ')).toBe('xeni now');
    expect(aliasKey(null)).toBe('');
  });

  it('coerces an untrusted alias map, dropping junk and primary duplicates', () => {
    const map = normalizeAgentAliases({
      '  Xeni ': [' Zeni ', 'zeni', 'Xeni', ''],
      '': ['ghost'],
      bad: 'not-an-array',
      Nova: ['Nova', 'Novi'],
    });
    expect(map).toEqual({ xeni: ['Zeni'], nova: ['Novi'] });
  });

  it('returns no aliases for junk input', () => {
    expect(normalizeAgentAliases(null)).toEqual({});
    expect(normalizeAgentAliases(['Zeni'])).toEqual({});
  });

  it('reads aliases for a phrase regardless of casing/whitespace', () => {
    const map = { xeni: ['Zeni'] };
    expect(aliasesForPhrase(map, 'XENI')).toEqual(['Zeni']);
    expect(aliasesForPhrase(map, '  xeni ')).toEqual(['Zeni']);
    expect(aliasesForPhrase(map, 'Bob')).toEqual([]);
    expect(aliasesForPhrase(undefined, 'Xeni')).toEqual([]);
  });

  it('merges binding aliases with the phrase aliases, deduped and bounded', () => {
    const merged = mergeBindingAliases(
      { phrase: 'Xeni', aliases: ['Zenny', 'Zeni'] },
      { xeni: ['Zeni', 'Zenna'] },
    );
    expect(merged).toEqual(['Zenny', 'Zeni', 'Zenna']);
  });

  it('never lets the phrase itself leak into the merged aliases', () => {
    expect(mergeBindingAliases({ phrase: 'Xeni', aliases: ['Xeni'] }, { xeni: ['xeni'] })).toEqual(
      [],
    );
  });

  it('round-trips agentAliases through normalizeWakeSettings', () => {
    const s = normalizeWakeSettings({ agentAliases: { Xeni: ['Zeni'], '': ['x'] } });
    expect(s.agentAliases).toEqual({ xeni: ['Zeni'] });
  });
});

describe('normalizeWakeSettings', () => {
  it('returns defaults for junk input', () => {
    expect(normalizeWakeSettings(null)).toEqual(DEFAULT_WAKE_SETTINGS);
    expect(normalizeWakeSettings('nope')).toEqual(DEFAULT_WAKE_SETTINGS);
    expect(normalizeWakeSettings({})).toEqual(DEFAULT_WAKE_SETTINGS);
  });

  it('defaults companionOnWake to off and coerces a boolean', () => {
    expect(normalizeWakeSettings({}).companionOnWake).toBe(false);
    expect(normalizeWakeSettings({ companionOnWake: true }).companionOnWake).toBe(true);
    expect(normalizeWakeSettings({ companionOnWake: 'yes' }).companionOnWake).toBe(false);
  });

  it('keeps a well-formed binding and clamps sensitivity', () => {
    const s = normalizeWakeSettings({
      enabled: true,
      bindings: [
        {
          id: 'w1',
          phrase: 'Hey Jarvis',
          agentId: 'a1',
          agentName: 'Jarvis',
          modelId: 'catalog:desktop/wake-hey-jarvis',
          sensitivity: 3,
          enabled: true,
        },
      ],
    });
    expect(s.enabled).toBe(true);
    expect(s.bindings).toHaveLength(1);
    expect(s.bindings[0]!.sensitivity).toBe(1);
    expect(s.bindings[0]!.modelId).toBe('catalog:desktop/wake-hey-jarvis');
  });

  it('drops bindings without a phrase', () => {
    const s = normalizeWakeSettings({ bindings: [{ id: 'x' }, { phrase: '  ' }, { phrase: 'Ok' }] });
    expect(s.bindings.map((b) => b.phrase)).toEqual(['Ok']);
  });

  it('dedupes by id and synthesises missing ids', () => {
    const s = normalizeWakeSettings({
      bindings: [{ id: 'dup', phrase: 'A' }, { id: 'dup', phrase: 'B' }, { phrase: 'Hello World' }],
    });
    expect(s.bindings.map((b) => b.phrase)).toEqual(['A', 'Hello World']);
    expect(s.bindings[1]!.id).toBe('wake-2-hello-world');
  });
});

describe('bindingIsArmed', () => {
  const binding = {
    id: 'w1',
    phrase: 'Hey',
    aliases: [] as string[],
    agentId: null,
    agentName: null,
    modelId: 'catalog:desktop/wake-hey-jarvis',
    sensitivity: 0.5,
    enabled: true,
    sampleRef: null,
    sampleFingerprint: null,
  };

  it('requires enabled and a model', () => {
    expect(bindingIsArmed(binding)).toBe(true);
    expect(bindingIsArmed({ ...binding, enabled: false })).toBe(false);
    expect(bindingIsArmed({ ...binding, modelId: null })).toBe(false);
  });

  it('does not require a model for a custom-sample binding', () => {
    expect(
      bindingIsArmed({ ...binding, modelId: null, sampleFingerprint: 'AAAA' }),
    ).toBe(true);
  });
});

describe('bindingEngineKind', () => {
  it('uses custom_sample when a sample ref or fingerprint is present', () => {
    const base = {
      id: 'w1',
      phrase: 'Hey',
      aliases: [] as string[],
      agentId: null,
      agentName: null,
      modelId: 'm',
      sensitivity: 0.5,
      enabled: true,
      sampleRef: null,
      sampleFingerprint: null,
    };
    expect(bindingEngineKind(base)).toBe('builtin');
    expect(bindingEngineKind({ ...base, sampleRef: 'priv:abc' })).toBe('custom_sample');
    expect(bindingEngineKind({ ...base, sampleFingerprint: 'AAAA' })).toBe('custom_sample');
  });
});

describe('normalizeWakeBinding', () => {
  it('coerces one untrusted binding and rejects junk', () => {
    expect(normalizeWakeBinding(null)).toBeNull();
    expect(normalizeWakeBinding({ phrase: '  ' })).toBeNull();
    const b = normalizeWakeBinding({ phrase: ' Hey ', sensitivity: 5, enabled: false }, 2);
    expect(b!.phrase).toBe('Hey');
    expect(b!.sensitivity).toBe(1);
    expect(b!.enabled).toBe(false);
    expect(b!.id).toBe('wake-2-hey');
  });
});

describe('submit phrases', () => {
  it('normalizes one phrase to lower case and collapses spaces', () => {
    expect(normalizeSubmitPhrase('  Answer   Now ')).toBe('answer now');
    expect(normalizeSubmitPhrase('   ')).toBeNull();
    expect(normalizeSubmitPhrase(42)).toBeNull();
  });

  it('dedupes and preserves order', () => {
    expect(normalizeSubmitPhrases(['Submit', 'answer now', 'submit', ' '])).toEqual([
      'submit',
      'answer now',
    ]);
    expect(normalizeSubmitPhrases('nope')).toEqual([]);
  });
});

describe('clampWakeTimeout', () => {
  it('clamps into the valid range and rounds', () => {
    expect(clampWakeTimeout(5)).toBe(10);
    expect(clampWakeTimeout(10_000)).toBe(1800);
    expect(clampWakeTimeout(45.6)).toBe(46);
    expect(clampWakeTimeout('x')).toBe(60);
  });
});

describe('wake settings behaviour fields', () => {
  it('normalizes behaviour fields with safe defaults', () => {
    const s = normalizeWakeSettings({
      activationMode: 'widget',
      reviewBeforeSend: false,
      submitPhrases: ['Submit', 'submit'],
      unsentPolicy: 'queue',
      activationTimeoutSeconds: 2,
      autoMapMode: 'whitelist',
      autoMapIds: ['a', ' a ', '', 4],
    });
    expect(s.activationMode).toBe('widget');
    expect(s.reviewBeforeSend).toBe(false);
    expect(s.submitPhrases).toEqual(['submit']);
    expect(s.unsentPolicy).toBe('queue');
    expect(s.activationTimeoutSeconds).toBe(10);
    expect(s.autoMapMode).toBe('whitelist');
    expect(s.autoMapIds).toEqual(['a']);
  });

  it('rejects an unknown activation mode and unsent policy', () => {
    const s = normalizeWakeSettings({ activationMode: 'nope', unsentPolicy: 'later' });
    expect(s.activationMode).toBe('chat');
    expect(s.unsentPolicy).toBe('discard');
  });
});

describe('dictationTranscribesInCloud', () => {
  it('is cloud when the user chose region inference', () => {
    expect(
      dictationTranscribesInCloud({ sttEngine: 'cloud', localSttAvailable: true, customSttEndpoint: true }),
    ).toBe(true);
  });

  it('is on-device only when a local model or endpoint actually exists', () => {
    expect(
      dictationTranscribesInCloud({ sttEngine: 'local', localSttAvailable: true, customSttEndpoint: false }),
    ).toBe(false);
    expect(
      dictationTranscribesInCloud({ sttEngine: 'local', localSttAvailable: false, customSttEndpoint: true }),
    ).toBe(false);
  });

  it('falls back to cloud when "local" is selected but nothing is installed', () => {
    expect(
      dictationTranscribesInCloud({ sttEngine: 'local', localSttAvailable: false, customSttEndpoint: false }),
    ).toBe(true);
  });
});

describe('resolveWakeActivationMode', () => {
  it('lets companionOnWake win over everything', () => {
    expect(
      resolveWakeActivationMode({
        activationMode: 'chat',
        companionOnWake: true,
        cloudTranscription: true,
      }),
    ).toBe('companion');
  });

  it('forces the visible widget when transcription is cloud', () => {
    expect(
      resolveWakeActivationMode({
        activationMode: 'chat',
        companionOnWake: false,
        cloudTranscription: true,
      }),
    ).toBe('widget');
  });

  it('otherwise honours the configured mode', () => {
    expect(
      resolveWakeActivationMode({
        activationMode: 'companion',
        companionOnWake: false,
        cloudTranscription: false,
      }),
    ).toBe('companion');
    expect(
      resolveWakeActivationMode({
        activationMode: 'chat',
        companionOnWake: false,
        cloudTranscription: false,
      }),
    ).toBe('chat');
  });
});

describe('wakeRaisesMainWindow', () => {
  it('suppresses the main window for a companion-mode wake that has a live companion', () => {
    expect(
      wakeRaisesMainWindow({
        settings: { activationMode: 'companion', companionOnWake: false },
        companionOpen: true,
      }),
    ).toBe(false);
    expect(
      wakeRaisesMainWindow({
        settings: { activationMode: 'chat', companionOnWake: true },
        companionOpen: true,
      }),
    ).toBe(false);
  });

  it('falls back to the main window when no companion is open', () => {
    expect(
      wakeRaisesMainWindow({
        settings: { activationMode: 'companion', companionOnWake: true },
        companionOpen: false,
      }),
    ).toBe(true);
  });

  it('always raises the main window for chat/widget wakes', () => {
    expect(
      wakeRaisesMainWindow({
        settings: { activationMode: 'chat', companionOnWake: false },
        companionOpen: true,
      }),
    ).toBe(true);
    expect(
      wakeRaisesMainWindow({
        settings: { activationMode: 'widget', companionOnWake: false },
        companionOpen: true,
      }),
    ).toBe(true);
  });
});

describe('utterance queue helpers', () => {
  const entry = (id: string, at = 1): QueuedUtterance => ({
    id,
    agentId: 'a',
    agentName: 'A',
    text: `t-${id}`,
    at,
    phrase: null,
  });

  it('enqueues newest-last, replacing an existing id', () => {
    const q = enqueueUtterance(enqueueUtterance([], entry('1')), entry('2'));
    expect(q.map((e) => e.id)).toEqual(['1', '2']);
    const replaced = enqueueUtterance(q, { ...entry('1'), text: 'updated' });
    expect(replaced.map((e) => e.id)).toEqual(['2', '1']);
    expect(replaced[1]!.text).toBe('updated');
  });

  it('caps the queue length', () => {
    let q: QueuedUtterance[] = [];
    const list: QueuedUtterance[] = [];
    for (let i = 0; i < 25; i++) list.push(entry(String(i)));
    for (const e of list) q = enqueueUtterance(q, e);
    expect(q).toHaveLength(20);
    expect(q[0]!.id).toBe('5');
  });

  it('dequeues by id', () => {
    expect(dequeueUtterance([entry('1'), entry('2')], '1').map((e) => e.id)).toEqual(['2']);
  });

  it('normalizes a persisted queue, dropping malformed entries', () => {
    const out = normalizeUtteranceQueue([
      { id: 'u1', text: 'ok', at: 5 },
      { id: '', text: 'no id' },
      { id: 'u2', text: '  ' },
      null,
      'nope',
      { id: 'u1', text: 'dup' },
    ]);
    expect(out.map((e) => e.id)).toEqual(['u1']);
    expect(out[0]!.text).toBe('ok');
  });
});
