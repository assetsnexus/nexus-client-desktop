import { describe, expect, it, vi } from 'vitest';
import { agentPresenceFromAgentDoc, createMeetingsManager } from './meetings-manager.js';

function senderReturning(result: unknown) {
  const send = vi.fn(async () => result);
  return { send };
}

/** Sender that answers rooms.get + agents.get distinctly, keyed by id. */
function routingSender(room: unknown, agents: Record<string, unknown>) {
  const send = vi.fn(async (command: string, payload?: Record<string, unknown>) => {
    if (command === 'anx.communicate.rooms.get') return room;
    if (command === 'anx.agents.get') {
      const id = String(payload?.agentId ?? '');
      return agents[id] ?? { data: {} };
    }
    return { data: {} };
  });
  return { send };
}

describe('createMeetingsManager', () => {
  it('projects a room roster into serializable rows', async () => {
    const mgr = createMeetingsManager({
      loadPresence: false,
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
    expect(room!.presence).toEqual({});
  });

  it('hydrates agent presence from anx.agents.get', async () => {
    const mgr = createMeetingsManager({
      getSender: async () =>
        routingSender(
          {
            data: {
              id: 'room-1',
              participants: [
                { id: 'u1', type: 'user', displayName: 'Sam' },
                { id: 'a1', type: 'agent', displayName: 'Ada' },
              ],
            },
          },
          {
            a1: {
              data: {
                id: 'a1',
                embodiment: {
                  enabled: true,
                  preset: 'default',
                  vrmUrl: 'https://cdn/ada.vrm',
                  defaultMood: 'happy',
                  lipSyncEnabled: false,
                },
              },
            },
          },
        ),
    });

    const room = await mgr.getRoom('room-1');
    expect(room!.presence.a1).toMatchObject({
      vrmUrl: 'https://cdn/ada.vrm',
      defaultMood: 'happy',
      lipSyncEnabled: false,
    });
    // Humans never get a presence lookup.
    expect(room!.presence.u1).toBeUndefined();
  });

  it('prefers a top-level sceneId over orchestration', async () => {
    const mgr = createMeetingsManager({
      loadPresence: false,
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
      loadPresence: false,
      getSender: async () =>
        senderReturning({ data: { id: 'r', participants: [null, { type: 'user' }, { id: 'ok' }] } }),
    });
    const room = await mgr.getRoom('r');
    expect(room!.participants).toEqual([
      { id: 'ok', type: 'user', displayName: null, avatarUrl: null },
    ]);
  });

  it('carries persisted Phase 7d moderation fields through the projection', async () => {
    const mgr = createMeetingsManager({
      loadPresence: false,
      getSender: async () =>
        senderReturning({
          data: {
            id: 'room-1',
            participants: [
              { id: 'a1', type: 'agent', muted: true, listening: false, videoEnabled: false },
              { id: 'u1', type: 'user' },
            ],
          },
        }),
    });
    const room = await mgr.getRoom('room-1');
    expect(room!.participants[0]).toMatchObject({
      id: 'a1',
      muted: true,
      listening: false,
      videoEnabled: false,
    });
    // Unset fields stay undefined so the renderer can fall back to defaults.
    expect(room!.participants[1].muted).toBeUndefined();
    expect(room!.participants[1].listening).toBeUndefined();
  });
});

describe('agentPresenceFromAgentDoc', () => {
  it('reads the embodiment profile', () => {
    const presence = agentPresenceFromAgentDoc({
      embodiment: {
        vrmUrl: 'https://cdn/a.vrm',
        defaultMood: 'curious',
        lipSyncEnabled: true,
        gestureManifestUrl: 'https://cdn/a.json',
      },
      presence: { voiceId: 'v-1', vrmValidationStatus: 'verified' },
    });
    expect(presence.vrmUrl).toBe('https://cdn/a.vrm');
    expect(presence.defaultMood).toBe('curious');
    expect(presence.voiceId).toBe('v-1');
    expect(presence.vrmValidationStatus).toBe('verified');
    expect(presence.lipSyncEnabled).toBe(true);
  });

  it('degrades to an all-null presence for a bare agent', () => {
    const presence = agentPresenceFromAgentDoc({ id: 'a1' });
    expect(presence.vrmUrl).toBeNull();
    expect(presence.defaultMood).toBe('neutral');
    expect(presence.lipSyncEnabled).toBe(true);
  });
});
