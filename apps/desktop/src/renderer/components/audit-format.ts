/**
 * Pure display helpers for the client-tool audit UI.
 *
 * Kept free of React and the preload bridge so they can be unit-tested in the
 * node environment without a `window.nexus`.
 */

export const BYTES_PER_MIB_LOCAL = 1024 * 1024;

/** Format an epoch ms as a compact local time (`2026-01-02 03:04:05`). */
export function formatAuditTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

/** Human-readable byte size for the retention/size display. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < BYTES_PER_MIB_LOCAL) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / BYTES_PER_MIB_LOCAL).toFixed(2)} MiB`;
}

/** Stringify an audited value for display, guarding against cycles. */
export function formatAuditValue(value: unknown): string {
  if (value === undefined) return '';
  try {
    const json = JSON.stringify(value, null, 2);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}
