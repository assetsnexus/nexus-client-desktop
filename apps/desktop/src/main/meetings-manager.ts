/**
 * Desktop meetings manager (Phase 7c/7d/11, main process).
 *
 * A nexus meeting is a normal linked conversation room; this bridges the room
 * roster from `anx.communicate.rooms.get` into a serializable row the renderer
 * projects into a `RoomMediaSession` (see renderer/meetings/room-session.ts).
 * Region-node owns the room + media state; this module only reads/projects.
 */

import type { MeetingRoomRow, MeetingRoomParticipantRow } from '../shared/ipc.js';

export type MeetingsManagerOptions = {
  getSender: () => Promise<{
    send: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
  }>;
};

export type MeetingsManager = ReturnType<typeof createMeetingsManager>;

function unwrap(result: unknown): Record<string, unknown> {
  const r = result as { data?: Record<string, unknown> } & Record<string, unknown>;
  if (r && typeof r === 'object' && 'data' in r && r.data && typeof r.data === 'object') {
    return r.data as Record<string, unknown>;
  }
  return (r ?? {}) as Record<string, unknown>;
}

function projectParticipant(raw: unknown): MeetingRoomParticipantRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const id = typeof p.id === 'string' ? p.id : null;
  if (!id) return null;
  return {
    id,
    type: typeof p.type === 'string' ? p.type : 'user',
    displayName:
      typeof p.displayName === 'string'
        ? p.displayName
        : typeof p.username === 'string'
          ? p.username
          : null,
    avatarUrl: typeof p.avatarUrl === 'string' ? p.avatarUrl : null,
  };
}

export function createMeetingsManager(options: MeetingsManagerOptions) {
  return {
    /** Load a room's roster + bound scene for the media view. */
    async getRoom(roomId: string): Promise<MeetingRoomRow | null> {
      const sender = await options.getSender();
      const result = await sender.send('anx.communicate.rooms.get', { roomId });
      const data = unwrap(result);
      if (!data || typeof data !== 'object' || typeof data.id !== 'string') return null;
      const participantsRaw = Array.isArray(data.participants) ? data.participants : [];
      const participants = participantsRaw
        .map(projectParticipant)
        .filter((p): p is MeetingRoomParticipantRow => p !== null);
      const orchestration =
        data.orchestration && typeof data.orchestration === 'object'
          ? (data.orchestration as Record<string, unknown>)
          : null;
      const sceneId =
        typeof data.sceneId === 'string'
          ? data.sceneId
          : typeof orchestration?.sceneId === 'string'
            ? (orchestration.sceneId as string)
            : null;
      return {
        id: data.id,
        title: typeof data.title === 'string' ? data.title : 'Room',
        type: typeof data.type === 'string' ? data.type : 'group',
        // The room's backing conversation shares its id in the region model.
        conversationId: typeof data.conversationId === 'string' ? data.conversationId : (data.id as string),
        sceneId,
        participants,
      };
    },
  };
}
