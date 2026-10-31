/**
 * Shared styling + tiny helpers for the wake-words sub-components.
 *
 * The wake settings panel was one 1555-line file; it is now a composition of the
 * components under `renderer/components/wake/`. The styles below lived at the top
 * of that file and are used by several of the split components, so they live
 * here once instead of being duplicated per file.
 */

import type { CSSProperties, ReactNode } from 'react';
import { bridge } from '../../bridge.js';

/** The wake settings card wrapper (a slightly tighter card than the generic one). */
export const section: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: 14,
  borderRadius: 12,
  background: '#151b22',
  border: '1px solid #2a333d',
};

export const field: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 12,
  color: '#9aa7b5',
};

export const input: CSSProperties = {
  padding: '6px 9px',
  borderRadius: 8,
  border: '1px solid #3a4654',
  background: '#0f1419',
  color: '#e8eef4',
  fontSize: 13,
};

/** Input that is missing a required value, so the user sees what to fill in. */
export const inputNeedsAttention: CSSProperties = {
  ...input,
  borderColor: '#a16207',
  boxShadow: '0 0 0 2px rgba(234,179,8,0.14)',
};

export const button: CSSProperties = {
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

export const ghostButton: CSSProperties = {
  ...button,
  background: '#1c2430',
  borderColor: '#3a4654',
  color: '#e8eef4',
  fontWeight: 500,
};

export const tinyButton: CSSProperties = {
  ...ghostButton,
  padding: '2px 8px',
  fontSize: 11,
};

export const recordButtonActive: CSSProperties = {
  ...button,
  background: '#9f1239',
  borderColor: '#e11d48',
};

export const card: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 10,
  borderRadius: 10,
  background: '#0f1419',
  border: '1px solid #2a333d',
};

export const chip: CSSProperties = {
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

export const linkButton: CSSProperties = {
  padding: 0,
  border: 'none',
  background: 'none',
  color: '#7fb2ff',
  cursor: 'pointer',
  fontSize: 11,
  textDecoration: 'underline',
};

/** Suggested phrases matching the built-in wake models. */
export const SUGGESTED_PHRASES = ['Hey Jarvis', 'Alexa', 'Hey Mycroft'];

/** A small inline link that opens a documentation URL in the system browser. */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <button type="button" style={linkButton} title={href} onClick={() => void bridge.openExternal(href)}>
      {children}
    </button>
  );
}
