/**
 * Scene-tab projection helpers (desktop, Phase 11e).
 *
 * The meeting Scene tab renders the shared cluster scene with the agent
 * embodiment rail. This maps `@nexus/meetings-core` scene occupants into the
 * `SceneRoomOccupant` shape `@nexus/character-react` / `ClusterRoomViewer`
 * expect — no meeting-only avatar path — and derives the voice capabilities the
 * tab's voice bar gates on. Pure + headless so it is unit-testable.
 */

import {
  availableVoiceModes,
  meetingSceneOccupantsFromSession,
  preferredVoiceMode,
  type MeetingPresenceMap,
  type MeetingSceneOccupant,
  type MeetingVoiceCapabilities,
  type MeetingVoiceMode,
  type RoomMediaSession,
} from '@nexus/meetings-core';
import type { SceneRoomOccupant } from '@nexus/cluster-scene-react';

/** Structural match for `SceneRoomOccupant` (the renderer contract). */
export function toSceneRoomOccupant(o: MeetingSceneOccupant): SceneRoomOccupant {
  return {
    id: o.id,
    label: o.label,
    slotIndex: o.slotIndex,
    vrmUrl: o.vrmUrl ?? null,
    validationStatus: o.validationStatus ?? null,
    mood: o.mood,
    statusColor: o.statusColor,
    present: o.present,
  };
}

/** Project a room session + presence map into scene occupants. */
export function projectSceneOccupants(
  session: RoomMediaSession,
  presence: MeetingPresenceMap = {},
  opts: { previewUnverified?: boolean } = {},
): MeetingSceneOccupant[] {
  return meetingSceneOccupantsFromSession(session, presence, opts);
}

export function sceneRoomOccupants(
  session: RoomMediaSession,
  presence: MeetingPresenceMap = {},
  opts: { previewUnverified?: boolean } = {},
): SceneRoomOccupant[] {
  return projectSceneOccupants(session, presence, opts).map(toSceneRoomOccupant);
}

/** Inputs the desktop can actually observe for voice capability gating. */
export type VoiceAvailabilityInputs = {
  /** Region advertises a `realtime_voice` model. */
  realtimeAvailable: boolean;
  /** The user has a cloud STT/TTS model entitled (region inference). */
  cloudSttAvailable: boolean;
  cloudTtsAvailable: boolean;
  /** A local (on-device) STT/TTS model is installed. */
  localSttAvailable: boolean;
  localTtsAvailable: boolean;
};

/**
 * Derive capabilities for the voice bar. Region-only realtime voice is always
 * available in a nexus room; the pipeline needs at least one STT and one TTS.
 */
export function voiceCapabilitiesFrom(inputs: VoiceAvailabilityInputs): MeetingVoiceCapabilities {
  return {
    realtimeAvailable: inputs.realtimeAvailable,
    cloudSttAvailable: inputs.cloudSttAvailable,
    cloudTtsAvailable: inputs.cloudTtsAvailable,
    localSttAvailable: inputs.localSttAvailable,
    localTtsAvailable: inputs.localTtsAvailable,
  };
}

/** Whether realtime can start, else which pipeline to fall back to. */
export function resolveMeetingVoiceMode(
  caps: MeetingVoiceCapabilities,
  preferred?: MeetingVoiceMode | null,
): MeetingVoiceMode | null {
  const modes = availableVoiceModes(caps);
  if (preferred && modes.includes(preferred)) return preferred;
  return preferredVoiceMode(caps);
}
