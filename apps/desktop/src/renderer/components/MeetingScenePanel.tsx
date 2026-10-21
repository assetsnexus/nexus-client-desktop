/**
 * Desktop meeting Scene tab (Phase 11e).
 *
 * Renders the room's bound 3D scene with the agent embodiment rail (VRM +
 * gestures) plus the shared `MeetingSceneTab` chrome (occupant chips + voice
 * bar). The occupant cohort comes from the room roster + per-agent presence that
 * the main process hydrates from `anx.agents.get`, so a meeting Scene shows the
 * same agents as a DM — no meeting-only avatar path.
 *
 * `ClusterRoomViewer` binds the room id to a `SceneClient`; the desktop ships
 * the local-fallback scene client (multi-user live sync needs a scene socket the
 * desktop does not yet bundle), and the occupants render regardless.
 */

import { useMemo, type CSSProperties } from 'react';
import { MeetingSceneTab, type MeetingVoiceBarProps } from '@nexus/meetings-react';
import type { MeetingPresenceMap } from '@nexus/meetings-core';
import { createSceneClient, type SceneClient } from '@nexus/scene-client';
import { ClusterRoomViewer } from '@nexus/cluster-scene-react';
import type { SceneRoom } from '@nexus/character-kit';
import type { MeetingRoomRow } from '../../shared/ipc.js';
import { projectRoomSession } from '../meetings/room-session.js';
import {
  projectSceneOccupants,
  sceneRoomOccupants,
  type VoiceAvailabilityInputs,
} from '../meetings/scene-occupants.js';

const hint: CSSProperties = { margin: 0, color: '#9aa7b5', fontSize: 12 };

/** Presence projection: room presence rows → the meetings-core presence map. */
function presenceMap(room: MeetingRoomRow): MeetingPresenceMap {
  const out: MeetingPresenceMap = {};
  for (const [id, p] of Object.entries(room.presence ?? {})) {
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

export function MeetingScenePanel({
  room,
  voiceCapabilities,
  voiceMode,
  voice,
  onRoomReady,
}: {
  room: MeetingRoomRow;
  voiceCapabilities: VoiceAvailabilityInputs;
  voiceMode?: MeetingVoiceBarProps['mode'];
  voice?: Partial<MeetingVoiceBarProps>;
  /** Receives the live scene room so the host can drive avatar lip-sync. */
  onRoomReady?: (room: SceneRoom | null) => void;
}) {
  const session = useMemo(() => projectRoomSession(room), [room]);
  const presence = useMemo(() => presenceMap(room), [room]);
  // `MeetingSceneTab` chips need the meetings-core occupant shape; the cluster
  // viewer needs the structural `SceneRoomOccupant` shape. Both derive from the
  // same projection so they never disagree.
  const meetingOccupants = useMemo(
    () => projectSceneOccupants(session, presence),
    [session, presence],
  );
  const occupants = useMemo(() => sceneRoomOccupants(session, presence), [session, presence]);

  // One scene client per room, created lazily by the viewer; the desktop uses
  // the local fallback until a scene socket is wired.
  const createClient = useMemo(
    () => (): SceneClient => createSceneClient({ roomId: room.id, prediction: true }),
    [room.id],
  );

  const sceneRenderer = session.sceneId || occupants.length ? (
    <ClusterRoomViewer
      roomId={room.id}
      createSceneClient={createClient}
      occupants={occupants}
      phoneVrEnabled
      onRoomReady={onRoomReady}
    />
  ) : null;

  const capabilities = {
    realtimeAvailable: voiceCapabilities.realtimeAvailable,
    cloudSttAvailable: voiceCapabilities.cloudSttAvailable,
    cloudTtsAvailable: voiceCapabilities.cloudTtsAvailable,
    localSttAvailable: voiceCapabilities.localSttAvailable,
    localTtsAvailable: voiceCapabilities.localTtsAvailable,
  };

  return (
    <MeetingSceneTab
      occupants={meetingOccupants}
      sceneRenderer={
        sceneRenderer ?? (
          <p style={hint}>
            {room.sceneId
              ? 'Loading the room scene…'
              : 'No 3D scene is bound to this room. Agents still appear in the roster below.'}
          </p>
        )
      }
      voice={{
        capabilities,
        mode: voiceMode,
        ...voice,
      }}
      emptyHint="No participants in the scene yet."
    />
  );
}
