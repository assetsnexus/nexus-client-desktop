import { describe, expect, it } from 'vitest';
import {
  dataRoomListPayload,
  dataRoomRowStats,
  loadCloudWorkspaces,
  loadDataRooms,
  parseDataRoomList,
  parseWorkspaceList,
  readReply,
  rowScopeLabel,
  withAnalytics,
  workspaceListPayload,
  workspaceRowStats,
  type CollectionCommandClient,
} from './portal-collections.js';

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

describe('readReply', () => {
  it('accepts a normalized desktop client reply', () => {
    expect(readReply({ ok: true, responseCode: 200, data: { items: [] } })).toMatchObject({
      ok: true,
      responseCode: 200,
    });
  });

  it('treats a non-2xx region envelope as not ok and surfaces its error text', () => {
    const reply = readReply({ responseCode: 403, responseObject: { error: 'Forbidden' } });
    expect(reply.ok).toBe(false);
    expect(reply.message).toBe('Forbidden');
  });

  it('falls back to the raw payload when there is no envelope', () => {
    const reply = readReply({ items: [{ id: 'dr-1' }], total: 1 });
    expect(reply.ok).toBe(true);
    expect(reply.data).toEqual({ items: [{ id: 'dr-1' }], total: 1 });
  });

  it('rejects a null/undefined reply', () => {
    expect(readReply(null).ok).toBe(false);
    expect(readReply(undefined).ok).toBe(false);
  });
});

describe('list payloads', () => {
  it('sends the filter and a clamped limit for data rooms', () => {
    expect(dataRoomListPayload('shared_with_me')).toEqual({ filter: 'shared_with_me', limit: 25, offset: 0 });
    expect(dataRoomListPayload('mine', 500).limit).toBe(100);
    expect(dataRoomListPayload('mine', 0).limit).toBe(25);
  });

  it('sends the visibility and a clamped limit for workspaces', () => {
    expect(workspaceListPayload('all')).toEqual({ visibility: 'all', limit: 25, offset: 0 });
    expect(workspaceListPayload('shared', 250).limit).toBe(100);
  });
});

describe('parseDataRoomList', () => {
  it('keeps id-bearing rows and reports the region total', () => {
    const page = parseDataRoomList({
      items: [
        { id: 'dr-1', name: 'Series A', itemCount: 3, activeShareCount: 2 },
        { id: 'dr-2', name: 'Board' },
        { name: 'no id' },
      ],
      total: 9,
    });
    expect(page.items.map((row) => row.id)).toEqual(['dr-1', 'dr-2']);
    expect(page.total).toBe(9);
  });

  it('tolerates a bare array and a missing total', () => {
    const page = parseDataRoomList([{ id: 'dr-1', name: 'One' }]);
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(1);
  });

  it('returns an empty page for an unusable payload', () => {
    expect(parseDataRoomList(null)).toEqual({ items: [], total: 0 });
    expect(parseDataRoomList({ items: 'nope' })).toEqual({ items: [], total: 0 });
  });
});

describe('parseWorkspaceList', () => {
  it('keeps id-bearing rows and surfaces hiddenCount', () => {
    const page = parseWorkspaceList({
      items: [
        { id: 'ws-1', name: 'Client A', memberCount: 2, itemCount: 4 },
        { id: '', name: 'broken' },
      ],
      total: 5,
      hiddenCount: 3,
    });
    expect(page.items.map((row) => row.id)).toEqual(['ws-1']);
    expect(page.total).toBe(5);
    expect(page.hiddenCount).toBe(3);
  });

  it('reports zero hidden when the region omits or zeroes it', () => {
    expect(parseWorkspaceList({ items: [] }).hiddenCount).toBe(0);
    expect(parseWorkspaceList({ items: [], hiddenCount: 0 }).hiddenCount).toBe(0);
  });
});

describe('dataRoomRowStats', () => {
  it('coerces missing or bogus counts to zero and leaves analytics unloaded', () => {
    expect(dataRoomRowStats({ id: 'dr-1', name: 'One' })).toEqual({
      itemCount: 0,
      activeShareCount: 0,
      visits: null,
      uniqueViewers: null,
    });
    expect(
      dataRoomRowStats({ id: 'dr-2', name: 'Two', itemCount: 4, activeShareCount: 2 }),
    ).toMatchObject({ itemCount: 4, activeShareCount: 2 });
  });

  it('merges an engagement summary, preferring visits and falling back to viewers', () => {
    const base = dataRoomRowStats({ id: 'dr-1', name: 'One' });
    expect(withAnalytics(base, { visits: 7, uniqueViewers: 5 })).toMatchObject({
      visits: 7,
      uniqueViewers: 5,
    });
    expect(withAnalytics(base, { uniqueViewers: 4 })).toMatchObject({
      visits: 4,
      uniqueViewers: 4,
    });
  });

  it('leaves the stats untouched when the summary is absent', () => {
    const base = dataRoomRowStats({ id: 'dr-1', name: 'One' });
    expect(withAnalytics(base, null)).toEqual(base);
    expect(withAnalytics(base, undefined)).toEqual(base);
  });
});

describe('workspaceRowStats', () => {
  it('coerces missing counts to zero', () => {
    expect(workspaceRowStats({ id: 'ws-1', name: 'One' })).toEqual({
      itemCount: 0,
      memberCount: 0,
      humanUserCount: 0,
      sharedItemCount: 0,
    });
  });

  it('keeps reported counts', () => {
    expect(
      workspaceRowStats({
        id: 'ws-1',
        name: 'One',
        itemCount: 3,
        memberCount: 2,
        humanUserCount: 2,
        sharedItemCount: 1,
      }),
    ).toEqual({ itemCount: 3, memberCount: 2, humanUserCount: 2, sharedItemCount: 1 });
  });
});

describe('rowScopeLabel', () => {
  it('prefers an explicit ownerScope', () => {
    expect(rowScopeLabel({ ownerScope: 'org', orgId: 'org-1' })).toBe('org');
    expect(rowScopeLabel({ ownerScope: 'personal', orgId: 'org-1' })).toBe('personal');
  });

  it('falls back to the presence of an orgId', () => {
    expect(rowScopeLabel({ orgId: 'org-1' })).toBe('org');
    expect(rowScopeLabel({})).toBe('personal');
    expect(rowScopeLabel({ orgId: null })).toBe('personal');
  });
});

describe('loadDataRooms', () => {
  it('sends anx.data-room.list and parses the page', async () => {
    const client = stubClient({
      ok: true,
      responseCode: 200,
      data: { items: [{ id: 'dr-1', name: 'Series A' }], total: 1 },
    });
    const page = await loadDataRooms(client, 'mine');
    expect(client.calls).toEqual([
      { command: 'anx.data-room.list', payload: { filter: 'mine', limit: 25, offset: 0 } },
    ]);
    expect(page.items).toHaveLength(1);
  });

  it('rejects with the region message on an error envelope', async () => {
    const client = stubClient({ responseCode: 403, responseObject: { error: 'Forbidden' } });
    await expect(loadDataRooms(client, 'shared_with_me')).rejects.toThrow('Forbidden');
  });
});

describe('loadCloudWorkspaces', () => {
  it('sends anx.workspace.list and parses the page', async () => {
    const client = stubClient({
      ok: true,
      responseCode: 200,
      data: { items: [{ id: 'ws-1', name: 'Client A' }], total: 1, hiddenCount: 2 },
    });
    const page = await loadCloudWorkspaces(client, 'all');
    expect(client.calls).toEqual([
      { command: 'anx.workspace.list', payload: { visibility: 'all', limit: 25, offset: 0 } },
    ]);
    expect(page.items).toHaveLength(1);
    expect(page.hiddenCount).toBe(2);
  });

  it('rejects with the region message on an error envelope', async () => {
    const client = stubClient({ responseCode: 400, responseObject: { error: 'Bad request' } });
    await expect(loadCloudWorkspaces(client, 'shared')).rejects.toThrow('Bad request');
  });
});
