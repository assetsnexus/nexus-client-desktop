import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { MeetingView } from '@nexus/meetings-react';
import {
  applyModeration,
  detectImmersiveVrSupport,
  hasLiveVideo,
  primaryMeetingAgent,
  startCameraCapture,
  startScreenCapture,
  stopMediaStream,
  type ImmersiveVrSupport,
  type MeetingCardModel,
  type MeetingVoiceMode,
  type MediaStreamLike,
  type RoomMediaSession,
  type XrSystemLike,
} from '@nexus/meetings-core';
import {
  createNexusChat,
  createRegionCommandClient,
  startMicCapture,
  type NexusChat,
} from '@nexus/chat-react';
import type { SceneRoom } from '@nexus/character-kit';
import { bridge, type AuthState, type DesktopConnectionConfig } from '../bridge.js';
import { projectRoomSession } from '../meetings/room-session.js';
import { attachCameraStream, detachCameraStream } from '../meetings/camera.js';
import { createMeetingVoiceHost, voiceSurfaceView } from '../meetings/meeting-voice.js';
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

const EMPTY_CAPS: MeetingVoiceAvailability = {
  realtimeAvailable: false,
  cloudSttAvailable: false,
  cloudTtsAvailable: false,
  localSttAvailable: false,
  localTtsAvailable: false,
};

/** Narrow the ambient `navigator.xr` to the probe contract (WebXR is optional). */
function browserXr(): XrSystemLike | null {
  const nav = navigator as Navigator & { xr?: XrSystemLike };
  return nav.xr ?? null;
}

type ChatIdentity = Parameters<typeof createRegionCommandClient>[0]['identity'];

/**
 * Meeting / room media view (Phase 7c/7d/11e).
 *
 * A nexus meeting is a linked conversation room, so this loads the room roster
 * from the region, projects it into the shared `RoomMediaSession`, and renders
 * the shared `MeetingView` — the same component the portal and external apps
 * use. The Scene tab shows the room's bound 3D scene, the agent embodiment rail,
 * and a working voice bar: realtime WebRTC (`gpt-realtime`) with a classic
 * STT → agent → TTS fallback, driven by the same chat-core rails as a 1:1 DM.
 */
export function MeetingRoomPanel({
  roomId,
  auth,
  connection,
  onClose,
}: {
  roomId: string;
  auth: Extract<AuthState, { status: 'signed_in' }>;
  connection: DesktopConnectionConfig | null;
  onClose?: () => void;
}) {
  const [room, setRoom] = useState<MeetingRoomRow | null>(null);
  const [session, setSession] = useState<RoomMediaSession | null>(null);
  // Phase 7d: mirror the session in a ref so moderation handlers can read the
  // current roster synchronously when building the command payload.
  const sessionRef = useRef<RoomMediaSession | null>(null);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  const [title, setTitle] = useState('Meeting');
  const [error, setError] = useState<string | null>(null);
  const [vr, setVr] = useState<ImmersiveVrSupport | null>(null);
  const [vrActive, setVrActive] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [voiceCaps, setVoiceCaps] = useState<MeetingVoiceAvailability | null>(null);
  const [voiceMode, setVoiceMode] = useState<MeetingVoiceMode | null>(null);
  const [voiceView, setVoiceView] = useState<ReturnType<typeof voiceSurfaceView> | null>(null);
  const [preferLocal, setPreferLocal] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const voiceHostRef = useRef<ReturnType<typeof createMeetingVoiceHost> | null>(null);
  const chatRef = useRef<NexusChat | null>(null);
  const sceneRoomRef = useRef<SceneRoom | null>(null);
  const lipSyncStopRef = useRef<(() => void) | null>(null);
  const cameraStreamRef = useRef<MediaStreamLike | null>(null);
  const screenStreamRef = useRef<MediaStreamLike | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    void detectImmersiveVrSupport(browserXr()).then(setVr);
  }, []);

  // The chat facade + region command client power the voice pipeline (the same
  // rails as the DM). Built once per connection/identity.
  const apiBaseUrl = connection?.regionUrl ?? '';
  const identity = useMemo<ChatIdentity>(
    () => ({
      token: auth.token,
      userId: auth.identity.userId ?? null,
      orgId: auth.identity.orgId ?? null,
      role: auth.identity.role ?? null,
      deviceId: auth.identity.deviceId ?? null,
    }),
    [auth],
  );

  useEffect(() => {
    if (!apiBaseUrl) return;
    let cancelled = false;
    try {
      const client = createRegionCommandClient({ apiBaseUrl, identity });
      const chat = createNexusChat({
        client,
        features: { adminPanels: false },
        publicFilesBaseUrl: apiBaseUrl,
      });
      if (!cancelled) chatRef.current = chat;
    } catch {
      chatRef.current = null;
    }
    return () => {
      cancelled = true;
      chatRef.current = null;
    };
  }, [apiBaseUrl, identity]);

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

  const caps = voiceCaps ?? EMPTY_CAPS;
  const capabilities = useMemo(
    () => ({
      realtimeAvailable: caps.realtimeAvailable,
      cloudSttAvailable: caps.cloudSttAvailable,
      cloudTtsAvailable: caps.cloudTtsAvailable,
      localSttAvailable: caps.localSttAvailable,
      localTtsAvailable: caps.localTtsAvailable,
    }),
    [caps],
  );

  const agent = session ? primaryMeetingAgent(session) : null;

  // Phase 7d: enforce the primary agent's inbound moderation locally. When a
  // moderator disables the agent's listening (or mutes it), the meeting silences
  // the agent's inbound audio without ending the call; re-enabling restores it.
  const primaryAgentMuted = agent ? agent.muted === true || agent.listening === false : false;
  useEffect(() => {
    const chat = chatRef.current;
    if (!chat) return;
    try {
      chat.setRemoteMuted?.(primaryAgentMuted);
    } catch {
      /* older chat facade without remote mute — non-fatal */
    }
  }, [primaryAgentMuted]);

  const startVoice = useCallback(async () => {
    const chat = chatRef.current;
    const currentSession = session;
    if (!chat || !currentSession || !agent) {
      setNotice('Join an agent conversation before starting voice.');
      return;
    }
    setNotice(null);
    // Rebuild the host against the current engines + capabilities.
    await voiceHostRef.current?.dispose();
    const client = createRegionCommandClient({ apiBaseUrl, identity });
    const host = createMeetingVoiceHost({
      chat,
      client,
      capabilities,
      // Cloud engines are named by capability; a local engine is only wired when
      // the user asked to prefer on-device audio and one is installed.
      localStt: preferLocal
        ? { kind: 'stt', location: 'local', id: 'local-stt', label: 'On-device STT', protocol: 'whisper_rest', baseUrl: null }
        : null,
      localTts: preferLocal
        ? { kind: 'tts', location: 'local', id: 'local-tts', label: 'On-device TTS', protocol: 'openai_audio', baseUrl: null }
        : null,
      startMicCapture,
      logger: console,
    });
    voiceHostRef.current = host;
    const sub = host.session.subscribe((surface) => setVoiceView(voiceSurfaceView(surface)));
    (host as unknown as { _unsub?: () => void })._unsub = sub;

    // Drive the scene avatar's lip-sync from the agent's speech: the same
    // `subscribeRemotePlaybackStream` rail the DM voice mode uses, so the
    // speaking agent's VRM mouth moves in the meeting Scene tab too.
    if (typeof chat.subscribeRemotePlaybackStream === 'function') {
      lipSyncStopRef.current?.();
      lipSyncStopRef.current = chat.subscribeRemotePlaybackStream((stream, meta) => {
        const sceneRoom = sceneRoomRef.current;
        const target = agent?.id;
        if (!sceneRoom || !target) return;
        if (stream) void sceneRoom.speakWithLipSync(target, stream, meta.audioContext ?? undefined);
        else sceneRoom.stopLipSync(target);
      });
      const existing = chat.getRemotePlaybackStream?.();
      if (existing) void sceneRoomRef.current?.speakWithLipSync(agent.id, existing);
    }
    const next = await host.session.start({
      agentId: agent.id,
      conversationId: currentSession.conversationId,
      roomId: roomId,
      mode: voiceMode,
      preferLocal,
    });
    setVoiceView(voiceSurfaceView(next));
  }, [agent, apiBaseUrl, capabilities, identity, preferLocal, roomId, session, voiceMode]);

  const endVoice = useCallback(async () => {
    const host = voiceHostRef.current;
    (host as unknown as { _unsub?: () => void } | null)?._unsub?.();
    lipSyncStopRef.current?.();
    lipSyncStopRef.current = null;
    sceneRoomRef.current?.stopLipSync();
    await host?.dispose();
    voiceHostRef.current = null;
    setVoiceView(null);
  }, []);

  const toggleMute = useCallback(() => {
    const host = voiceHostRef.current;
    if (!host) return;
    const muted = host.session.toggleMute();
    setVoiceView((prev) => (prev ? { ...prev, muted } : prev));
  }, []);

  useEffect(() => {
    // Stop the call when the panel unmounts so the mic/PC never outlive it.
    return () => {
      lipSyncStopRef.current?.();
      lipSyncStopRef.current = null;
      void voiceHostRef.current?.dispose();
      voiceHostRef.current = null;
    };
  }, []);

  const onModerate = useCallback(
    (participantId: string, action: 'mute' | 'disable-listening' | 'set-volume', value: boolean | number) => {
      // rebuild the next session synchronously so we can derive the exact
      // moderation payload without reading state from a stale closure.
      const current = sessionRef.current;
      if (!current) return;
      let nextSession: RoomMediaSession;
      if (action === 'mute') {
        nextSession = applyModeration(current, { action: 'mute', participantId, muted: Boolean(value) });
      } else if (action === 'disable-listening') {
        // The view passes the *current* listening flag; disable == !listening.
        nextSession = applyModeration(current, {
          action: 'disable-listening',
          participantId,
          disabled: Boolean(value),
        });
      } else {
        nextSession = applyModeration(current, {
          action: 'set-volume',
          participantId,
          volume: Number(value),
        });
      }
      setSession(nextSession);

      // `set-volume` is a purely local playback concern and never round-trips.
      if (action === 'set-volume') return;
      const target = nextSession.participants.find((p) => p.id === participantId);
      if (!target) return;

      const client = createRegionCommandClient({ apiBaseUrl, identity });
      void client
        .send('anx.communicate.rooms.participants.moderate', {
          roomId,
          participantType: target.kind,
          participantId,
          muted: target.muted,
          // Only meaningful for agent seats; the server rejects it for humans.
          listening: target.kind === 'user' ? undefined : target.listening,
          videoEnabled: target.transport === 'video' || target.transport === 'video_screenshare',
        })
        .then((res) => {
          const r = res as { ok?: boolean; message?: string } | null;
          if (!r || r.ok !== true) {
            setNotice(r?.message ?? 'Moderation was refused.');
            setSession(current);
          }
        })
        .catch((err: unknown) => {
          setNotice(err instanceof Error ? err.message : 'Moderation failed.');
          // Revert optimistic state and re-hydrate from the server so the UI
          // never drifts from the persisted room seat.
          setSession(current);
          void load();
        });
    },
    [apiBaseUrl, identity, roomId, load],
  );

  // Phase 12a: enter/exit the immersive VR preview on the Scene tab's live
  // `SceneRoom`. `SceneRoom.enterPhoneVr` prefers WebXR `immersive-vr` and falls
  // back to IMU stereo, so this is the same rail the portal uses. The scene room
  // is only present once the ClusterRoomViewer has mounted.
  const toggleVr = useCallback(async () => {
    const sceneRoom = sceneRoomRef.current;
    if (!sceneRoom) {
      setNotice('Open the Scene tab and wait for the 3D room to load before entering VR.');
      return;
    }
    try {
      if (vrActive) {
        const status = await sceneRoom.exitPhoneVr();
        setVrActive(status.active);
        setNotice(status.errorMessage);
      } else {
        const status = await sceneRoom.enterPhoneVr();
        setVrActive(status.active);
        setNotice(status.active ? null : status.message);
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not start the VR session.');
    }
  }, [vrActive]);

  // Phase 7c: publish the local webcam. Capture is a browser capability; the
  // resulting stream is attached to the local preview <video> and handed to the
  // room transport. Toggling off stops every track so the camera light clears.
  const toggleCamera = useCallback(async () => {
    if (cameraStreamRef.current) {
      stopMediaStream(cameraStreamRef.current);
      cameraStreamRef.current = null;
      detachCameraStream(localVideoRef.current);
      setCameraOn(false);
      return;
    }
    const res = await startCameraCapture({ withAudio: true });
    if (!res.ok) {
      setNotice(res.message);
      return;
    }
    cameraStreamRef.current = res.stream;
    setCameraOn(hasLiveVideo(res.stream));
    setNotice(null);
    if (localVideoRef.current) attachCameraStream(res.stream, localVideoRef.current);
  }, []);

  // Phase 7c: publish a screen/window. Electron answers getDisplayMedia via the
  // main-process display-media handler.
  const toggleShare = useCallback(async () => {
    if (screenStreamRef.current) {
      stopMediaStream(screenStreamRef.current);
      screenStreamRef.current = null;
      setSharing(false);
      if (localVideoRef.current && !cameraStreamRef.current) detachCameraStream(localVideoRef.current);
      if (localVideoRef.current && cameraStreamRef.current) {
        attachCameraStream(cameraStreamRef.current, localVideoRef.current);
      }
      return;
    }
    const res = await startScreenCapture({ withAudio: true });
    if (!res.ok) {
      setNotice(res.message);
      return;
    }
    screenStreamRef.current = res.stream;
    setSharing(true);
    setNotice(null);
    // Screenshare takes over the preview so the user sees what they publish.
    if (localVideoRef.current) attachCameraStream(res.stream, localVideoRef.current);
  }, []);

  // Stop capture on unmount so the camera / screen never outlive the panel.
  useEffect(() => {
    return () => {
      stopMediaStream(cameraStreamRef.current);
      stopMediaStream(screenStreamRef.current);
      cameraStreamRef.current = null;
      screenStreamRef.current = null;
    };
  }, []);

  const sceneSlot = room ? (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <MeetingScenePanel
        room={room}
        voiceCapabilities={caps}
        voiceMode={voiceMode}
        onRoomReady={(room3d) => {
          sceneRoomRef.current = room3d;
        }}
        voice={{
          active: voiceView?.active ?? false,
          muted: voiceView?.muted ?? false,
          statusText: voiceView?.status,
          fellBack: voiceView?.fellBack ?? false,
          preferLocal,
          onSelectMode: (mode) => setVoiceMode(mode),
          onTogglePreferLocal: setPreferLocal,
          onStart: () => void startVoice(),
          onEnd: () => void endVoice(),
          onToggleMute: toggleMute,
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          style={btn}
          disabled={vr?.status !== 'supported' && !vrActive}
          title={vr && vr.status !== 'supported' ? vr.detail : 'Open in an attached VR headset'}
          onClick={() => void toggleVr()}
        >
          {vrActive ? 'Exit VR headset' : 'Preview in VR headset'}
        </button>
        {vr ? <span style={{ fontSize: 11, color: '#6b7784' }}>{vr.status}</span> : null}
        {voiceView?.errorMessage ? (
          <span style={{ fontSize: 11, color: '#f2a1a1' }}>{voiceView.errorMessage}</span>
        ) : null}
      </div>
    </div>
  ) : (
    <p style={{ color: '#9aa7b5', fontSize: 13, margin: 0 }}>Loading the room scene…</p>
  );

  const videoSlot = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" style={btn} onClick={() => void toggleCamera()}>
          {cameraOn ? 'Stop camera' : 'Start camera'}
        </button>
        <button type="button" style={btn} onClick={() => void toggleShare()}>
          {sharing ? 'Stop sharing' : 'Share screen'}
        </button>
      </div>
      <div
        style={{
          position: 'relative',
          aspectRatio: '16 / 9',
          background: '#000',
          borderRadius: 10,
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <video
          ref={localVideoRef}
          autoPlay
          playsInline
          muted
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            display: cameraOn || sharing ? 'block' : 'none',
          }}
        />
        {!cameraOn && !sharing ? (
          <p style={{ color: '#9aa7b5', fontSize: 13, margin: 0 }}>
            Your camera and screen are off.
          </p>
        ) : null}
        {sharing ? (
          <span
            style={{
              position: 'absolute',
              top: 8,
              left: 8,
              fontSize: 11,
              padding: '2px 6px',
              borderRadius: 6,
              background: '#1c2430',
              color: '#7fb2ff',
            }}
          >
            Sharing screen
          </span>
        ) : null}
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {session?.participants.map((p) => (
          <li
            key={p.id}
            style={{
              fontSize: 11,
              padding: '3px 8px',
              borderRadius: 999,
              background: '#1c2430',
              color: p.transport === 'none' ? '#6b7784' : '#e8eef4',
            }}
          >
            {p.displayName}
            {p.transport === 'audio' ? ' · audio' : ''}
            {p.transport === 'video' || p.transport === 'video_screenshare' ? ' · video' : ''}
          </li>
        ))}
      </ul>
    </div>
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
        {voiceView?.mode ? (
          <span style={{ fontSize: 11, color: '#7fb2ff' }}>
            {voiceView.mode === 'realtime' ? 'realtime' : 'STT/TTS'}
          </span>
        ) : null}
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
      {notice ? <p style={{ padding: '8px 14px', color: '#fbbf24', fontSize: 12 }}>{notice}</p> : null}
      <div style={{ flex: 1, minHeight: 0 }}>
        {card && session ? (
          <MeetingView
            card={card}
            session={session}
            videoSlot={videoSlot}
            sceneSlot={sceneSlot}
            onModerate={onModerate}
          />
        ) : (
          <p style={{ padding: 24, color: '#9aa7b5' }}>Loading room…</p>
        )}
      </div>
    </div>
  );
}
