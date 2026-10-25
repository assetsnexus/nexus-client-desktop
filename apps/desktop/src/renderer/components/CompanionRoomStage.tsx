/**
 * Shared multi-agent room stage for the immersive companion window.
 *
 * A group/meeting room holds several agents. A companion popped out of such a
 * room must show them **together in one scene**, exactly like the main window's
 * Scene tab (`MeetingScenePanel`) and the portal's cluster view — not a single
 * flattened avatar that hides the rest of the room. This renders the same shared
 * `ClusterRoomViewer` against the same room roster + per-agent presence, so
 * there is no companion-only scene path.
 *
 * The stage owns no voice: {@link CompanionView} keeps its realtime call and
 * drives per-agent lip-sync through the `SceneRoom` this exposes via
 * `onRoomReady`, addressed by the occupant id of the agent being spoken to.
 *
 * TRUST: read-only rendering. No commands, no token, no 2FA surface.
 */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { createSceneClient, type SceneClient } from '@nexus/scene-client';
import { ClusterRoomViewer } from '@nexus/cluster-scene-react';
import type { SceneRoom } from '@nexus/character-kit';
import type { MeetingPresenceMap } from '@nexus/meetings-core';
import { bridge, type MeetingRoomRow } from '../bridge.js';
import { projectRoomSession } from '../meetings/room-session.js';
import { resolveFocusOccupantId, sceneRoomOccupants } from '../meetings/scene-occupants.js';
import { resolveCompanionLabelOrNull } from '../../shared/companion-label.js';

/** Presence projection: room presence rows → the meetings-core presence map. */
function presenceMap(row: MeetingRoomRow): MeetingPresenceMap {
  const out: MeetingPresenceMap = {};
  for (const [id, p] of Object.entries(row.presence ?? {})) {
    out[id] = {
      vrmUrl: p.vrmUrl,
      gestureManifestUrl: p.gestureManifestUrl,
      defaultMood: p.defaultMood,
      voiceId: p.voiceId,
      vrmValidationStatus: p.vrmValidationStatus,
      embodiment: p.embodiment,
      lipSyncEnabled: p.lipSyncEnabled,
    };
  }
  return out;
}

const fill: CSSProperties = {
  position: 'relative',
  width: '100%',
  height: '100%',
  minHeight: 0,
};

const hint: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
  margin: 0,
  padding: 16,
  color: '#9aa7b5',
  fontSize: 13,
  textAlign: 'center',
};

export type CompanionRoomStageProps = {
  roomId: string;
  /**
   * The agent whose companion this is, as **every** id the companion knows it by
   * (contact id, agent id, VE id). The whole room is rendered; this only picks
   * which occupant the host binds lip-sync / character tools to.
   *
   * Room occupants are keyed by the participant id the region returns, which may
   * be an agent id or a VE id — so matching one single id would silently bind the
   * wrong avatar. The first alias that matches a seat wins; when none matches
   * (e.g. an occupant the companion has no id for) the first agent seat is used.
   */
  focusIds?: Array<string | null | undefined>;
  /**
   * Receives the live `SceneRoom` **and** the occupant id resolved for this
   * companion's agent, so the host can drive per-agent lip-sync and bind the
   * character tool pack to just this agent inside the shared scene.
   */
  onRoomReady?: (room: SceneRoom | null, focusOccupantId: string | null) => void;
  /**
   * Receives the room's own human name once the roster loads.
   *
   * A room companion is titled after the room, but the launch only carries the
   * name when the caller already knew it (and the name may be absent on a cold
   * open). This is how the window learns it afterwards so the caption can be
   * corrected without a reload. Never called with an id-shaped value: the shared
   * label rule rejects those at the consumer.
   */
  onRoomTitle?: (title: string | null) => void;
};

export function CompanionRoomStage({
  roomId,
  focusIds,
  onRoomReady,
  onRoomTitle,
}: CompanionRoomStageProps) {
  const [room, setRoom] = useState<MeetingRoomRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void bridge
      .meetingsGetRoom(roomId)
      .then((loaded) => {
        if (cancelled) return;
        if (!loaded) {
          setError('This room is not available.');
          return;
        }
        setRoom(loaded as MeetingRoomRow);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'could not load the room');
      });
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  // Report the room's own name once the roster resolves, so a room companion
  // opened before the name was known can title its window with the room.
  useEffect(() => {
    if (!room) return;
    onRoomTitle?.(resolveCompanionLabelOrNull(room.title));
  }, [room, onRoomTitle]);

  const session = useMemo(() => (room ? projectRoomSession(room) : null), [room]);
  const occupancy = useMemo(
    () => (room && session ? sceneRoomOccupants(session, presenceMap(room)) : []),
    [room, session],
  );

  // One scene client per room; the desktop ships the local-fallback client until
  // a live scene socket is bundled (mirrors `MeetingScenePanel`).
  const createClient = useMemo(
    () => (): SceneClient => createSceneClient({ roomId, prediction: true }),
    [roomId],
  );

  // Which occupant belongs to this companion's agent (see resolver doc).
  const focusOccupantId = useMemo(
    () => resolveFocusOccupantId(occupancy, focusIds),
    [occupancy, focusIds],
  );

  if (error) return <p style={hint}>{error}</p>;
  if (!room || !session) return <p style={hint}>Loading the room scene…</p>;
  if (occupancy.length === 0) {
    return <p style={hint}>No agents are in this room scene yet.</p>;
  }

  return (
    <div style={fill} data-nexus-surface="companion-room-stage">
      <ClusterRoomViewer
        roomId={roomId}
        createSceneClient={createClient}
        occupants={occupancy}
        phoneVrEnabled
        onRoomReady={(next) => onRoomReady?.(next, focusOccupantId)}
      />
    </div>
  );
}

/** Exposed for tests: the presence projection is pure. */
export const __test = { presenceMap };
