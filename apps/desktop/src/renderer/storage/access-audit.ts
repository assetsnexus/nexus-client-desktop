/**
 * Pure helpers behind the storage hub's **Access audit** section.
 *
 * The audit is a filtered, keyset-paginated view over the region's storage
 * access log (`anx.storage.access-audit.list`) plus a destructive grant
 * revocation (`anx.storage.access-audit.revoke-grant`). Everything that can be
 * reasoned about without a DOM — the command payloads, the defensive reply
 * parsing, the accessor display resolution, the cursor stack — lives here so it
 * can be unit-tested without a renderer or a live region, mirroring
 * `portal-collections.ts`.
 *
 * Two rules from the plan drive the defensive shape of this module:
 *  - a **failed** request must never be indistinguishable from "no accesses
 *    ever" — the loaders reject, and the section renders a distinct error state;
 *  - the accessor is shown as a **resolved label**, never a bare opaque id.
 */

import { readReply, type CollectionCommandClient } from './portal-collections.js';

/** The four coarse access classes the region groups operations into. */
export type AuditOperationClass = 'read' | 'write' | 'search' | 'share';

/** Direction filter: any class, or one specific class. */
export type AuditDirection = 'all' | AuditOperationClass;

/** Kinds of principal the region can attribute an access to. */
export type AuditAccessorKind = 'user' | 'agent' | 'share' | 'app' | 'guest' | 'service';

/** Grants whose revocation the audit rail can dispatch. */
export type AuditGrantKind = 'share' | 'data_room_share' | 'workspace_member';

/** Region pagination defaults (`limit` default 50, hard cap 200). */
export const DEFAULT_AUDIT_LIMIT = 50;
export const MAX_AUDIT_LIMIT = 200;

const DIRECTIONS: readonly AuditDirection[] = ['all', 'read', 'write', 'search', 'share'];
const ACCESSOR_KINDS: readonly AuditAccessorKind[] = [
  'user',
  'agent',
  'share',
  'app',
  'guest',
  'service',
];
const GRANT_KINDS: readonly AuditGrantKind[] = ['share', 'data_room_share', 'workspace_member'];

/** A normalized audit row: every optional field is either a valid value or absent. */
export type AccessAuditRow = {
  id: string;
  /** ISO timestamp of the access (or of the first access in a grouped row). */
  timestamp: string;
  operation: string;
  operationClass?: AuditOperationClass;
  accessorKind?: AuditAccessorKind;
  accessorId?: string;
  accessorLabel?: string;
  accessorUnattributed: boolean;
  fileId?: string;
  path?: string;
  workspaceId?: string;
  query?: string;
  ownerUserId?: string;
  ownerOrgId?: string;
  /** Present only on a grouped row: how many accesses were collapsed. */
  count?: number;
  firstAt?: string;
  lastAt?: string;
  /** Present only on a grouped row: the distinct files the accesses touched. */
  touchedFiles?: string[];
  /** Present when this row can be revoked from the audit rail. */
  grantKind?: AuditGrantKind;
  grantId?: string;
};

/** The region's page metadata for `group: 'sequential'`. */
export type AuditGroupInfo = {
  grouped: boolean;
  /** True when grouping was computed over just this page, not the whole log. */
  pageLocal: boolean;
};

/** One parsed page of the audit log. */
export type StorageAuditPage = {
  items: AccessAuditRow[];
  /** Opaque keyset cursor for the next page; a string, or absent at the end. */
  nextCursor?: string;
  groupInfo?: AuditGroupInfo;
};

/** The filter state the section edits and the payload builder consumes. */
export type AccessAuditFilterState = {
  direction: AuditDirection;
  /** `''` means "any principal". */
  accessorKind: AuditAccessorKind | '';
  accessorId: string;
  pathPattern: string;
  queryPattern: string;
  /** Date-only (`YYYY-MM-DD`) from a date input, or a full ISO timestamp. */
  since: string;
  until: string;
  groupSequential: boolean;
};

export const DEFAULT_ACCESS_AUDIT_FILTERS: AccessAuditFilterState = {
  direction: 'all',
  accessorKind: '',
  accessorId: '',
  pathPattern: '',
  queryPattern: '',
  since: '',
  until: '',
  groupSequential: false,
};

export function isAuditOperationClass(value: unknown): value is AuditOperationClass {
  return typeof value === 'string' && (DIRECTIONS as readonly string[]).includes(value) && value !== 'all';
}

export function isAuditAccessorKind(value: unknown): value is AuditAccessorKind {
  return typeof value === 'string' && (ACCESSOR_KINDS as readonly string[]).includes(value);
}

export function isAuditGrantKind(value: unknown): value is AuditGrantKind {
  return typeof value === 'string' && (GRANT_KINDS as readonly string[]).includes(value);
}

/**
 * Derive an access class from an operation string.
 *
 * The region stamps `operationClass` itself; this is a defensive fallback for an
 * older or partial row. Order matters: a mutating op whose name also contains a
 * read/search hint (`search_replace`, `partial_edit`) is a **write**, and a share
 * grant operation (`share_link_revoke`) is a **share** rather than a read.
 */
export function deriveOperationClass(operation: string): AuditOperationClass | undefined {
  const op = operation.toLowerCase();
  if (!op) return undefined;
  // Checked before the write family: `workspace_member_remove` carries the
  // `member` hint but also the `remove`→`move` substring, so member management
  // must be classified as a share operation first.
  if (op.includes('member') || op.includes('grant') || op.includes('invite')) return 'share';
  if (
    op.includes('replace') ||
    op.includes('edit') ||
    op.includes('write') ||
    op.includes('create') ||
    op.includes('upload') ||
    op.includes('delete') ||
    op.includes('trash') ||
    op.includes('restore') ||
    op.includes('copy') ||
    op.includes('rename') ||
    op.includes('move')
  ) {
    return 'write';
  }
  if (op.includes('search') || op.includes('query')) return 'search';
  if (op.includes('share') || op.includes('revoke')) return 'share';
  if (
    op.includes('read') ||
    op.includes('download') ||
    op.includes('list') ||
    op.includes('view') ||
    op.includes('preview') ||
    op.includes('export')
  ) {
    return 'read';
  }
  return undefined;
}

/** Trim a filter string; a non-string becomes `''`. */
function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Coerce an arbitrary partial filter object into the canonical filter state. */
export function normalizeAccessAuditFilters(
  partial?: Partial<AccessAuditFilterState>,
): AccessAuditFilterState {
  const direction = partial?.direction;
  const accessorKind = partial?.accessorKind;
  return {
    direction:
      typeof direction === 'string' && (DIRECTIONS as readonly string[]).includes(direction)
        ? direction
        : DEFAULT_ACCESS_AUDIT_FILTERS.direction,
    accessorKind: isAuditAccessorKind(accessorKind) ? accessorKind : '',
    accessorId: cleanString(partial?.accessorId),
    pathPattern: cleanString(partial?.pathPattern),
    queryPattern: cleanString(partial?.queryPattern),
    since: cleanString(partial?.since),
    until: cleanString(partial?.until),
    groupSequential: partial?.groupSequential === true,
  };
}

/** Clamp a page size to `[1, 200]`, defaulting a non-number to 50. */
export function clampAuditLimit(limit?: number): number {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_AUDIT_LIMIT;
  return Math.min(Math.trunc(n), MAX_AUDIT_LIMIT);
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Bound a filter date as an ISO instant. A date-only input is widened to the
 * start (for `since`) or end (for `until`) of that day so a single-day range is
 * inclusive; an already-full timestamp is passed through untouched.
 */
export function auditDateBound(value: string, endOfDay: boolean): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (DATE_ONLY.test(trimmed)) {
    return `${trimmed}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`;
  }
  return trimmed;
}

/**
 * Request payload for `anx.storage.access-audit.list`.
 *
 * Empty filters are omitted so the region sees only what the caller actually
 * asked for; `direction: 'all'` is the region's default and is not sent. The
 * cursor is only ever forwarded as a **string**.
 */
export function storageAuditListPayload(
  filters: AccessAuditFilterState,
  cursor?: string,
  limit: number = DEFAULT_AUDIT_LIMIT,
): Record<string, unknown> {
  const normalized = normalizeAccessAuditFilters(filters);
  const payload: Record<string, unknown> = {
    limit: clampAuditLimit(limit),
    group: normalized.groupSequential ? 'sequential' : 'none',
  };
  const trimmedCursor = typeof cursor === 'string' ? cursor.trim() : '';
  if (trimmedCursor) payload.cursor = trimmedCursor;
  if (normalized.direction !== 'all') payload.direction = normalized.direction;
  if (normalized.accessorKind) payload.accessorKind = normalized.accessorKind;
  if (normalized.accessorId) payload.accessorId = normalized.accessorId;
  if (normalized.pathPattern) payload.pathPattern = normalized.pathPattern;
  if (normalized.queryPattern) payload.queryPattern = normalized.queryPattern;
  const since = auditDateBound(normalized.since, false);
  const until = auditDateBound(normalized.until, true);
  if (since) payload.since = since;
  if (until) payload.until = until;
  return payload;
}

/** Request payload for `anx.storage.access-audit.revoke-grant`. */
export function storageAuditRevokePayload(
  grantKind: AuditGrantKind,
  grantId: string,
): Record<string, unknown> {
  return { grantKind, grantId };
}

/** Pull an `items` array out of a list reply, tolerating `{ items }` or a bare array. */
function readItems(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const items = (data as Record<string, unknown>).items;
    if (Array.isArray(items)) return items;
  }
  return [];
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readPositiveInt(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.trunc(n);
}

/**
 * Normalize one raw row. A row without a usable `id` cannot be rendered as a
 * stable key, so `null` is returned and the caller drops it.
 */
export function normalizeAuditRow(raw: unknown): AccessAuditRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const id = readString(record.id);
  if (!id) return null;

  const timestamp = readString(record.timestamp) ?? '';
  const operation = readString(record.operation) ?? '';
  const operationClass = isAuditOperationClass(record.operationClass)
    ? record.operationClass
    : deriveOperationClass(operation);

  const rawAccessor =
    record.accessor && typeof record.accessor === 'object'
      ? (record.accessor as Record<string, unknown>)
      : null;

  const touchedFiles = Array.isArray(record.touchedFiles)
    ? record.touchedFiles.filter((f): f is string => typeof f === 'string' && f.length > 0)
    : undefined;

  return {
    id,
    timestamp,
    operation,
    operationClass,
    accessorKind: rawAccessor && isAuditAccessorKind(rawAccessor.kind) ? rawAccessor.kind : undefined,
    accessorId: rawAccessor ? readString(rawAccessor.id) : undefined,
    accessorLabel: rawAccessor ? readString(rawAccessor.label) : undefined,
    accessorUnattributed: record.accessorUnattributed === true,
    fileId: readString(record.fileId),
    path: readString(record.path),
    workspaceId: readString(record.workspaceId),
    query: readString(record.query),
    ownerUserId: readString(record.ownerUserId),
    ownerOrgId: readString(record.ownerOrgId),
    count: readPositiveInt(record.count),
    firstAt: readString(record.firstAt),
    lastAt: readString(record.lastAt),
    touchedFiles: touchedFiles && touchedFiles.length ? touchedFiles : undefined,
    grantKind: isAuditGrantKind(record.grantKind) ? record.grantKind : undefined,
    grantId: readString(record.grantId),
  };
}

/**
 * Parse `anx.storage.access-audit.list`.
 *
 * Rows without a string id are dropped; the cursor is only accepted as a
 * non-empty **string** (a numeric or empty cursor means "no next page" rather
 * than a bogus offset), and `groupInfo` is only surfaced when both flags are
 * real booleans.
 */
export function parseStorageAuditPage(data: unknown): StorageAuditPage {
  const items = readItems(data)
    .map(normalizeAuditRow)
    .filter((row): row is AccessAuditRow => row !== null);

  const page: StorageAuditPage = { items };

  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    const nextCursor = typeof record.nextCursor === 'string' ? record.nextCursor.trim() : '';
    if (nextCursor) page.nextCursor = nextCursor;

    const rawGroup = record.groupInfo;
    if (rawGroup && typeof rawGroup === 'object') {
      const group = rawGroup as Record<string, unknown>;
      if (typeof group.grouped === 'boolean' && typeof group.pageLocal === 'boolean') {
        page.groupInfo = { grouped: group.grouped, pageLocal: group.pageLocal };
      }
    }
  }

  return page;
}

/** The outcome of a revoke request. */
export type AuditRevokeResult = {
  revoked: boolean;
  grantKind?: string;
  grantId?: string;
};

/** Parse `anx.storage.access-audit.revoke-grant`; only `revoked === true` counts. */
export function parseRevokeResult(data: unknown): AuditRevokeResult {
  if (!data || typeof data !== 'object') return { revoked: false };
  const record = data as Record<string, unknown>;
  return {
    revoked: record.revoked === true,
    grantKind: readString(record.grantKind),
    grantId: readString(record.grantId),
  };
}

/** Fetch a page of the audit log. A region error rejects so the UI can retry. */
export async function loadStorageAuditPage(
  client: CollectionCommandClient,
  filters: AccessAuditFilterState,
  cursor?: string,
  limit?: number,
): Promise<StorageAuditPage> {
  const reply = readReply(
    await client.send('anx.storage.access-audit.list', storageAuditListPayload(filters, cursor, limit)),
  );
  if (!reply.ok) throw new Error(reply.message || 'Could not load the access audit.');
  return parseStorageAuditPage(reply.data);
}

/**
 * Revoke a grant. Rejects with the region's own message when the request is
 * refused, so the confirm dialog can show why instead of a generic failure.
 */
export async function revokeStorageGrant(
  client: CollectionCommandClient,
  grantKind: AuditGrantKind,
  grantId: string,
): Promise<AuditRevokeResult> {
  const reply = readReply(
    await client.send('anx.storage.access-audit.revoke-grant', storageAuditRevokePayload(grantKind, grantId)),
  );
  if (!reply.ok) throw new Error(reply.message || 'Could not revoke access.');
  return parseRevokeResult(reply.data);
}

/* ------------------------------------------------------------------ *
 * Cursor stack — Previous must return to the exact prior page, never a
 * recomputed offset. The first page is represented by an empty string.
 * ------------------------------------------------------------------ */

export const FIRST_AUDIT_PAGE: readonly string[] = [''];

/** The cursor to send for the page currently on screen. */
export function auditCursorAt(stack: readonly string[]): string | undefined {
  const value = stack.length ? stack[stack.length - 1] : '';
  return value || undefined;
}

/** Push a fetched `nextCursor` so Next moves forward one page. */
export function pushAuditCursor(
  stack: readonly string[],
  nextCursor: string | undefined,
): readonly string[] {
  const next = typeof nextCursor === 'string' ? nextCursor.trim() : '';
  return next ? [...stack, next] : stack;
}

/** Drop the current page so Previous returns to the one before it. */
export function popAuditCursor(stack: readonly string[]): readonly string[] {
  return stack.length > 1 ? stack.slice(0, -1) : stack.length ? [''] : [''];
}

/* ------------------------------------------------------------------ *
 * Display helpers.
 * ------------------------------------------------------------------ */

/** Shorten an opaque id for display; long ids keep their head plus an ellipsis. */
export function shortenId(id: string, max = 12): string {
  const trimmed = id.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(1, max - 1))}…`;
}

/** A resolved accessor presentation, ready for the component to translate. */
export type AccessorDisplay = {
  /** True when the region explicitly could not attribute the access. */
  unattributed: boolean;
  kind: AuditAccessorKind | 'unknown';
  /** The region-provided human label, when it sent one. */
  label: string | null;
  /** A shortened id, when the row carried one. */
  id: string | null;
};

/**
 * Resolve how a row's accessor should be shown.
 *
 * Precedence: an explicit region label wins; an unattributed service access is
 * flagged so the UI can say so plainly; otherwise the kind plus a shortened id
 * gives something a human can read — never the raw opaque id on its own.
 */
export function resolveAccessorDisplay(row: AccessAuditRow): AccessorDisplay {
  return {
    unattributed: row.accessorUnattributed,
    kind: row.accessorKind ?? 'unknown',
    label: row.accessorLabel ?? null,
    id: row.accessorId ? shortenId(row.accessorId) : null,
  };
}

/** True when the region collapsed several sequential accesses into this row. */
export function auditRowIsGrouped(row: AccessAuditRow): boolean {
  return row.count !== undefined || (row.touchedFiles?.length ?? 0) > 0;
}

/** How many accesses a (possibly grouped) row represents. */
export function auditRowCount(row: AccessAuditRow): number {
  return row.count && row.count > 0 ? row.count : 1;
}

/** How many distinct files a grouped row touched. */
export function auditRowTouchedFileCount(row: AccessAuditRow): number {
  return row.touchedFiles?.length ?? 0;
}

/** A row offers revoke only when the region marked a revocable grant on it. */
export function auditRowCanRevoke(row: AccessAuditRow): boolean {
  return row.grantKind !== undefined && typeof row.grantId === 'string' && row.grantId.length > 0;
}
