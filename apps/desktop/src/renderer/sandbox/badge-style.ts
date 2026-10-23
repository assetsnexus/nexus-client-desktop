/**
 * Shared sandbox pill-badge style (login screen + signed-in app chrome).
 *
 * Matches the portal's `SandboxHeaderBadge.vue` tokens (`#efb15a` border,
 * `#ffe0b2` background, `#6d3b00` foreground, 999px pill). One source of truth
 * so the login badge and the signed-in header badge never drift.
 */

import type { CSSProperties } from 'react';

export const sandboxBadgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '2px 9px',
  borderRadius: 999,
  border: '1px solid #efb15a',
  background: '#ffe0b2',
  color: '#6d3b00',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.04em',
  lineHeight: 1.3,
  whiteSpace: 'nowrap',
};
