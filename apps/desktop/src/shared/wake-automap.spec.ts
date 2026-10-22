import { describe, expect, it } from 'vitest';
import { withAutoMappedBindings, agentIsAutoMapped, phraseFromAgentName, isAutoBinding, autoBindingId } from './wake-automap.js';
import type { WakeAgentRow, WakeWordBinding } from './wake.js';

function agent(contactId: string, name: string): WakeAgentRow {
  return { contactId, virtualEmployeeId: contactId, agentId: null, name, canConfigure: true };
}

function binding(over: Partial<WakeWordBinding>): WakeWordBinding {
  return {
    id: 'w1',
    phrase: 'Hey Jarvis',
    agentId: 'a1',
    agentName: 'Jarvis',
    modelId: 'm',
    sensitivity: 0.5,
    enabled: true,
    sampleRef: null,
    sampleFingerprint: null,
    ...over,
  };
}

describe('phraseFromAgentName', () => {
  it('trims and collapses whitespace', () => {
    expect(phraseFromAgentName('  Bob   Smith ')).toBe('Bob Smith');
  });

  it('drops a trailing parenthesised qualifier', () => {
    expect(phraseFromAgentName('Bob (support)')).toBe('Bob');
    expect(phraseFromAgentName('Nova [beta]')).toBe('Nova');
  });

  it('returns null when nothing speakable remains', () => {
    expect(phraseFromAgentName('')).toBeNull();
    expect(phraseFromAgentName('   ')).toBeNull();
    expect(phraseFromAgentName('(only parens)')).toBeNull();
  });
});

describe('agentIsAutoMapped', () => {
  it('blocklist maps everything except the listed ids', () => {
    expect(agentIsAutoMapped('a', 'blocklist', [])).toBe(true);
    expect(agentIsAutoMapped('a', 'blocklist', ['a'])).toBe(false);
    expect(agentIsAutoMapped('a', 'blocklist', ['b'])).toBe(true);
  });

  it('whitelist maps only the listed ids', () => {
    expect(agentIsAutoMapped('a', 'whitelist', [])).toBe(false);
    expect(agentIsAutoMapped('a', 'whitelist', ['a'])).toBe(true);
  });
});

describe('withAutoMappedBindings', () => {
  const agents = [agent('bob', 'Bob'), agent('nova', 'Nova')];

  it('returns only the manual bindings while auto-map is off', () => {
    const manual = [binding({})];
    expect(
      withAutoMappedBindings({
        manual,
        agents,
        autoMap: false,
        mode: 'blocklist',
        ids: [],
      }),
    ).toEqual(manual);
  });

  it('maps every agent by name in blocklist mode', () => {
    const out = withAutoMappedBindings({
      manual: [],
      agents,
      autoMap: true,
      mode: 'blocklist',
      ids: [],
    });
    expect(out.map((b) => b.phrase)).toEqual(['Bob', 'Nova']);
    expect(out.every((b) => isAutoBinding(b))).toBe(true);
    expect(out[0]!.id).toBe(autoBindingId('bob'));
    expect(out[0]!.agentId).toBe('bob');
    expect(out[0]!.agentName).toBe('Bob');
  });

  it('excludes blocklisted agents', () => {
    const out = withAutoMappedBindings({
      manual: [],
      agents,
      autoMap: true,
      mode: 'blocklist',
      ids: ['bob'],
    });
    expect(out.map((b) => b.agentName)).toEqual(['Nova']);
  });

  it('includes only whitelisted agents', () => {
    const out = withAutoMappedBindings({
      manual: [],
      agents,
      autoMap: true,
      mode: 'whitelist',
      ids: ['bob'],
    });
    expect(out.map((b) => b.agentName)).toEqual(['Bob']);
  });

  it('keeps manual bindings first and never overrides them', () => {
    const manual = [binding({ id: 'manual-nova', phrase: 'Nova', agentId: 'nova', agentName: 'Nova' })];
    const out = withAutoMappedBindings({
      manual,
      agents,
      autoMap: true,
      mode: 'blocklist',
      ids: [],
    });
    expect(out[0]).toBe(manual[0]);
    // Nova is taken by the manual binding, so only Bob is derived.
    expect(out.map((b) => b.phrase)).toEqual(['Nova', 'Bob']);
  });

  it('de-duplicates derived phrases against reserved phrases', () => {
    const out = withAutoMappedBindings({
      manual: [],
      agents,
      autoMap: true,
      mode: 'blocklist',
      ids: [],
      reservedPhrases: ['Bob'],
    });
    expect(out.map((b) => b.phrase)).toEqual(['Nova']);
  });

  it('preserves a previously derived binding\u2019s model and sensitivity', () => {
    const existing = [
      binding({ id: autoBindingId('bob'), phrase: 'Bob', agentId: 'bob', agentName: 'Bob', modelId: 'custom-m', sensitivity: 0.9 }),
    ];
    const out = withAutoMappedBindings({
      manual: [],
      agents,
      autoMap: true,
      mode: 'blocklist',
      ids: [],
      existing,
    });
    const bob = out.find((b) => b.agentId === 'bob')!;
    expect(bob.modelId).toBe('custom-m');
    expect(bob.sensitivity).toBeCloseTo(0.9);
  });

  it('applies the default model to derived bindings (so they can arm)', () => {
    const out = withAutoMappedBindings({
      manual: [],
      agents,
      autoMap: true,
      mode: 'blocklist',
      ids: [],
      defaultModelId: 'catalog:desktop/whisper-small-q5',
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((b) => b.modelId === 'catalog:desktop/whisper-small-q5')).toBe(true);
  });

  it('lets a previously derived binding\u2019s own model win over the default', () => {
    const existing = [
      binding({ id: autoBindingId('bob'), phrase: 'Bob', agentId: 'bob', agentName: 'Bob', modelId: 'custom-m' }),
    ];
    const out = withAutoMappedBindings({
      manual: [],
      agents,
      autoMap: true,
      mode: 'blocklist',
      ids: [],
      defaultModelId: 'catalog:desktop/whisper-small-q5',
      existing,
    });
    expect(out.find((b) => b.agentId === 'bob')!.modelId).toBe('custom-m');
  });

  it('skips an agent whose name yields no phrase', () => {
    const out = withAutoMappedBindings({
      manual: [],
      agents: [agent('x', '   ')],
      autoMap: true,
      mode: 'blocklist',
      ids: [],
    });
    expect(out).toEqual([]);
  });
});
