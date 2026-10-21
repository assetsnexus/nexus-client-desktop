import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { MeetingView } from '@nexus/meetings-react';
import {
  applyModeration,
  detectImmersiveVrSupport,
  type ImmersiveVrSupport,
  type MeetingCardModel,
  type RoomMediaSession,
  type XrSystemLike,
} from '@nexus/meetings-core';
import { bridge } from '../bridge.js';
import { projectRoomSession } from '../meetings/room-session.js';
import { MeetingScenePanel } from './MeetingScenePanel.js';
import type { MeetingRoomRow, MeetingVoiceAvailability } from '../../shared/ipc.js';

const wrap: CSSProperties = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  background: '#0f1419',
};

const head: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 14px',
  borderBottom: '1px solid #2a333d',
  background: '#12171c',
  flexShrink: 0,
};

const btn: CSSProperties = {
  padding: '5px 10px',
  borderRadius: 8,
  border: '1px solid #3a4654',
  background: '#1c2430',
  color: '#e8eef4',
  cursor: 'pointer',
  fontSize: 12,
};

/** Narrow the ambient `navigator.xr` to the probe contract (WebXR is optional). */
function browserXr(): XrSystemLike | null {
  const nav = navigator as Navigator & { xr?: XrSystemLike };
  return nav.xr ?? null;
}

/**
 * Meeting / room media view (Phase 7c/7d/11).
 *
 * A nexus meeting is a linked conversation room, so this loads the room roster
 * from the region, projects it into the shared `RoomMediaSession`, and renders
 * the shared `MeetingView` — the same component the portal and external apps
 * use. The Scene tab shows the room's bound 3D scene and offers a VR-headset
 * preview (Phase 12) when the local WebXR runtime can start an immersive
 * session.
 */
export function MeetingRoomPanel({
  roomId,
  onClose,
}: {
  roomId: string;
  onClose?: () => void;
}) {
  const [room, setRoom] = useState<MeetingRoomRow | null>(null);
  const [session, setSession] = useState<RoomMediaSession | null>(null);
  const [title, setTitle] = useState('Meeting');
  const [error, setError] = useState<string | null>(null);
  const [vr, setVr] = useState<ImmersiveVrSupport | null>(null);
  const [voiceCaps, setVoiceCaps] = useState<MeetingVoiceAvailability | null>(null);

  useEffect(() => {
    void detectImmersiveVrSupport(browserXr()).then(setVr);
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const loaded = await bridge.meetingsGetRoom(roomId);
      if (!loaded) {
        setError('This room is not available.');
        return;
      }
      setRoom(loaded);
      setTitle(loaded.title);
      setSession(projectRoomSession(loaded));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not load the room');
    }
  }, [roomId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void bridge
      .meetingsVoiceCapabilities()
      .then(setVoiceCaps)
      .catch(() => setVoiceCaps(null));
  }, []);

  const onModerate = useCallback(
    (participantId: string, action: 'mute' | 'disable-listening' | 'set-volume', value: boolean | number) => {
      setSession((prev) => {
        if (!prev) return prev;
        if (action === 'mute') {
          return applyModeration(prev, { action: 'mute', participantId, muted: Boolean(value) });
        }
        if (action === 'disable-listening') {
          // The view passes the *current* listening flag; disable == !listening.
          return applyModeration(prev, {
            action: 'disable-listening',
            participantId,
            disabled: Boolean(value),
          });
        }
        return applyModeration(prev, { action: 'set-volume', participantId, volume: Number(value) });
      });
    },
    [],
  );

  const sceneSlot = room ? (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <MeetingScenePanel
        room={room}
        voiceCapabilities={
          voiceCaps ?? {
            realtimeAvailable: false,
            cloudSttAvailable: false,
            cloudTtsAvailable: false,
            localSttAvailable: false,
            localTtsAvailable: false,
          }
        }
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          style={btn}
          disabled={vr?.status !== 'supported'}
          title={vr && vr.status !== 'supported' ? vr.detail : 'Open in an attached VR headset'}
        >
          Preview in VR headset
        </button>
        {vr ? <span style={{ fontSize: 11, color: '#6b7784' }}>{vr.status}</span> : null}
      </div>
    </div>
  ) : (
    <p style={{ color: '#9aa7b5', fontSize: 13, margin: 0 }}>Loading the room scene…</p>
  );

  const card: MeetingCardModel | null = session
    ? {
        id: roomId,
        title,
        provider: 'nexus',
        providerLabel: 'Nexus room',
        startsAt: '',
        endsAt: '',
        allDay: false,
        cancelled: false,
        clickable: true,
        joinUrl: null,
        roomId,
        location: null,
        description: null,
        myStatus: null,
        surfaces: { video: true, participants: true, scene: true, screenshare: true },
        links: [],
      }
    : null;

  return (
    <div style={wrap}>
      <header style={head}>
        <strong style={{ fontSize: 13 }}>{title}</strong>
        <span style={{ fontSize: 11, color: '#6b7784' }}>{roomId}</span>
        <span style={{ flex: 1 }} />
        <button type="button" style={btn} onClick={() => void load()}>
          Refresh
        </button>
        {onClose ? (
          <button type="button" style={btn} onClick={onClose}>
            Close
          </button>
        ) : null}
      </header>
      {error ? <p style={{ padding: '8px 14px', color: '#f2a1a1', fontSize: 12 }}>{error}</p> : null}
      <div style={{ flex: 1, minHeight: 0 }}>
        {card && session ? (
          <MeetingView card={card} session={session} sceneSlot={sceneSlot} onModerate={onModerate} />
        ) : (
          <p style={{ padding: 24, color: '#9aa7b5' }}>Loading room…</p>
        )}
      </div>
    </div>
  );
}
