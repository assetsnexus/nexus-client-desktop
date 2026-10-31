/**
 * Alternate phrases for one binding ("Zeni" for "Xeni").
 *
 * Aliases are matched by on-device speech recognition, exactly like the primary
 * phrase, and all route to the same agent. Only meaningful for a speech-model
 * (STT) engine — a fixed keyword model can only fire on the phrase it was trained
 * for — so the editor says so rather than silently doing nothing.
 */

import { useState } from 'react';
import { MAX_WAKE_ALIASES, normalizeAliasPhrase } from '../../../shared/wake.js';
import { chip, field, input, tinyButton } from './parts.js';

export function AliasEditor({
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
