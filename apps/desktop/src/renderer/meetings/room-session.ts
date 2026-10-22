/**
 * Project a chat room into a `RoomMediaSession` (Phase 7c/7d/11).
 *
 * A nexus meeting is a normal linked conversation room, so the room roster is
 * the media roster: `anx.communicate.rooms.get` → `MeetingParticipant[]`. This
 * keeps desktop rendering on the same rails as DMs with agents and the portal's
 * cluster scene. Pure + headless so it is unit-testable without Electron.
 */

import {
  createEmptyRoomSession,
  upsertParticipant,
  type MediaTransport,
  type MeetingParticipant,
  type ParticipantKind,
  type RoomMediaSession,
} from '@nexus/meetings-core';

/** Minimal room shape we consume (matches `@nexus/chat-core` `ChatRoomDetail`). */
export type RoomParticipantLike = {
  type?: string;
  id: string;
  displayName?: string | null;
  username?: string | null;
  avatarUrl?: string | null;
  /** Phase 7d — media moderation state persisted on the room seat. */
  muted?: boolean | null;
  listening?: boolean | null;
  videoEnabled?: boolean | null;
};

export type RoomDetailLike = {
  id: string;
  conversationId?: string | null;
  participants?: RoomParticipantLike[];
  /** Optional 3D scene (assets cluster) bound to the room. */
  sceneId?: string | null;
  /**
   * Phase 11e: per-participant embodiment presence (agents), keyed by id. Fed to
   * the Scene tab's occupant projection so agents render their VRM/gesture rail.
   */
  presence?: Record<string, unknown> | null;
};

function toKind(type: string | undefined): ParticipantKind {
  switch (type) {
    case 'agent':
      return 'agent';
    case 'virtual_agent':
      return 'virtual_agent';
    case 'asset_agent':
      return 'asset_agent';
    default:
      return 'user';
  }
}

function isAgentKind(kind: ParticipantKind): boolean {
  return kind !== 'user';
}

/** Agents arrive over audio today; humans default to no transport until a call leg exists. */
function defaultTransport(kind: ParticipantKind): MediaTransport {
  return isAgentKind(kind) ? 'audio' : 'none';
}

export function projectRoomParticipant(p: RoomParticipantLike): MeetingParticipant {
  const kind = toKind(p.type);
  return {
    id: p.id,
    kind,
    displayName: p.displayName ?? p.username ?? p.id,
    avatarUrl: p.avatarUrl ?? null,
    transport: defaultTransport(kind),
    // Phase 7d: the server seat is the source of truth; fall back to the live
    // default (unmuted, listening) when the room predates the moderation fields.
    muted: p.muted === true,
    listening: p.listening !== false,
    volume: 1,
    isAssetStream: kind === 'asset_agent',
  };
}

/** Build a `RoomMediaSession` from a room detail. */
export function projectRoomSession(room: RoomDetailLike): RoomMediaSession {
  let session = createEmptyRoomSession(room.id, room.conversationId ?? null);
  session = { ...session, sceneId: room.sceneId ?? null };
  for (const p of room.participants ?? []) {
    if (!p?.id) continue;
    session = upsertParticipant(session, projectRoomParticipant(p));
  }
  return session;
}
