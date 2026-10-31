/**
 * One editable tag list for the 0..n submit phrases.
 *
 * A wake never auto-sends; these are the spoken phrases (e.g. "submit") that
 * submit the dictated transcript. Zero phrases means submit only by clicking Send.
 */

import { useState } from 'react';
import { SUGGESTED_SUBMIT_PHRASES } from '../../../shared/wake.js';
import { chip, field, input, tinyButton } from './parts.js';

export function SubmitPhraseEditor({
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
