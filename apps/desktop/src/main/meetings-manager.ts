/**
 * Desktop meetings manager (Phase 7c/7d/11, main process).
 *
 * A nexus meeting is a normal linked conversation room; this bridges the room
 * roster from `anx.communicate.rooms.get` into a serializable row the renderer
 * projects into a `RoomMediaSession` (see renderer/meetings/room-session.ts).
 * Region-node owns the room + media state; this module only reads/projects.
 *
 * Phase 11e: it also projects each agent participant's embodiment presence
 * (`ParticipantPresenceV1` shape) from `anx.agents.get`, so the meeting `Scene`
 * tab renders the same VRM/gesture rail as a DM — no meeting-only avatar path.
 */

import type {
  MeetingRoomParticipantRow,
  MeetingRoomPresenceRow,
  MeetingRoomRow,
} from '../shared/ipc.js';

export type MeetingsManagerOptions = {
  getSender: () => Promise<{
    send: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
  }>;
  /** Overridable for tests: whether to hydrate agent presence (default true). */
  loadPresence?: boolean;
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
    // Phase 7d — carry the persisted moderation state so the renderer hydrates
    // the roster tile (mute / listening) from the seat, not from a local guess.
    muted: typeof p.muted === 'boolean' ? p.muted : undefined,
    listening: typeof p.listening === 'boolean' ? p.listening : undefined,
    videoEnabled: typeof p.videoEnabled === 'boolean' ? p.videoEnabled : undefined,
  };
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Map an `anx.agents.get` agent document into the scene presence contract.
 * Tolerant: a missing embodiment yields an all-null presence (the renderer then
 * shows the status stand-in rather than a broken avatar).
 */
export function agentPresenceFromAgentDoc(doc: unknown): MeetingRoomPresenceRow {
  const agent = asRecord(doc);
  const embodiment = asRecord(agent?.embodiment);
  const profile = asRecord(agent?.presence);
  const vrmUrl =
    asString(embodiment?.vrmUrl) ??
    asString(profile?.vrmUrl) ??
    asString(agent?.avatar3dUrl);
  const gestureManifestUrl =
    asString(profile?.gestureManifestUrl) ?? asString(embodiment?.gestureManifestUrl);
  const defaultMood = asString(embodiment?.defaultMood) ?? asString(profile?.defaultMood);
  const voiceId = asString(profile?.voiceId) ?? asString(agent?.voiceId);
  const lipSyncEnabled =
    typeof embodiment?.lipSyncEnabled === 'boolean'
      ? embodiment.lipSyncEnabled
      : typeof (asRecord(profile?.settings)?.lip_sync_enabled) === 'boolean'
        ? Boolean(asRecord(profile?.settings)?.lip_sync_enabled)
        : true;
  // A never-validated VRM is only safe to auto-load when the caller opts in; the
  // renderer's occupant projection already gates on `vrmValidationStatus`.
  const vrmValidationStatus = asString(profile?.vrmValidationStatus);
  return {
    vrmUrl,
    gestureManifestUrl,
    defaultMood: defaultMood ?? 'neutral',
    voiceId,
    lipSyncEnabled,
    vrmValidationStatus,
    embodiment: embodiment ?? null,
  };
}

const AGENT_KINDS = new Set(['agent', 'virtual_agent']);

export function createMeetingsManager(options: MeetingsManagerOptions) {
  const loadPresence = options.loadPresence !== false;

  /** Hydrate agent participants' presence; humans/assets have none. */
  async function loadRoomPresence(
    participants: MeetingRoomParticipantRow[],
  ): Promise<Record<string, MeetingRoomPresenceRow>> {
    const out: Record<string, MeetingRoomPresenceRow> = {};
    if (!loadPresence) return out;
    const agents = participants.filter((p) => AGENT_KINDS.has(p.type));
    if (!agents.length) return out;
    const sender = await options.getSender();
    await Promise.all(
      agents.map(async (p) => {
        try {
          const result = await sender.send('anx.agents.get', { agentId: p.id });
          const doc = unwrap(result);
          // `anx.agents.get` returns the agent document directly (no `data` wrapper
          // in some deployments), so unwrap tolerantly.
          const agentDoc = doc?.embodiment || doc?.presence || doc?.id ? doc : result;
          out[p.id] = agentPresenceFromAgentDoc(agentDoc);
        } catch {
          // Best-effort: a failed lookup just means a status stand-in.
        }
      }),
    );
    return out;
  }

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
      const orchestration = asRecord(data.orchestration);
      const sceneId =
        asString(data.sceneId) ??
        asString(orchestration?.sceneId) ??
        null;
      const presence = await loadRoomPresence(participants);
      return {
        id: data.id,
        title: typeof data.title === 'string' ? data.title : 'Room',
        type: typeof data.type === 'string' ? data.type : 'group',
        // The room's backing conversation shares its id in the region model.
        conversationId: asString(data.conversationId) ?? (data.id as string),
        sceneId,
        participants,
        presence,
      };
    },
  };
}
