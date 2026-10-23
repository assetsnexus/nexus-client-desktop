/**
 * Client-tool audit trail: shared types + **pure** helpers.
 *
 * Whenever an agent invokes a client tool (the desktop's `app.*` IPC tools), the
 * main process writes one audit entry so the user can trace a call back to the
 * agent and the conversation it came from. Everything here is pure and
 * dependency-free (no `electron`, no `node:fs`) so the entry shaping, retention
 * math and filtering are unit-testable and identical on both sides of IPC.
 *
 * The store itself (`main/audit-store.ts`) is main-process only and append-only;
 * this module never reads or writes disk.
 */

import { truncateForAudit, redactValue } from './redaction.js';

/** Schema version of a persisted entry; bump only on a breaking shape change. */
export const AUDIT_ENTRY_VERSION = 1 as const;

export type AuditOutcome = 'ok' | 'error';

/** One recorded client-tool invocation. The `v` field pins the on-disk shape. */
export type ClientToolAuditEntry = {
  v: typeof AUDIT_ENTRY_VERSION;
  /** Stable unique id (main-generated, monotonic within a run). */
  id: string;
  /** Epoch ms the call finished. */
  at: number;
  /** Tool name the agent asked for, e.g. `app.fs.read`. */
  tool: string;
  /** Which agent made the call (contact/agent id). `null` when unknown. */
  agentId: string | null;
  /**
   * Conversation the call belongs to, so the user can trace a call back to a
   * conversation. `null` when the call arrived outside a chat turn.
   */
  conversationId: string | null;
  /** Host surface that ran the tool (always `desktop` today). */
  source: string;
  /** `ok` when the tool ran to completion, `error` when it refused/failed. */
  outcome: AuditOutcome;
  /** Wall-clock duration of the invocation, ms. */
  durationMs: number;
  /** Redacted + truncated arguments the agent sent. */
  args: unknown;
  /** Redacted + truncated result on success (omitted on error). */
  result?: unknown;
  /** Human-safe error string on failure (omitted on success). */
  error?: string | null;
  argsTruncated: boolean;
  resultTruncated: boolean;
  /** Approximate persisted size in bytes, so retention can bound total size. */
  bytes: number;
};

export type ShapeAuditEntryInput = {
  id: string;
  tool: string;
  agentId: string | null | undefined;
  conversationId: string | null | undefined;
  source: string;
  ok: boolean;
  args: unknown;
  result?: unknown;
  error?: string | null;
  /** Epoch ms the call started. */
  startedAt: number;
  /** Epoch ms the call finished (defaults to `startedAt`). */
  finishedAt?: number;
};

/**
 * Shape one audit entry: redact secrets, bound oversized payloads, and compute
 * the derived fields. Pure — the same inputs always yield the same entry (modulo
 * the injected `id`), which is what the tests pin.
 */
export function shapeAuditEntry(input: ShapeAuditEntryInput): ClientToolAuditEntry {
  const finishedAt = input.finishedAt ?? input.startedAt;
  const args = truncateForAudit(redactValue(input.args ?? null));
  const shapedResult = input.ok ? truncateForAudit(redactValue(input.result ?? null)) : null;
  const entry: ClientToolAuditEntry = {
    v: AUDIT_ENTRY_VERSION,
    id: input.id,
    at: finishedAt,
    tool: input.tool,
    agentId: input.agentId ?? null,
    conversationId: input.conversationId ?? null,
    source: input.source,
    outcome: input.ok ? 'ok' : 'error',
    durationMs: Math.max(0, finishedAt - input.startedAt),
    args: args.value,
    argsTruncated: args.truncated,
    resultTruncated: shapedResult?.truncated ?? false,
    bytes: args.bytes + (shapedResult?.bytes ?? 0),
  };
  if (input.ok) {
    entry.result = shapedResult?.value ?? null;
  } else {
    entry.error = input.error ?? 'tool failed';
  }
  entry.bytes += byteSizeOfEntry(entry);
  return entry;
}

/** Serialised size of an entry, used by retention to bound the total. */
export function byteSizeOfEntry(entry: ClientToolAuditEntry): number {
  try {
    return JSON.stringify(entry).length;
  } catch {
    return 0;
  }
}

// ─── Retention ──────────────────────────────────────────────────────────────

export type AuditRetention = {
  /** Keep at most this many most-recent entries (0 = unbounded). */
  maxEntries: number;
  /** Drop entries older than this many days (0 = no age limit). */
  maxAgeDays: number;
  /** Keep the store under this many bytes, trimming oldest first (0 = unbounded). */
  maxBytes: number;
};

export const BYTES_PER_MIB = 1024 * 1024;

/** Selectable ceilings for the settings UI (a `0` disables that bound). */
export const AUDIT_RETENTION_CHOICES = {
  maxEntries: [200, 1_000, 5_000, 20_000, 100_000, 0],
  maxAgeDays: [1, 7, 30, 90, 365, 0],
  maxBytes: [1, 5, 25, 100, 500, 0],
} as const;

/**
 * Safe default: keep a month of history, bounded to a few thousand entries and
 * ~25 MiB, so a busy agent cannot fill the disk but recent activity is intact.
 */
export const DEFAULT_AUDIT_RETENTION: AuditRetention = {
  maxEntries: 5_000,
  maxAgeDays: 30,
  maxBytes: 25 * BYTES_PER_MIB,
};

function pickNumber(raw: unknown, fallback: number, allowed?: readonly number[]): number {
  const value = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : NaN;
  if (Number.isNaN(value) || value < 0) return fallback;
  if (allowed && !allowed.includes(value)) return fallback;
  return value;
}

/**
 * Coerce a persisted/patched retention block to valid values (per-field
 * fallback), so a hand-edited file can never disable trimming with garbage.
 */
export function normalizeAuditRetention(raw: unknown): AuditRetention {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    maxEntries: pickNumber(value.maxEntries, DEFAULT_AUDIT_RETENTION.maxEntries),
    maxAgeDays: pickNumber(value.maxAgeDays, DEFAULT_AUDIT_RETENTION.maxAgeDays),
    maxBytes: pickNumber(value.maxBytes, DEFAULT_AUDIT_RETENTION.maxBytes),
  };
}

/** Oldest `at` still retained under the age bound, or `null` when unbounded. */
export function retentionCutoffMs(nowMs: number, maxAgeDays: number): number | null {
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) return null;
  return nowMs - maxAgeDays * 24 * 60 * 60 * 1000;
}

export type RetentionResult<T> = {
  kept: T[];
  dropped: number;
  /** Total persisted size of the kept entries, for the UI to show. */
  bytes: number;
};

/** Minimal shape retention needs — works for both entries and test doubles. */
export type RetainableEntry = { at: number; bytes?: number };

/**
 * Decide which entries to keep. Entries are assumed oldest→newest. Applies, in
 * order: age bound, count bound, then size bound (always trimming the oldest
 * first). Pure and deterministic.
 */
export function selectRetained<T extends RetainableEntry>(
  entries: readonly T[],
  nowMs: number,
  retention: AuditRetention,
): RetentionResult<T> {
  const cutoff = retentionCutoffMs(nowMs, retention.maxAgeDays);
  let kept = cutoff === null ? [...entries] : entries.filter((entry) => entry.at >= cutoff);

  if (retention.maxEntries > 0 && kept.length > retention.maxEntries) {
    kept = kept.slice(kept.length - retention.maxEntries);
  }

  if (retention.maxBytes > 0) {
    let total = 0;
    let start = kept.length;
    for (let i = kept.length - 1; i >= 0; i -= 1) {
      total += kept[i]!.bytes ?? 0;
      if (total > retention.maxBytes) break;
      start = i;
    }
    kept = kept.slice(start);
  }

  const bytes = kept.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
  return { kept, dropped: entries.length - kept.length, bytes };
}

// ─── Filtering ────────────────────────────────────────────────────────────────

/** UI filter for the audit browser; all fields optional (empty = no filter). */
export type AuditFilter = {
  agentId?: string | null;
  conversationId?: string | null;
  tool?: string | null;
  /** Free-text match over tool / agent / conversation / error. */
  query?: string | null;
  /** Max rows to return (0 = all). */
  limit?: number;
};

/** Case-insensitive substring match over the searchable fields of an entry. */
export function matchesAuditQuery(entry: ClientToolAuditEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [entry.tool, entry.agentId, entry.conversationId, entry.error, entry.source]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}

/**
 * Apply a filter, returning newest-first (the browser reads most-recent first).
 * Pure; the caller passes the full retained set.
 */
export function filterAuditEntries(
  entries: readonly ClientToolAuditEntry[],
  filter: AuditFilter = {},
): ClientToolAuditEntry[] {
  const out = entries.filter((entry) => {
    if (filter.agentId && entry.agentId !== filter.agentId) return false;
    if (filter.conversationId && entry.conversationId !== filter.conversationId) return false;
    if (filter.tool && entry.tool !== filter.tool) return false;
    if (filter.query && !matchesAuditQuery(entry, filter.query)) return false;
    return true;
  });
  out.sort((a, b) => b.at - a.at);
  const limit = filter.limit && filter.limit > 0 ? filter.limit : 0;
  return limit ? out.slice(0, limit) : out;
}

export type AuditFacet = { id: string; count: number };

export type AuditFacets = {
  agents: AuditFacet[];
  conversations: AuditFacet[];
  tools: AuditFacet[];
};

function facet(entries: readonly ClientToolAuditEntry[], pick: (e: ClientToolAuditEntry) => string | null): AuditFacet[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const id = pick(entry);
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

/** Distinct agent / conversation / tool ids present, for the UI dropdowns. */
export function auditFacets(entries: readonly ClientToolAuditEntry[]): AuditFacets {
  return {
    agents: facet(entries, (e) => e.agentId),
    conversations: facet(entries, (e) => e.conversationId),
    tools: facet(entries, (e) => e.tool),
  };
}

/**
 * A coarse, non-identifying correlation hint for a *display* conversation id.
 * Used by the UI to label a conversation the user can jump back into.
 */
export function auditConversationLabel(conversationId: string | null): string | null {
  return conversationId ? conversationId : null;
}
