import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  ThreadView,
  VoiceLayout,
  createNexusChat,
  createPresenceStore,
  createRegionCommandClient,
  findChatContact,
  readPresenceFromProfile,
  type ChatContact,
  type ChatTurn,
  type NexusChat,
  type ParticipantPresenceV1,
} from '@nexus/chat-react';
import '@nexus/chat-react/style.css';
// Reuse the character library's cached avatar image (same avatar-asset cache the
// chat surface uses). Imported from `@nexus/character-react` because the
// published `@nexus/chat-react` type entry does not re-export it.
import { CachedAvatarImage } from '@nexus/character-react';
// Motion-feed / gesture-config debug surfaces (re-exported from
// `@nexus/character-ui-kit`). Stylesheet imported once for the panel chrome.
import {
  MotionFeedPanel,
  MotionFeedProvider,
  GestureTestPanel,
  StatusMotionsConfig,
  useMotionFeed,
  useAgentStatusMotions,
  parseStatusMotions,
  serializeStatusMotions,
  type StatusMotionMap,
} from '@nexus/character-react';
import '@nexus/character-ui-kit/style.css';
import { CHARACTER_SKILL } from '@nexus/character-kit';
import {
  registerCharacterTools,
  type CompanionStageHost,
} from '../companion/character-tools.js';
import { companionCursorToGazeNdc } from '../companion/companion-cursor.js';
import {
  bridge,
  type AuthState,
  type CompanionAvatarSettings,
  type CompanionDebugSettings,
  type CompanionLaunch,
  type CompanionPresent,
  type DesktopConnectionConfig,
} from '../bridge.js';
import { CompanionComposer } from './CompanionComposer.js';
import {
  buildAvatarChoices,
  createCompanionAvatarStore,
  latestTranscriptPreview,
  resolveAvatarSelection,
  selectionToPresence,
  type CompanionAvatarAsset,
  type CompanionAvatarChoice,
} from '../companion/avatar-gallery.js';

type ChatIdentity = Parameters<typeof createRegionCommandClient>[0]['identity'];

const shell: CSSProperties = {
  height: '100vh',
  display: 'flex',
  flexDirection: 'column',
  background: '#0b0f14',
  color: '#e8eef4',
  fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
};

const bar: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 10px',
  borderBottom: '1px solid #1e2731',
  background: '#0f141a',
  flexShrink: 0,
};

const btn: CSSProperties = {
  padding: '4px 9px',
  borderRadius: 8,
  border: '1px solid #3a4654',
  background: '#1c2430',
  color: '#e8eef4',
  cursor: 'pointer',
  fontSize: 12,
};

const btnActive: CSSProperties = {
  ...btn,
  border: '1px solid #3f6cb0',
  background: '#2f5c9e',
  color: '#fff',
};

const voiceBadge: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '3px 8px',
  borderRadius: 999,
  fontSize: 11,
  border: '1px solid #2a333d',
  background: '#141a21',
  color: '#9aa7b5',
};

const galleryPanel: CSSProperties = {
  position: 'absolute',
  top: 42,
  left: 8,
  zIndex: 20,
  width: 'min(360px, calc(100% - 16px))',
  maxHeight: '60%',
  overflowY: 'auto',
  padding: 10,
  borderRadius: 10,
  border: '1px solid #2a333d',
  background: 'rgba(15,20,26,0.98)',
  boxShadow: '0 8px 30px rgba(0,0,0,0.45)',
};

// Reuse the same presence store ConfigSheet writes to, so a model chosen there
// is the one the companion opens with.
const presenceStore = createPresenceStore('nexus-chat-react');
const avatarStore = createCompanionAvatarStore('nexus-desktop');

/** Dock the dev debug surfaces over the bottom of the companion, above the strip. */
const debugPanel: CSSProperties = {
  position: 'absolute',
  right: 8,
  bottom: 40,
  zIndex: 30,
  width: 'min(560px, calc(100% - 16px))',
  maxHeight: '70%',
  overflowY: 'auto',
};

function unwrapAssets(result: unknown): CompanionAvatarAsset[] {
  const r = result as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return [];
  const data = (r.responseObject ?? r.data ?? r) as Record<string, unknown> | unknown[];
  const items = Array.isArray(data)
    ? data
    : Array.isArray((data as { assets?: unknown }).assets)
      ? (data as { assets: unknown[] }).assets
      : [];
  return items
    .map((row): CompanionAvatarAsset | null => {
      if (!row || typeof row !== 'object') return null;
      const v = row as Record<string, unknown>;
      const id = typeof v.id === 'string' ? v.id : typeof v._id === 'string' ? v._id : null;
      if (!id) return null;
      return {
        id,
        kind: typeof v.kind === 'string' ? v.kind : null,
        url: typeof v.url === 'string' ? v.url : null,
        validationStatus: typeof v.validationStatus === 'string' ? v.validationStatus : null,
        visibility: typeof v.visibility === 'string' ? v.visibility : null,
        ownerId: typeof v.ownerId === 'string' ? v.ownerId : null,
        name: typeof v.name === 'string' ? v.name : null,
      };
    })
    .filter((x): x is CompanionAvatarAsset => Boolean(x));
}

/**
 * Immersive companion window body (Phase 7a / 11e).
 *
 * One agent, small and album-shaped: the 3D/VRM avatar (or a profile image) with
 * a live voice session, plus a compact chat strip that expands to a full pane.
 * The window owns its own chat session; only the conversation address comes in
 * via the URL hash, and the token is read from the main process as usual.
 */
export function CompanionView({ launch }: { launch: CompanionLaunch }) {
  const [auth, setAuth] = useState<AuthState>({ status: 'signed_out' });
  const [connection, setConnection] = useState<DesktopConnectionConfig | null>(null);
  const [chat, setChat] = useState<NexusChat | null>(null);
  const [contact, setContact] = useState<ChatContact | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Compact chat strip by default; expands to the full pane without leaving.
  // A `split` launch opens already expanded.
  const [chatOpen, setChatOpen] = useState(launch.mode === 'split');
  const [voiceStatus, setVoiceStatus] = useState<{ active: boolean; status: string }>({
    active: false,
    status: 'idle',
  });
  const [onTop, setOnTop] = useState(launch.alwaysOnTop === true);
  /**
   * Wake present state. When a wake resolves here in dictation mode the companion
   * becomes the STT surface (composer strip), and the realtime call is opt-in — so
   * the strip shows unless the user has an active call. Defaults to dictation when
   * the launch did not ask for an auto-started call.
   */
  const [present, setPresent] = useState<CompanionPresent | null>(null);
  const [dictate, setDictate] = useState(launch.autoStart === false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [assets, setAssets] = useState<CompanionAvatarAsset[]>([]);
  const [choiceId, setChoiceId] = useState<string | null>(() => avatarStore.get(launch.contactId)?.choiceId ?? null);
  const clientRef = useRef<ReturnType<typeof createRegionCommandClient> | null>(null);
  // 3D companion host (flat canvas or walkable scene). The character tool pack
  // and the debug panels bind to whichever stage is mounted.
  const [avatarHost, setAvatarHost] = useState<CompanionStageHost | null>(null);
  // Debug surfaces: from Settings, force-enabled by `?companionDebug=1`.
  const [debug, setDebug] = useState<CompanionDebugSettings | null>(null);
  // User-facing avatar behaviour (click nod). Defaults ON when settings are absent.
  const [avatarSettings, setAvatarSettings] = useState<CompanionAvatarSettings | null>(null);
  const forcedDebug = useMemo(() => new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('companionDebug') === '1', []);
  const [motionFeedOpen, setMotionFeedOpen] = useState(false);
  const [gestureTestOpen, setGestureTestOpen] = useState(false);
  const [statusMotionsOpen, setStatusMotionsOpen] = useState(false);
  const [statusMotions, setStatusMotions] = useState<StatusMotionMap>(() => parseStatusMotions(null));
  const registeredToolsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    void bridge.getConnectionConfig().then(setConnection);
    void bridge.getAuthState().then(setAuth);
    void bridge.getUiSettings().then((ui) => {
      setDebug(ui.companionDebug);
      setAvatarSettings(ui.companionAvatar);
    });
  }, []);

  // Debug surfaces effectively on when the Settings toggle says so, or a
  // developer forced them with `?companionDebug=1` in the companion URL hash.
  const debugEnabled = useMemo<CompanionDebugSettings>(
    () => ({
      motionFeed: forcedDebug || Boolean(debug?.motionFeed),
      gestureTest: forcedDebug || Boolean(debug?.gestureTest),
      statusMotions: forcedDebug || Boolean(debug?.statusMotions),
      sceneMode: forcedDebug || Boolean(debug?.sceneMode),
    }),
    [debug, forcedDebug],
  );

  // Register the 3D scene client tools (character_* / locomotion / scene) so the
  // agent can walk, gesture, change mood, and move scene objects. Registered once
  // per session; handlers close over a getter so they always hit the live host.
  const hostGetterRef = useRef<CompanionStageHost | null>(null);
  hostGetterRef.current = avatarHost;
  useEffect(() => {
    if (!chat) return;
    const names = registerCharacterTools(
      CHARACTER_SKILL.allTools(),
      () => hostGetterRef.current,
      (descriptor, handler) => {
        chat.registerTool(descriptor, handler);
        registeredToolsRef.current.add(descriptor.name);
      },
    );
    return () => {
      registeredToolsRef.current = new Set(names);
    };
  }, [chat]);

  // OS-global cursor feed: the main process samples `screen.getCursorScreenPoint`
  // and pushes display-normalized coords, so the avatar's head/eyes keep following
  // the pointer even when it leaves this window and moves across the whole OS
  // screen. Bound to the live 3D host; re-runs on host swap so a scene/flat swap
  // re-enables the external pointer on the new controller.
  useEffect(() => {
    const host = avatarHost;
    if (!host) return;
    host.setExternalPointerEnabled?.(true);
    const unsubscribe = bridge.onCompanionGlobalCursor((coords) => {
      if (coords.contactId !== launch.contactId) return;
      const ndc = companionCursorToGazeNdc(coords);
      host.setPointerNdc?.(ndc.x, ndc.y);
    });
    return () => {
      unsubscribe();
      host.setExternalPointerEnabled?.(false);
    };
  }, [avatarHost, launch.contactId]);

  // Wider, configurable gaze cone: the companion tracks the cursor across the
  // whole screen, so the tight library default (head ~8° of actual turn) reads as
  // "barely moves". Bound to the live host so a scene/flat swap re-applies it.
  useEffect(() => {
    const host = avatarHost;
    if (!host?.setGazeLimits) return;
    host.setGazeLimits({
      headYawMaxDeg: avatarSettings?.gazeYawMaxDeg,
      headPitchMaxDeg: avatarSettings?.gazePitchMaxDeg,
    });
  }, [avatarHost, avatarSettings?.gazeYawMaxDeg, avatarSettings?.gazePitchMaxDeg]);

  // Click nod: the avatar nods (configurable gesture) when the user clicks the
  // companion. Bound to the live host so a scene/flat swap re-applies it.
  useEffect(() => {
    const host = avatarHost;
    if (!host?.setClickAck) return;
    host.setClickAck({
      enabled: avatarSettings?.clickNod !== false,
      gesture: avatarSettings?.clickNodGesture,
    });
  }, [avatarHost, avatarSettings?.clickNod, avatarSettings?.clickNodGesture]);

  // Cycle status gestures while the agent is working (only when the editor is on).
  useAgentStatusMotions({
    host: avatarHost as CompanionStageHost | null,
    agentStatus: streaming ? { state: 'thinking' } : null,
    motions: statusMotions,
    enabled: debugEnabled.statusMotions,
  });

  const apiBaseUrl = connection?.regionUrl ?? '';
  const identity = useMemo<ChatIdentity | null>(
    () =>
      auth.status === 'signed_in'
        ? {
            token: auth.token,
            userId: auth.identity.userId ?? null,
            orgId: auth.identity.orgId ?? null,
            role: auth.identity.role ?? null,
            deviceId: auth.identity.deviceId ?? null,
          }
        : null,
    [auth],
  );

  // Build the chat, hydrate the contact, and pull turns as the session streams.
  useEffect(() => {
    if (!apiBaseUrl || !identity) return;
    let cancelled = false;
    const client = createRegionCommandClient({ apiBaseUrl, identity });
    clientRef.current = client;
    const nextChat = createNexusChat({
      client,
      features: { adminPanels: false },
      publicFilesBaseUrl: apiBaseUrl,
    });
    setChat(nextChat);
    const unsubscribe = nextChat.subscribe(() => {
      const state = nextChat.getState();
      setTurns(state.turns);
      setStreaming(Boolean(state.streaming));
    });

    void (async () => {
      try {
        await nextChat.loadContacts();
        if (cancelled) return;
        const fromState = findChatContact(nextChat.getState().contacts, launch.contactId);
        setContact(
          fromState ?? {
            id: launch.contactId,
            name: launch.title ?? launch.contactId,
            type: 'agent',
            virtualEmployeeId: launch.virtualEmployeeId ?? undefined,
            agentId: launch.agentId ?? undefined,
            avatarUrl: launch.avatarUrl ?? undefined,
          },
        );
        // Resume the existing thread when we know it; otherwise open the latest.
        if (launch.conversationId) {
          await nextChat.reopenConversation(launch.conversationId);
        } else {
          await nextChat.openContact(launch.contactId);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'could not open the agent');
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe();
      clientRef.current = null;
    };
  }, [apiBaseUrl, identity, launch.contactId, launch.conversationId, launch.title, launch.virtualEmployeeId, launch.agentId, launch.avatarUrl]);

  // Load the agent's usable avatar catalog (public + verified own uploads) once
  // the client is ready. Failures degrade to the profile image only.
  useEffect(() => {
    if (!clientRef.current || !apiBaseUrl) return;
    let cancelled = false;
    void clientRef.current
      .send('anx.inference.avatar-assets.list', {})
      .then((result) => {
        if (!cancelled) setAssets(unwrapAssets(result));
      })
      .catch(() => {
        if (!cancelled) setAssets([]);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, chat]);

  // Reflect the current pin state from main (covers reopening an existing window).
  useEffect(() => {
    void bridge
      .companionIsAlwaysOnTop(launch.contactId)
      .then((value) => {
        if (typeof value === 'boolean') setOnTop(value);
      })
      .catch(() => undefined);
  }, [launch.contactId]);

  // A wake that resolves to this companion is handed over live (no reload). A
  // `dictate` presentation makes this the STT surface; a voice presentation
  // leaves the realtime call (already running) untouched.
  useEffect(() => {
    const off = bridge.onCompanionPresent((payload) => {
      if (payload.contactId !== launch.contactId) return;
      setPresent(payload);
      setDictate(payload.dictate);
      setError(null);
    });
    return () => off();
  }, [launch.contactId]);

  const basePresence: ParticipantPresenceV1 | null = useMemo(() => {
    const fromContact = contact ? readPresenceFromProfile(contact) : null;
    const stored = presenceStore.get(launch.contactId) || null;
    return stored ?? fromContact ?? null;
  }, [contact, launch.contactId]);

  const choices: CompanionAvatarChoice[] = useMemo(
    () => buildAvatarChoices({ contact, presence: basePresence, assets }),
    [contact, basePresence, assets],
  );
  const resolved = useMemo(
    () => resolveAvatarSelection(choices, choiceId),
    [choices, choiceId],
  );
  const selectionPresence = useMemo(
    () => selectionToPresence(basePresence, resolved),
    [basePresence, resolved],
  );

  const chooseAvatar = useCallback(
    (choice: CompanionAvatarChoice) => {
      setChoiceId(choice.id);
      avatarStore.set(launch.contactId, { mode: choice.kind, choiceId: choice.id });
      const next = selectionToPresence(basePresence, {
        choice,
        vrmUrl: choice.kind === 'vrm' ? choice.url : null,
        vrmAssetId: choice.kind === 'vrm' ? (choice.assetId ?? null) : null,
        vrmValidationStatus: choice.kind === 'vrm' ? (choice.validationStatus ?? null) : null,
        imageUrl: choice.kind === 'image' ? choice.url : null,
      });
      presenceStore.set(launch.contactId, next);
      setGalleryOpen(false);
    },
    [basePresence, launch.contactId],
  );

  const togglePin = useCallback(() => {
    const next = !onTop;
    setOnTop(next);
    void bridge.companionSetAlwaysOnTop(launch.contactId, next).then((applied) => {
      if (typeof applied === 'boolean') setOnTop(applied);
    });
  }, [onTop, launch.contactId]);

  // A wake may resolve a different (latest active) conversation than the one this
  // window opened with; follow it so the composer sends to the right thread.
  useEffect(() => {
    const conversationId = present?.conversationId ?? null;
    if (!conversationId || !chat) return;
    if (conversationId === chat.getState().conversationId) return;
    void chat.reopenConversation(conversationId).catch(() => undefined);
  }, [present?.conversationId, present?.token, chat]);

  const preview = latestTranscriptPreview(turns);
  const agentName = launch.title ?? contact?.name ?? 'Companion';
  const isImageAvatar = resolved?.choice.kind === 'image';
  // The composer is the STT surface when a wake handed dictation here and the
  // realtime call is not live (voice mode owns the capture).
  const showComposer = dictate && !voiceStatus.active;

  const debugActive = debugEnabled.motionFeed || debugEnabled.gestureTest || debugEnabled.statusMotions;

  return (
    <MotionFeedProvider host={avatarHost}>
    <div style={shell}>
      <header style={bar}>
        <strong style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {agentName}
        </strong>
        <span style={voiceBadge} title="Companion opens in voice mode">
          <span aria-hidden>{voiceStatus.active ? '🎙' : '🔈'}</span>
          {voiceStatus.active ? 'voice live' : 'voice mode'}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          style={galleryOpen ? btnActive : btn}
          aria-label="Avatar gallery"
          title="Switch avatar (3D model or profile image)"
          onClick={() => setGalleryOpen((open) => !open)}
        >
          Avatars
        </button>
        <button
          type="button"
          style={chatOpen ? btnActive : btn}
          aria-label="Expand chat"
          title={chatOpen ? 'Collapse chat' : 'Expand chat'}
          onClick={() => setChatOpen((open) => !open)}
        >
          {chatOpen ? 'Chat ▾' : 'Chat ▴'}
        </button>
        <button
          type="button"
          style={onTop ? btnActive : btn}
          aria-label="Always on top"
          title={onTop ? 'Unpin from top' : 'Keep on top'}
          onClick={togglePin}
        >
          {onTop ? '📌' : '📍'}
        </button>
        {debugActive ? (
          <>
            {debugEnabled.motionFeed ? (
              <button
                type="button"
                style={motionFeedOpen ? btnActive : btn}
                aria-label="Motion feed"
                title="Live action feed (dev)"
                onClick={() => setMotionFeedOpen((open) => !open)}
              >
                Motion
              </button>
            ) : null}
            {debugEnabled.gestureTest ? (
              <button
                type="button"
                style={gestureTestOpen ? btnActive : btn}
                aria-label="Gesture tester"
                title="Play any loaded clip (dev)"
                onClick={() => setGestureTestOpen((open) => !open)}
              >
                Gestures
              </button>
            ) : null}
            {debugEnabled.statusMotions ? (
              <button
                type="button"
                style={statusMotionsOpen ? btnActive : btn}
                aria-label="Status motions"
                title="Clips cycled while the agent works (dev)"
                onClick={() => setStatusMotionsOpen((open) => !open)}
              >
                Status
              </button>
            ) : null}
          </>
        ) : null}
        <button
          type="button"
          style={btn}
          aria-label="Close companion"
          onClick={() => void bridge.companionClose(launch.contactId)}
        >
          Close
        </button>
      </header>

      {galleryOpen ? (
        <div style={galleryPanel} role="dialog" aria-label="Avatar gallery">
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
            <strong style={{ fontSize: 12 }}>Avatar gallery</strong>
            <span style={{ flex: 1 }} />
            <button type="button" style={btn} onClick={() => setGalleryOpen(false)}>
              ×
            </button>
          </div>
          {choices.length === 0 ? (
            <p style={{ fontSize: 12, color: '#9aa7b5', margin: 0 }}>
              No avatar yet. Upload a VRM in the main window’s chat config, or keep the profile image.
            </p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
              {choices.map((choice) => (
                <li key={choice.id}>
                  <button
                    type="button"
                    style={{
                      ...(choice.id === resolved?.choice.id ? btnActive : btn),
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      justifyContent: 'flex-start',
                    }}
                    onClick={() => chooseAvatar(choice)}
                  >
                    {choice.kind === 'image' && choice.url ? (
                      <CachedAvatarImage
                        src={choice.url}
                        alt=""
                        style={{ width: 32, height: 32, borderRadius: 6, objectFit: 'cover' }}
                        fallback={'🖼'}
                      />
                    ) : (
                      <span
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: 6,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          background: '#0f141a',
                          border: '1px solid #2a333d',
                        }}
                      >
                        🧍
                      </span>
                    )}
                    <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                      <span style={{ fontSize: 12 }}>{choice.label}</span>
                      <span style={{ fontSize: 10, color: '#9aa7b5' }}>
                        {choice.kind === 'vrm' ? '3D model (VRM)' : 'profile image'}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {/* The 3D/voice stage stays mounted across chat collapse/expand so the
          live voice session is never torn down. Expanding reveals the
          transcript pane beside it — the chat-app "view" axis is not used here
          because `VoiceLayout`'s layout is mount-only state (a re-render would
          not switch panes and remounting would drop the call). */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: chatOpen ? 'row' : 'column',
        }}
      >
        <div
          style={{
            flex: chatOpen ? '0 0 60%' : 1,
            minWidth: 0,
            minHeight: 0,
            // Flex column so the voice surface's `flex: 1` chain (voice →
            // pane → avatar pane → canvas) gets a definite height. As a plain
            // block this wrapper let the 3D pane collapse to content height.
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
          }}
        >
          {error ? (
            <p style={{ padding: 24, color: '#f2a1a1' }}>{error}</p>
          ) : !identity ? (
            <p style={{ padding: 24, color: '#9aa7b5' }}>Sign in from the main window.</p>
          ) : !chat || !contact ? (
            <p style={{ padding: 24, color: '#9aa7b5' }}>Starting companion…</p>
          ) : (
            <VoiceLayout
              // Remount when the target contact changes so the voice session
              // re-auto-starts against the right agent. VoiceLayout gates
              // `autoStart` on `contact` being a resolved agent, so the
              // fail-fast "Open an agent conversation…" path never fires on a
              // cold open.
              key={contact.id}
              chat={chat}
              contact={contact}
              turns={turns}
              streaming={streaming}
              presence={selectionPresence}
              // A gallery image selection overrides the 3D canvas with the
              // profile image; a VRM selection lets VoiceAvatarCanvas render it.
              avatarSlot={
                isImageAvatar && resolved?.imageUrl ? (
                  <CachedAvatarImage
                    src={resolved.imageUrl}
                    alt={agentName}
                    style={{ maxHeight: '100%', maxWidth: '100%', borderRadius: 12 }}
                    fallback={'🎙️'}
                  />
                ) : undefined
              }
              initialLayout="avatar"
              splitAxis="vertical"
              autoStart={launch.autoStart !== false}
              sceneMode={debugEnabled.sceneMode}
              onAvatarHost={(host: CompanionStageHost | null) => setAvatarHost(host)}
              onVoiceState={(state: { active: boolean; muted: boolean; status: string; errorMessage: string | null }) =>
                setVoiceStatus({ active: state.active, status: state.status })
              }
            />
          )}
        </div>
        {chatOpen && chat ? (
          <div
            data-testid="companion-transcript"
            style={{
              flex: '1 1 40%',
              minWidth: 0,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              borderLeft: '1px solid #1e2731',
              background: '#0b0f14',
            }}
          >
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 12px' }}>
              <ThreadView
                turns={turns}
                streaming={streaming}
                chat={chat}
                conversationId={contact?.id ? (chat.getState().conversationId ?? null) : null}
                empty="Transcript will appear here."
              />
            </div>
          </div>
        ) : null}
      </div>

      {showComposer ? <CompanionComposer contactId={launch.contactId} /> : null}

      {!chatOpen && preview ? (
        <div
          style={{
            padding: '6px 12px',
            borderTop: '1px solid #1e2731',
            background: '#0f141a',
            fontSize: 11,
            color: '#9aa7b5',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            flexShrink: 0,
          }}
          title={preview}
        >
          {preview}
        </div>
      ) : null}

      {debugEnabled.motionFeed && motionFeedOpen ? (
        <DockedMotionFeed onClose={() => setMotionFeedOpen(false)} />
      ) : null}
      {debugEnabled.gestureTest ? (
        <GestureTestPanel
          open={gestureTestOpen}
          getCatalog={() => avatarHost?.listLoadedGestures?.() ?? []}
          onPlay={(id, loop) => avatarHost?.playGesture?.(id, loop, 'user', 'debug')}
          onClose={() => setGestureTestOpen(false)}
        />
      ) : null}
      {debugEnabled.statusMotions && statusMotionsOpen ? (
        <div style={debugPanel} role="dialog" aria-label="Status motions editor">
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ flex: 1 }} />
            <button type="button" style={btn} onClick={() => setStatusMotionsOpen(false)}>
              ×
            </button>
          </div>
          <StatusMotionsConfig
            motions={statusMotions}
            onChange={(next) => {
              setStatusMotions(next);
              const profile = presenceStore.get(launch.contactId);
              if (profile) {
                presenceStore.set(launch.contactId, {
                  ...profile,
                  settings: { ...(profile.settings ?? {}), status_motions: serializeStatusMotions(next) },
                });
              }
            }}
          />
        </div>
      ) : null}
    </div>
    </MotionFeedProvider>
  );
}

/** Motion feed panel wired to the provider (keeps the provider hook scoped here). */
function DockedMotionFeed({ onClose }: { onClose: () => void }) {
  const feed = useMotionFeed();
  return (
    <div style={debugPanel} role="dialog" aria-label="Motion feed">
      <MotionFeedPanel
        open
        events={feed.events}
        onClear={feed.clear}
        onClose={onClose}
      />
    </div>
  );
}
