/**
 * Per-agent nicknames (e.g. "Zeni" for "Xeni").
 *
 * Shown for every agent that a wake can address — the auto-mapped ones included,
 * which is the whole point: an auto-mapped agent has no editable binding, so this
 * list is where its alias has to live. Only meaningful for speech-model wakes (a
 * keyword model can only fire on its trained phrase), so it is disabled when no
 * speech model is set up.
 */

import { useState } from 'react';
import { MAX_WAKE_ALIASES, aliasKey, aliasesForPhrase, normalizeAliasPhrase } from '../../../shared/wake.js';
import { card, chip, input, tinyButton } from './parts.js';

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

export function AgentAliasesEditor({
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
