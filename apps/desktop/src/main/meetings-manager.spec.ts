import { describe, expect, it, vi } from 'vitest';
import { createMeetingsManager } from './meetings-manager.js';

function senderReturning(result: unknown) {
  const send = vi.fn(async () => result);
  return { send };
}

describe('createMeetingsManager', () => {
  it('projects a room roster into serializable rows', async () => {
    const mgr = createMeetingsManager({
      getSender: async () =>
        senderReturning({
          data: {
            id: 'room-1',
            title: 'Standup',
            type: 'group',
            participants: [
              { id: 'u1', type: 'user', displayName: 'Sam' },
              { id: 'a1', type: 'virtual_agent', username: 'ada' },
              { id: 's1', type: 'asset_agent', avatarUrl: 'https://x/y.png' },
            ],
            orchestration: { sceneId: 'cluster-9' },
          },
        }),
    });

    const room = await mgr.getRoom('room-1');
    expect(room).not.toBeNull();
    expect(room!.id).toBe('room-1');
    expect(room!.conversationId).toBe('room-1');
    expect(room!.sceneId).toBe('cluster-9');
    expect(room!.participants).toEqual([
      { id: 'u1', type: 'user', displayName: 'Sam', avatarUrl: null },
      { id: 'a1', type: 'virtual_agent', displayName: 'ada', avatarUrl: null },
      { id: 's1', type: 'asset_agent', displayName: null, avatarUrl: 'https://x/y.png' },
    ]);
  });

  it('prefers a top-level sceneId over orchestration', async () => {
    const mgr = createMeetingsManager({
      getSender: async () =>
        senderReturning({ data: { id: 'r', sceneId: 'top', orchestration: { sceneId: 'nested' } } }),
    });
    const room = await mgr.getRoom('r');
    expect(room!.sceneId).toBe('top');
  });

  it('returns null when the room payload is missing an id', async () => {
    const mgr = createMeetingsManager({ getSender: async () => senderReturning({ data: {} }) });
    expect(await mgr.getRoom('nope')).toBeNull();
  });

  it('drops malformed participants', async () => {
    const mgr = createMeetingsManager({
      getSender: async () =>
        senderReturning({ data: { id: 'r', participants: [null, { type: 'user' }, { id: 'ok' }] } }),
    });
    const room = await mgr.getRoom('r');
    expect(room!.participants).toEqual([{ id: 'ok', type: 'user', displayName: null, avatarUrl: null }]);
  });
});
