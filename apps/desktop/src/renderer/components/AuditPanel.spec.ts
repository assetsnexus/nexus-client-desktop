import { describe, expect, it } from 'vitest';
import { formatAuditTime, formatAuditValue, formatBytes } from './audit-format.js';

describe('audit panel display helpers', () => {
  it('formats an epoch as a sortable local timestamp', () => {
    // Construct a local-time date so the assertion is timezone-independent.
    const at = new Date(2026, 0, 2, 3, 4, 5).getTime();
    expect(formatAuditTime(at)).toBe('2026-01-02 03:04:05');
  });

  it('formats byte sizes for the retention display', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(2048)).toBe('2.0 KiB');
    expect(formatBytes(1024 * 1024)).toBe('1.00 MiB');
  });

  it('pretty-prints an audited value and tolerates a cycle', () => {
    expect(formatAuditValue({ a: 1 })).toContain('"a": 1');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => formatAuditValue(cyclic)).not.toThrow();
    expect(formatAuditValue(undefined)).toBe('');
  });
});
