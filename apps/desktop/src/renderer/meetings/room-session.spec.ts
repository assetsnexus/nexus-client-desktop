import { describe, expect, it } from 'vitest';
import { applyModeration, agentParticipantCount } from '@nexus/meetings-core';
import { projectRoomParticipant, projectRoomSession } from './room-session.js';

describe('projectRoomSession', () => {
  it('carries room id, conversation id, and scene id', () => {
    const session = projectRoomSession({
      id: 'room-1',
      conversationId: 'conv-9',
      sceneId: 'cluster-3',
      participants: [],
    });
    expect(session.roomId).toBe('room-1');
    expect(session.conversationId).toBe('conv-9');
    expect(session.sceneId).toBe('cluster-3');
    expect(session.participants).toEqual([]);
  });

  it('maps participant types onto participant kinds', () => {
    expect(projectRoomParticipant({ id: 'u1', type: 'user' }).kind).toBe('user');
    expect(projectRoomParticipant({ id: 'a1', type: 'agent' }).kind).toBe('agent');
    expect(projectRoomParticipant({ id: 'v1', type: 'virtual_agent' }).kind).toBe('virtual_agent');
    expect(projectRoomParticipant({ id: 's1', type: 'asset_agent' }).kind).toBe('asset_agent');
  });

  it('hydrates persisted moderation state from the room seat', () => {
    const seat = projectRoomParticipant({
      id: 'a1',
      type: 'agent',
      muted: true,
      listening: false,
    });
    expect(seat.muted).toBe(true);
    expect(seat.listening).toBe(false);
    // Absent fields fall back to the live defaults.
    const fresh = projectRoomParticipant({ id: 'a2', type: 'agent' });
    expect(fresh.muted).toBe(false);
    expect(fresh.listening).toBe(true);
  });

  it('defaults agents to an audio leg and marks asset agents as streams', () => {
    const agent = projectRoomParticipant({ id: 'a1', type: 'agent', displayName: 'Ada' });
    expect(agent.transport).toBe('audio');
    expect(agent.displayName).toBe('Ada');
    const asset = projectRoomParticipant({ id: 's1', type: 'asset_agent' });
    expect(asset.isAssetStream).toBe(true);
    const human = projectRoomParticipant({ id: 'u1', type: 'user', username: 'sam' });
    expect(human.transport).toBe('none');
    expect(human.displayName).toBe('sam');
  });

  it('projects a full room roster and supports agent moderation', () => {
    let session = projectRoomSession({
      id: 'room-1',
      participants: [
        { id: 'u1', type: 'user', displayName: 'Sam' },
        { id: 'a1', type: 'virtual_agent', displayName: 'Ada' },
        { id: 's1', type: 'asset_agent', displayName: 'Tank' },
      ],
    });
    expect(session.participants).toHaveLength(3);
    expect(agentParticipantCount(session)).toBe(2);

    session = applyModeration(session, { action: 'disable-listening', participantId: 'a1', disabled: true });
    expect(session.participants.find((p) => p.id === 'a1')?.listening).toBe(false);
    // Humans cannot have listening disabled.
    const before = session;
    session = applyModeration(session, { action: 'disable-listening', participantId: 'u1', disabled: true });
    expect(session.participants.find((p) => p.id === 'u1')?.listening).toBe(true);
    expect(session).toBe(before);
  });
});
