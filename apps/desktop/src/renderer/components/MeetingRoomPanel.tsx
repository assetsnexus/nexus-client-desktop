import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { MeetingView } from '@nexus/meetings-react';
import {
  applyModeration,
  detectImmersiveVrSupport,
  primaryMeetingAgent,
  type ImmersiveVrSupport,
  type MeetingCardModel,
  type MeetingVoiceMode,
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
  const [title, setTitle] = useState('Meeting');
  const [error, setError] = useState<string | null>(null);
  const [vr, setVr] = useState<ImmersiveVrSupport | null>(null);
  const [voiceCaps, setVoiceCaps] = useState<MeetingVoiceAvailability | null>(null);
  const [voiceMode, setVoiceMode] = useState<MeetingVoiceMode | null>(null);
  const [voiceView, setVoiceView] = useState<ReturnType<typeof voiceSurfaceView> | null>(null);
  const [preferLocal, setPreferLocal] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const voiceHostRef = useRef<ReturnType<typeof createMeetingVoiceHost> | null>(null);
  const chatRef = useRef<NexusChat | null>(null);
  const sceneRoomRef = useRef<SceneRoom | null>(null);
  const lipSyncStopRef = useRef<(() => void) | null>(null);

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
          disabled={vr?.status !== 'supported'}
          title={vr && vr.status !== 'supported' ? vr.detail : 'Open in an attached VR headset'}
        >
          Preview in VR headset
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
          <MeetingView card={card} session={session} sceneSlot={sceneSlot} onModerate={onModerate} />
        ) : (
          <p style={{ padding: 24, color: '#9aa7b5' }}>Loading room…</p>
        )}
      </div>
    </div>
  );
}
