import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACCESS_AUDIT_FILTERS,
  DEFAULT_AUDIT_LIMIT,
  MAX_AUDIT_LIMIT,
  auditCursorAt,
  auditDateBound,
  auditRowCanRevoke,
  auditRowCount,
  auditRowIsGrouped,
  auditRowTouchedFileCount,
  clampAuditLimit,
  deriveOperationClass,
  loadStorageAuditPage,
  normalizeAccessAuditFilters,
  normalizeAuditRow,
  parseRevokeResult,
  parseStorageAuditPage,
  popAuditCursor,
  pushAuditCursor,
  resolveAccessorDisplay,
  revokeStorageGrant,
  shortenId,
  storageAuditListPayload,
  storageAuditRevokePayload,
  type AccessAuditFilterState,
} from './access-audit.js';
import type { CollectionCommandClient } from './portal-collections.js';

/** A client that records calls and answers with one canned reply. */
function stubClient(reply: unknown): CollectionCommandClient & {
  calls: Array<{ command: string; payload?: Record<string, unknown> }>;
} {
  const calls: Array<{ command: string; payload?: Record<string, unknown> }> = [];
  return {
    calls,
    async send(command, payload) {
      calls.push({ command, payload });
      return reply;
    },
  };
}

const FILTERS: AccessAuditFilterState = { ...DEFAULT_ACCESS_AUDIT_FILTERS };

describe('deriveOperationClass', () => {
  it('classifies every storage operation the plan calls out', () => {
    expect(deriveOperationClass('search_query')).toBe('search');
    expect(deriveOperationClass('read_text')).toBe('read');
    expect(deriveOperationClass('partial_edit')).toBe('write');
    expect(deriveOperationClass('search_replace')).toBe('write');
    expect(deriveOperationClass('trash_file')).toBe('write');
    expect(deriveOperationClass('restore_file')).toBe('write');
    expect(deriveOperationClass('copy_file')).toBe('write');
    expect(deriveOperationClass('rename_file')).toBe('write');
  });

  it('prefers write over a read/search hint embedded in a mutating name', () => {
    expect(deriveOperationClass('search_replace')).toBe('write');
    expect(deriveOperationClass('partial_edit')).toBe('write');
  });

  it('recognises read, share and revoke families', () => {
    expect(deriveOperationClass('download')).toBe('read');
    expect(deriveOperationClass('preview')).toBe('read');
    expect(deriveOperationClass('share_link_create')).toBe('write');
    expect(deriveOperationClass('share_link_revoke')).toBe('share');
    expect(deriveOperationClass('workspace_member_remove')).toBe('share');
  });

  it('is case-insensitive and returns undefined for an unknown / empty op', () => {
    expect(deriveOperationClass('READ_TEXT')).toBe('read');
    expect(deriveOperationClass('')).toBeUndefined();
    expect(deriveOperationClass('frobnicate')).toBeUndefined();
  });
});

describe('normalizeAccessAuditFilters', () => {
  it('returns the defaults for undefined / empty input', () => {
    expect(normalizeAccessAuditFilters()).toEqual(DEFAULT_ACCESS_AUDIT_FILTERS);
    expect(normalizeAccessAuditFilters({})).toEqual(DEFAULT_ACCESS_AUDIT_FILTERS);
  });

  it('trims strings and coerces a non-boolean group flag to false', () => {
    const filters = normalizeAccessAuditFilters({
      pathPattern: '  invoices  ',
      queryPattern: 'q ',
      // A bogus runtime value must not leak through as "truthy".
      groupSequential: 'yes' as unknown as boolean,
    });
    expect(filters.pathPattern).toBe('invoices');
    expect(filters.queryPattern).toBe('q');
    expect(filters.groupSequential).toBe(false);
  });

  it('rejects an unknown direction and accessor kind', () => {
    const filters = normalizeAccessAuditFilters({
      direction: 'nonsense' as AccessAuditFilterState['direction'],
      accessorKind: 'robot' as AccessAuditFilterState['accessorKind'],
    });
    expect(filters.direction).toBe('all');
    expect(filters.accessorKind).toBe('');
  });

  it('keeps a valid direction and accessor kind', () => {
    const filters = normalizeAccessAuditFilters({ direction: 'write', accessorKind: 'agent' });
    expect(filters.direction).toBe('write');
    expect(filters.accessorKind).toBe('agent');
  });
});

describe('clampAuditLimit', () => {
  it('caps at 200 and defaults a bad value to 50', () => {
    expect(clampAuditLimit(500)).toBe(MAX_AUDIT_LIMIT);
    expect(clampAuditLimit(0)).toBe(DEFAULT_AUDIT_LIMIT);
    expect(clampAuditLimit(-5)).toBe(DEFAULT_AUDIT_LIMIT);
    expect(clampAuditLimit(Number.NaN)).toBe(DEFAULT_AUDIT_LIMIT);
    expect(clampAuditLimit(25)).toBe(25);
    expect(clampAuditLimit(25.9)).toBe(25);
  });
});

describe('auditDateBound', () => {
  it('widens a date-only bound to the inclusive start / end of day', () => {
    expect(auditDateBound('2026-03-01', false)).toBe('2026-03-01T00:00:00.000Z');
    expect(auditDateBound('2026-03-01', true)).toBe('2026-03-01T23:59:59.999Z');
  });

  it('passes a full timestamp through untouched', () => {
    const iso = '2026-03-01T12:30:00.000Z';
    expect(auditDateBound(iso, false)).toBe(iso);
    expect(auditDateBound(iso, true)).toBe(iso);
  });

  it('returns undefined for an empty / whitespace bound', () => {
    expect(auditDateBound('', false)).toBeUndefined();
    expect(auditDateBound('   ', true)).toBeUndefined();
  });
});

describe('storageAuditListPayload', () => {
  it('sends only the limit and group when no filter is set', () => {
    expect(storageAuditListPayload(FILTERS)).toEqual({ limit: 50, group: 'none' });
  });

  it('omits the cursor when empty and forwards it as a string when present', () => {
    expect(storageAuditListPayload(FILTERS, '')).not.toHaveProperty('cursor');
    expect(storageAuditListPayload(FILTERS, '   ')).not.toHaveProperty('cursor');
    expect(storageAuditListPayload(FILTERS, 'cur-1').cursor).toBe('cur-1');
  });

  it('never coerces a numeric cursor to a number', () => {
    const payload = storageAuditListPayload(FILTERS, '1710');
    expect(payload.cursor).toBe('1710');
    expect(typeof payload.cursor).toBe('string');
  });

  it('carries direction, accessor, path and query filters', () => {
    const payload = storageAuditListPayload({
      ...FILTERS,
      direction: 'write',
      accessorKind: 'agent',
      accessorId: 'agent-1',
      pathPattern: 'invoices/*',
      queryPattern: 'revenue',
    });
    expect(payload).toMatchObject({
      direction: 'write',
      accessorKind: 'agent',
      accessorId: 'agent-1',
      pathPattern: 'invoices/*',
      queryPattern: 'revenue',
    });
    expect(payload).not.toHaveProperty('since');
    expect(payload).not.toHaveProperty('until');
  });

  it("drops the direction filter for 'all' (the region default)", () => {
    expect(storageAuditListPayload({ ...FILTERS, direction: 'all' })).not.toHaveProperty('direction');
  });

  it('sends the group mode and widens date-only bounds', () => {
    const payload = storageAuditListPayload({
      ...FILTERS,
      groupSequential: true,
      since: '2026-01-01',
      until: '2026-01-31',
    });
    expect(payload.group).toBe('sequential');
    expect(payload.since).toBe('2026-01-01T00:00:00.000Z');
    expect(payload.until).toBe('2026-01-31T23:59:59.999Z');
  });

  it('bounds the limit and normalizes a bogus filter object', () => {
    const payload = storageAuditListPayload(
      { ...FILTERS, direction: 'bogus' as AccessAuditFilterState['direction'] },
      undefined,
      9999,
    );
    expect(payload.limit).toBe(MAX_AUDIT_LIMIT);
    expect(payload).not.toHaveProperty('direction');
  });
});

describe('storageAuditRevokePayload', () => {
  it('names the grant kind and id', () => {
    expect(storageAuditRevokePayload('share', 'g-1')).toEqual({ grantKind: 'share', grantId: 'g-1' });
  });
});

describe('normalizeAuditRow', () => {
  it('keeps a fully populated row', () => {
    const row = normalizeAuditRow({
      id: 'row-1',
      timestamp: '2026-01-02T03:04:05.000Z',
      operation: 'read_text',
      operationClass: 'read',
      accessor: { kind: 'agent', id: 'agent-abcdef1234567890', label: 'Selene' },
      fileId: 'f-1',
      path: '/clients/acme/contract.pdf',
      workspaceId: 'ws-1',
      ownerUserId: 'u-1',
      ownerOrgId: 'org-1',
      grantKind: 'share',
      grantId: 'g-1',
    });
    expect(row).toMatchObject({
      id: 'row-1',
      operationClass: 'read',
      accessorKind: 'agent',
      accessorId: 'agent-abcdef1234567890',
      accessorLabel: 'Selene',
      grantKind: 'share',
      grantId: 'g-1',
      accessorUnattributed: false,
    });
  });

  it('drops a row without a usable id and tolerates non-objects', () => {
    expect(normalizeAuditRow({ timestamp: 'x' })).toBeNull();
    expect(normalizeAuditRow({ id: '' })).toBeNull();
    expect(normalizeAuditRow(null)).toBeNull();
    expect(normalizeAuditRow('nope')).toBeNull();
  });

  it('derives the operation class when the region omits it', () => {
    expect(normalizeAuditRow({ id: 'r', operation: 'trash_file' })?.operationClass).toBe('write');
  });

  it('marks an unattributed service access', () => {
    expect(normalizeAuditRow({ id: 'r', accessorUnattributed: true })?.accessorUnattributed).toBe(true);
  });

  it('ignores an unknown accessor kind and a bogus grant kind', () => {
    const row = normalizeAuditRow({
      id: 'r',
      accessor: { kind: 'robot', id: 'x' },
      grantKind: 'nope',
    });
    expect(row?.accessorKind).toBeUndefined();
    expect(row?.grantKind).toBeUndefined();
  });

  it('keeps group fields only when present', () => {
    const grouped = normalizeAuditRow({
      id: 'r',
      count: 4,
      firstAt: 'a',
      lastAt: 'b',
      touchedFiles: ['/a', '/b', '/a'],
    });
    expect(grouped).toMatchObject({ count: 4, firstAt: 'a', lastAt: 'b' });
    expect(grouped?.touchedFiles).toEqual(['/a', '/b', '/a']);

    const plain = normalizeAuditRow({ id: 'r' });
    expect(plain?.count).toBeUndefined();
    expect(plain?.touchedFiles).toBeUndefined();
  });

  it('coerces a non-positive or non-numeric count to undefined', () => {
    expect(normalizeAuditRow({ id: 'r', count: 0 })?.count).toBeUndefined();
    expect(normalizeAuditRow({ id: 'r', count: 'x' })?.count).toBeUndefined();
  });

  it('drops empty entries from touchedFiles', () => {
    expect(normalizeAuditRow({ id: 'r', touchedFiles: ['', 'ok', 3] })?.touchedFiles).toEqual(['ok']);
    expect(normalizeAuditRow({ id: 'r', touchedFiles: [] })?.touchedFiles).toBeUndefined();
  });
});

describe('parseStorageAuditPage', () => {
  it('keeps id-bearing rows and forwards a string cursor', () => {
    const page = parseStorageAuditPage({
      items: [{ id: 'a' }, { id: 'b' }, { name: 'no id' }],
      nextCursor: 'cur-2',
    });
    expect(page.items.map((r) => r.id)).toEqual(['a', 'b']);
    expect(page.nextCursor).toBe('cur-2');
  });

  it('tolerates a bare array and a missing cursor', () => {
    const page = parseStorageAuditPage([{ id: 'a' }]);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeUndefined();
  });

  it('treats a numeric or empty cursor as the end of the log', () => {
    expect(parseStorageAuditPage({ items: [], nextCursor: 0 }).nextCursor).toBeUndefined();
    expect(parseStorageAuditPage({ items: [], nextCursor: '' }).nextCursor).toBeUndefined();
    expect(parseStorageAuditPage({ items: [], nextCursor: '   ' }).nextCursor).toBeUndefined();
  });

  it('surfaces groupInfo only when both flags are booleans', () => {
    expect(
      parseStorageAuditPage({ items: [], groupInfo: { grouped: true, pageLocal: true } }).groupInfo,
    ).toEqual({ grouped: true, pageLocal: true });
    expect(parseStorageAuditPage({ items: [], groupInfo: { grouped: true } }).groupInfo).toBeUndefined();
    expect(parseStorageAuditPage({ items: [], groupInfo: 'nope' }).groupInfo).toBeUndefined();
    expect(parseStorageAuditPage({ items: [] }).groupInfo).toBeUndefined();
  });

  it('returns an empty page for an unusable payload', () => {
    expect(parseStorageAuditPage(null)).toEqual({ items: [] });
    expect(parseStorageAuditPage({ items: 'nope' })).toEqual({ items: [] });
  });
});

describe('parseRevokeResult', () => {
  it('only reports success on an explicit revoked:true', () => {
    expect(parseRevokeResult({ revoked: true, grantKind: 'share', grantId: 'g' })).toEqual({
      revoked: true,
      grantKind: 'share',
      grantId: 'g',
    });
    expect(parseRevokeResult({ revoked: false }).revoked).toBe(false);
    expect(parseRevokeResult({}).revoked).toBe(false);
    expect(parseRevokeResult({ revoked: 'yes' }).revoked).toBe(false);
    expect(parseRevokeResult(null).revoked).toBe(false);
  });
});

describe('cursor stack', () => {
  it('sends no cursor for the first page', () => {
    expect(auditCursorAt([''])).toBeUndefined();
    expect(auditCursorAt([])).toBeUndefined();
  });

  it('sends the top of the stack for a later page', () => {
    expect(auditCursorAt(['', 'c1', 'c2'])).toBe('c2');
  });

  it('pushes a new cursor and ignores an absent one', () => {
    expect(pushAuditCursor([''], 'c1')).toEqual(['', 'c1']);
    expect(pushAuditCursor(['', 'c1'], undefined)).toEqual(['', 'c1']);
    expect(pushAuditCursor(['', 'c1'], '   ')).toEqual(['', 'c1']);
  });

  it('pops back a page and never below the first page', () => {
    expect(popAuditCursor(['', 'c1', 'c2'])).toEqual(['', 'c1']);
    expect(popAuditCursor(['', 'c1'])).toEqual(['']);
    expect(popAuditCursor([''])).toEqual(['']);
    expect(popAuditCursor([])).toEqual(['']);
  });
});

describe('display helpers', () => {
  it('prefers a region label and shortens a long id', () => {
    const display = resolveAccessorDisplay({
      id: 'r',
      timestamp: '',
      operation: 'read',
      accessorKind: 'agent',
      accessorId: 'abcdef0123456789',
      accessorLabel: 'Selene',
      accessorUnattributed: false,
    });
    expect(display).toEqual({
      unattributed: false,
      kind: 'agent',
      label: 'Selene',
      id: 'abcdef01234…',
    });
  });

  it('flags an unattributed access and reports an unknown kind rather than an id alone', () => {
    const display = resolveAccessorDisplay({
      id: 'r',
      timestamp: '',
      operation: 'read',
      accessorUnattributed: true,
    });
    expect(display.unattributed).toBe(true);
    expect(display.kind).toBe('unknown');
    expect(display.label).toBeNull();
    expect(display.id).toBeNull();
  });

  it('shortenId leaves a short id intact', () => {
    expect(shortenId('short')).toBe('short');
    expect(shortenId('  12  ')).toBe('12');
  });

  it('auditRowIsGrouped is true when a count or touched files are present', () => {
    const base = { id: 'r', timestamp: '', operation: 'read', accessorUnattributed: false };
    expect(auditRowIsGrouped(base)).toBe(false);
    expect(auditRowIsGrouped({ ...base, count: 3 })).toBe(true);
    expect(auditRowIsGrouped({ ...base, touchedFiles: ['/a'] })).toBe(true);
  });

  it('auditRowCount and touched-file count fall back to 1 / 0', () => {
    const base = { id: 'r', timestamp: '', operation: 'read', accessorUnattributed: false };
    expect(auditRowCount(base)).toBe(1);
    expect(auditRowCount({ ...base, count: 5 })).toBe(5);
    expect(auditRowTouchedFileCount(base)).toBe(0);
    expect(auditRowTouchedFileCount({ ...base, touchedFiles: ['/a', '/b'] })).toBe(2);
  });

  it('auditRowCanRevoke requires both a grant kind and id', () => {
    const base = { id: 'r', timestamp: '', operation: 'share', accessorUnattributed: false };
    expect(auditRowCanRevoke(base)).toBe(false);
    expect(auditRowCanRevoke({ ...base, grantKind: 'share' })).toBe(false);
    expect(auditRowCanRevoke({ ...base, grantId: 'g' })).toBe(false);
    expect(auditRowCanRevoke({ ...base, grantKind: 'share', grantId: 'g' })).toBe(true);
  });
});

describe('loadStorageAuditPage', () => {
  it('sends anx.storage.access-audit.list and parses the page', async () => {
    const client = stubClient({
      ok: true,
      responseCode: 200,
      data: { items: [{ id: 'a', operation: 'read_text' }], nextCursor: 'c1' },
    });
    const page = await loadStorageAuditPage(client, FILTERS, 'cur-0');
    expect(client.calls).toEqual([
      {
        command: 'anx.storage.access-audit.list',
        payload: { limit: 50, group: 'none', cursor: 'cur-0' },
      },
    ]);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe('c1');
  });

  it('rejects with the region message on an error envelope', async () => {
    const client = stubClient({ responseCode: 403, responseObject: { error: 'Forbidden' } });
    await expect(loadStorageAuditPage(client, FILTERS)).rejects.toThrow('Forbidden');
  });

  it('rejects with a fallback message when the envelope carries none', async () => {
    const client = stubClient({ responseCode: 500, responseObject: {} });
    await expect(loadStorageAuditPage(client, FILTERS)).rejects.toThrow('Could not load the access audit.');
  });
});

describe('revokeStorageGrant', () => {
  it('sends anx.storage.access-audit.revoke-grant and parses the result', async () => {
    const client = stubClient({
      ok: true,
      responseCode: 200,
      data: { revoked: true, grantKind: 'share', grantId: 'g-1' },
    });
    const result = await revokeStorageGrant(client, 'share', 'g-1');
    expect(client.calls).toEqual([
      {
        command: 'anx.storage.access-audit.revoke-grant',
        payload: { grantKind: 'share', grantId: 'g-1' },
      },
    ]);
    expect(result.revoked).toBe(true);
  });

  it('rejects with the region message when the revoke is refused', async () => {
    const client = stubClient({ responseCode: 403, responseObject: { error: 'Not the owner' } });
    await expect(revokeStorageGrant(client, 'data_room_share', 'g-2')).rejects.toThrow('Not the owner');
  });
});
