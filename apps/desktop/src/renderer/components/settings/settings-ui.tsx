/**
 * Shared Settings UI primitives.
 *
 * The settings surface is split into one file per section (see `../SettingsPanel.tsx`
 * for the shell that hosts them). Every section would otherwise re-declare the
 * same card/field/row/button styles and the same `t()`-free plumbing, so the
 * primitives live here once.
 *
 * COPY NOTE: none of these primitives call `useI18n`. They take the already
 * translated string as a prop, so the translation keys stay visible at each call
 * site instead of hiding behind a wrapper. `SectionCard`'s `help` is therefore a
 * translated string (or a node), never a raw key.
 */

import type { CSSProperties, ReactNode } from 'react';

/** The card that wraps one settings section. */
export const settingsSection: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: 18,
  borderRadius: 12,
  background: '#151b22',
  border: '1px solid #2a333d',
};

/** A labelled control stacked label-over-input. */
export const settingsField: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  fontSize: 12,
  color: '#9aa7b5',
};

export const settingsInput: CSSProperties = {
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid #3a4654',
  background: '#0f1419',
  color: '#e8eef4',
  fontSize: 13,
};

export const settingsButton: CSSProperties = {
  alignSelf: 'flex-start',
  padding: '8px 14px',
  borderRadius: 8,
  border: '1px solid #3f6cb0',
  background: '#2f5c9e',
  color: '#fff',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
};

/** Secondary action: same shape, muted fill. */
export const settingsGhostButton: CSSProperties = {
  ...settingsButton,
  background: '#1c2430',
  borderColor: '#3a4654',
  color: '#e8eef4',
  fontWeight: 500,
};

export const settingsRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 0',
  borderTop: '1px solid #222b34',
};

export const settingsMuted: CSSProperties = { color: '#6b7784', fontSize: 12 };

export const settingsHint: CSSProperties = { color: '#6b7784', fontSize: 12 };

/** A checkbox + label pair laid out as a single clickable row. */
export const settingsCheckbox: CSSProperties = {
  ...settingsField,
  flexDirection: 'row',
  alignItems: 'center',
  gap: 10,
};

const sectionTitle: CSSProperties = { margin: 0, fontSize: 16 };
const sectionHelp: CSSProperties = { margin: 0, color: '#6b7784', fontSize: 12, lineHeight: 1.5 };

/**
 * One settings section: a card with a title, optional help paragraph, and body.
 * `help` is the translated string (or rich nodes) for the section.
 */
export function SectionCard({
  title,
  help,
  children,
}: {
  title: ReactNode;
  help?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section style={settingsSection}>
      <h2 style={sectionTitle}>{title}</h2>
      {help ? <p style={sectionHelp}>{help}</p> : null}
      {children}
    </section>
  );
}

/** A labelled field whose label may sit above the control (`row` inverts that). */
export function Field({
  label,
  hint,
  rowStyle,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  rowStyle?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <label style={rowStyle ?? settingsField}>
      <span>{label}</span>
      {children}
      {hint ? <span style={settingsHint}>{hint}</span> : null}
    </label>
  );
}

/** A checkbox row: the whole row toggles, with an optional faded hint. */
export function CheckboxField({
  checked,
  disabled,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <label style={settingsCheckbox}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span style={{ color: '#e8eef4' }}>
        {label}
        {hint ? <span style={settingsHint}> {hint}</span> : null}
      </span>
    </label>
  );
}

/** Faded inline helper text. */
export function Hint({ children }: { children: ReactNode }) {
  return <span style={settingsHint}>{children}</span>;
}

/** Availability chip colours keyed by the health string the main process reports. */
const healthColors: Record<string, string> = {
  healthy: '#4ade80',
  available: '#4ade80',
  unreachable: '#f2a1a1',
  error: '#f2a1a1',
  disabled: '#8b95a1',
  stopped: '#8b95a1',
  checking: '#fbbf24',
  starting: '#fbbf24',
  unknown: '#8b95a1',
};

/**
 * A rounded uppercase status chip (healthy / unreachable / starting / …).
 * Shared by the local GPU runner and the LAN asset-agent rows, which both report
 * the same health vocabulary from the main process.
 */
export function HealthChip({ health }: { health: string }) {
  const color = healthColors[health] ?? '#8b95a1';
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        color,
        border: `1px solid ${color}`,
        borderRadius: 999,
        padding: '2px 8px',
        textTransform: 'uppercase',
        letterSpacing: 0.4,
      }}
    >
      {health}
    </span>
  );
}

/** A small pill used for alias / phrase tags. */
export const settingsChip: CSSProperties = {
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

/** A compact secondary button (per-row actions like Remove / Revoke). */
export const settingsTinyButton: CSSProperties = {
  ...settingsGhostButton,
  padding: '3px 9px',
  fontSize: 11,
};
