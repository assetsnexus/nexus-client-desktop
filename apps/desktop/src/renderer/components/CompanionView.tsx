import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react';
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
import { CachedAvatarImage, createCompanionSceneHost } from '@nexus/character-react';
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
  onBridge,
  type AuthState,
  type CompanionAvatarSettings,
  type CompanionDebugSettings,
  type CompanionLaunch,
  type CompanionPresent,
  type CompanionSttOwner,
  type DesktopConnectionConfig,
} from '../bridge.js';
import { CompanionComposer } from './CompanionComposer.js';
import { CompanionRoomStage } from './CompanionRoomStage.js';
import {
  buildAvatarChoices,
  createCompanionAvatarStore,
  latestTranscriptPreview,
  resolveAvatarSelection,
  selectionToPresence,
  type CompanionAvatarAsset,
  type CompanionAvatarChoice,
} from '../companion/avatar-gallery.js';
import {
  CLOSED_COMPANION_MENU,
  companionMenuReducer,
  type CompanionMenuAction,
} from '../companion/companion-scene-menu.js';
import { SceneContextMenu, SceneMenuAnchorContext } from '../companion/SceneContextMenu.js';

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

/**
 * Compact square icon button for the header (pin / fullscreen). Deliberately
 * smaller than {@link btn} so the crowded bar leaves room for the agent name.
 */
const iconBtn = (active: boolean): CSSProperties => ({
  ...(active ? btnActive : btn),
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 22,
  height: 22,
  minWidth: 22,
  padding: 0,
  lineHeight: 1,
  fontSize: 12,
});

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
  /**
   * A conversation link failure (e.g. the agent is not ours to resume) must not
   * blank the stage — the companion still renders the agent's avatar and voice
   * surface; only the transcript/composer binding is degraded. The same holds for
   * a contact-list failure during a region outage: the launch payload already
   * carries the agent, so the stage mounts and the notice lands in the transcript.
   */
  const [conversationError, setConversationError] = useState<string | null>(null);
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
  /**
   * Single-owner STT election. Exactly one companion may capture the mic; main
   * pushes each window's role here. A window that is *not* primary keeps its
   * avatar(s) rendering (all windows work in parallel) but must not run the
   * dictation composer or auto-answer, so two windows never compete for speech.
   */
  const [sttPrimary, setSttPrimary] = useState(true);
  /**
   * Shared room scene host, when this companion was opened for a group/meeting
   * room. Every agent of the room renders together here (no companion-only
   * path); the host is a single-agent façade over the shared `SceneRoom`, bound
   * to this companion's agent occupant.
   */
  const [roomHost, setRoomHost] = useState<CompanionStageHost | null>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);
  // Scene right-click menu: the reducer owns open/close, the anchor feeds the
  // card's clamped position. Keeping both here (rather than inside the menu) lets
  // a scene click anywhere open it at the cursor.
  const [menu, dispatchMenu] = useReducer(companionMenuReducer, CLOSED_COMPANION_MENU);
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  // Windowed vs fullscreen for this companion window (standard Fullscreen API).
  const [fullscreen, setFullscreen] = useState(false);
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
  //
  // In room mode the flat stage is not mounted; the shared-scene façade
  // (`roomHost`) is the live host, so tools target this companion's occupant
  // inside the multi-agent room.
  const stageHost = roomHost ?? avatarHost;
  const hostGetterRef = useRef<CompanionStageHost | null>(null);
  hostGetterRef.current = stageHost;
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
    const host = stageHost;
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
  }, [stageHost, launch.contactId]);

  // Wider, configurable gaze cone: the companion tracks the cursor across the
  // whole screen, so the tight library default (head ~8° of actual turn) reads as
  // "barely moves". Bound to the live host so a scene/flat swap re-applies it.
  useEffect(() => {
    const host = stageHost;
    if (!host?.setGazeLimits) return;
    host.setGazeLimits({
      headYawMaxDeg: avatarSettings?.gazeYawMaxDeg,
      headPitchMaxDeg: avatarSettings?.gazePitchMaxDeg,
    });
  }, [stageHost, avatarSettings?.gazeYawMaxDeg, avatarSettings?.gazePitchMaxDeg]);

  // Click nod: the avatar nods (configurable gesture) when the user clicks the
  // companion. Bound to the live host so a scene/flat swap re-applies it.
  useEffect(() => {
    const host = stageHost;
    if (!host?.setClickAck) return;
    host.setClickAck({
      enabled: avatarSettings?.clickNod !== false,
      gesture: avatarSettings?.clickNodGesture,
    });
  }, [stageHost, avatarSettings?.clickNod, avatarSettings?.clickNodGesture]);

  // Cycle status gestures while the agent is working (only when the editor is on).
  useAgentStatusMotions({
    host: stageHost as CompanionStageHost | null,
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

    // The launch already carries everything the stage needs (id, title, avatar),
    // so a contact-list failure must never blank the window. Build the fallback
    // contact from the launch and keep the 3D/voice stage mounted; only the
    // transcript binding degrades. A region outage used to unmount the avatar
    // stage for *every* companion window, which read as "all avatars are broken".
    const fallbackContact: ChatContact = {
      id: launch.contactId,
      name: launch.title ?? launch.contactId,
      type: 'agent',
      virtualEmployeeId: launch.virtualEmployeeId ?? undefined,
      agentId: launch.agentId ?? undefined,
      avatarUrl: launch.avatarUrl ?? undefined,
    };
    // Mount the stage immediately from the launch payload; the contact list only
    // enriches it. Waiting on `loadContacts()` meant a slow or failing region left
    // the window on "Starting companion…" with no avatar for as long as the
    // request hung — the dominant "avatars are not spawning" symptom.
    setContact((current) => current ?? fallbackContact);

    void (async () => {
      try {
        await nextChat.loadContacts();
        if (cancelled) return;
        const fromState = findChatContact(nextChat.getState().contacts, launch.contactId);
        setContact(fromState ?? fallbackContact);
      } catch (err) {
        if (cancelled) return;
        // Degrade instead of unmounting the stage: render the agent from the
        // launch payload and surface the failure in the transcript pane.
        setContact(fallbackContact);
        setConversationError(
          err instanceof Error ? err.message : 'could not load contacts',
        );
      }
      if (cancelled) return;
      // Link to the *same* thread the main chat view shows. `openContact` now
      // resumes the latest active conversation for the contact (creating one
      // only when none exists), so opening a companion no longer forks a new
      // session. This is deliberately separate from contact loading: a link
      // failure degrades to the transcript-less stage instead of blanking the
      // avatar stage (the window stays usable and the 3D/voice surface mounts).
      try {
        if (launch.conversationId) {
          await nextChat.reopenConversation(launch.conversationId);
        } else {
          await nextChat.openContact(launch.contactId);
        }
        if (cancelled) return;
        setConversationError(null);
        // Show the *same* thread the main chat view has: pull the shared
        // conversation's turns so the companion's transcript mirrors it rather
        // than appearing empty. Best-effort — a history read that fails (or a
        // thread the viewer cannot read) leaves the stage intact.
        const linkedId = nextChat.getState().conversationId;
        if (linkedId) {
          try {
            const messages = await nextChat.listMessages(linkedId, { limit: 60 });
            if (!cancelled) {
              nextChat.rehydrateTurns(
                (messages as Array<Record<string, unknown>>).map((m) => ({
                  id: m.id as string | undefined,
                  role: String(m.role || 'assistant'),
                  content: String(m.content ?? m.text ?? ''),
                  toolCalls: Array.isArray(m.toolCalls)
                    ? (m.toolCalls as Array<Record<string, unknown>>)
                    : undefined,
                  attachments: m.attachments as never,
                  createdAt: (m.createdAt as string) || null,
                  senderId: (m.senderId as string) || null,
                  senderName: (m.senderName as string) || null,
                })),
                { conversationId: linkedId, detachStream: true },
              );
            }
          } catch {
            // Keep whatever turns already streamed in.
          }
        }
      } catch (err) {
        if (!cancelled) {
          setConversationError(err instanceof Error ? err.message : 'could not open the agent');
        }
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
    // `onBridge` yields a no-op unsubscribe on a preload that predates the
    // channel, so an older main process cannot blank this window.
    const off = onBridge<CompanionPresent>(bridge, 'onCompanionPresent', (payload) => {
      if (payload.contactId !== launch.contactId) return;
      setPresent(payload);
      setDictate(payload.dictate);
      setConversationError(null);
    });
    return () => off();
  }, [launch.contactId]);

  // Single-owner STT election: main broadcasts whether *this* window owns the
  // microphone. A demoted window stops its own capture (ends the realtime call,
  // hides the composer) so several companions never capture at once, while all
  // of them keep rendering their avatars in parallel.
  useEffect(() => {
    const off = onBridge<CompanionSttOwner>(bridge, 'onCompanionSttOwner', (message) => {
      if (message.contactId !== launch.contactId) return;
      setSttPrimary(message.primary);
    });
    return () => off();
  }, [launch.contactId]);

  // A demotion releases the mic: drop the dictation composer and let
  // `VoiceLayout` end any live call (it owns the surface), so this window cannot
  // compete with the new primary while still rendering its avatar.
  useEffect(() => {
    if (sttPrimary) return;
    setDictate(false);
  }, [sttPrimary]);

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

  // Fullscreen toggle: the whole companion window (browser Fullscreen API). The
  // document-level `fullscreenchange` listener keeps the button in sync when the
  // user leaves fullscreen with Esc or an OS shortcut.
  const toggleFullscreen = useCallback(() => {
    const doc = document;
    if (doc.fullscreenElement) {
      void doc.exitFullscreen?.().catch(() => undefined);
    } else {
      void doc.documentElement.requestFullscreen?.().catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    onChange();
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Right-click anywhere on the scene surface opens the companion menu at the
  // cursor instead of the browser context menu.
  const openSceneMenu = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      const anchor = { x: e.clientX, y: e.clientY };
      setMenuAnchor(anchor);
      dispatchMenu({ type: 'open', ...anchor });
    },
    [],
  );
  const closeSceneMenu = useCallback(() => dispatchMenu({ type: 'close' }), []);

  // Reset the avatar to its idle rest pose. Routed through the live stage host so
  // it works for both the flat stage and the shared room scene.
  const resetPose = useCallback(() => {
    const host = hostGetterRef.current;
    if (!host?.resetPose) return;
    host.resetPose('menu');
  }, []);

  const onMenuAction = useCallback(
    (action: CompanionMenuAction) => {
      switch (action) {
        case 'avatars':
          setGalleryOpen(true);
          break;
        case 'reset-pose':
          resetPose();
          break;
        case 'motion-feed':
          setMotionFeedOpen((open) => !open);
          break;
        case 'gestures':
          setGestureTestOpen((open) => !open);
          break;
        case 'status-motions':
          setStatusMotionsOpen((open) => !open);
          break;
      }
    },
    [resetPose],
  );

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
  // realtime call is not live (voice mode owns the capture). A window that does
  // not own the mic never shows the composer, so captures never compete.
  const showComposer = dictate && !voiceStatus.active && sttPrimary;

  return (
    <MotionFeedProvider host={stageHost}>
    <div style={shell}>
      <header style={bar}>
        <strong style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {agentName}
        </strong>
        <span style={voiceBadge} title="Companion opens in voice mode">
          <span aria-hidden>{voiceStatus.active ? '🎙' : '🔈'}</span>
          {voiceStatus.active ? 'voice live' : 'voice mode'}
        </span>
        {launch.roomId ? (
          <span style={voiceBadge} title="This room shows every agent together in one shared scene">
            <span aria-hidden>👥</span>
            shared scene
          </span>
        ) : null}
        {!sttPrimary ? (
          <span
            style={{ ...voiceBadge, borderColor: '#6b5a2a', color: '#ffd479' }}
            title="Another companion window owns the microphone. Focus it or say its wake word to take over."
          >
            <span aria-hidden>🎙</span>
            mic elsewhere
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
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
          style={iconBtn(onTop)}
          aria-label="Always on top"
          title={onTop ? 'Unpin from top' : 'Keep on top'}
          onClick={togglePin}
        >
          <span aria-hidden>{onTop ? '📌' : '📍'}</span>
        </button>
        <button
          type="button"
          style={iconBtn(fullscreen)}
          aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          onClick={toggleFullscreen}
        >
          <FullscreenGlyph exit={fullscreen} />
        </button>
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
          // Right-clicking the scene surface opens the companion menu (avatar
          // controls + Reset pose) instead of the browser context menu.
          onContextMenu={openSceneMenu}
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
          {!identity ? (
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
              // A group/meeting room renders the shared multi-agent scene as the
              // stage; otherwise a gallery image selection overrides the 3D
              // canvas with the profile image and a VRM selection lets
              // VoiceAvatarCanvas render it.
              avatarSlot={
                launch.roomId && identity && chat && contact ? (
                  <CompanionRoomStage
                    roomId={launch.roomId}
                    // The room roster keys occupants by participant id, which may
                    // be the agent id or the VE id rather than the contact id.
                    focusIds={[launch.contactId, launch.agentId, launch.virtualEmployeeId]}
                    onRoomReady={(room, occupantId) => {
                      // `CompanionSceneHost` satisfies the stage-host contract at
                      // runtime (the tool pack only calls these methods); its
                      // `setMood` narrows `source` to `CharacterActionSource`,
                      // which is a strict subset of the host's `string`.
                      setRoomHost(
                        room && occupantId
                          ? (createCompanionSceneHost(room, occupantId) as unknown as CompanionStageHost)
                          : null,
                      );
                    }}
                  />
                ) : isImageAvatar && resolved?.imageUrl ? (
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
              // A group room is a shared scene (below), not the flat walkable
              // stage; the room viewer owns its own 3D stage.
              sceneMode={!launch.roomId && debugEnabled.sceneMode}
              // The wake engine is owned by the main window; the companion never
              // shows the (always "off") wake chip, and only the elected window
              // may capture the microphone.
              hideWakeIndicator
              captureEnabled={sttPrimary}
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
              {conversationError ? (
                <p style={{ fontSize: 12, color: '#fbbf24', margin: 0 }}>
                  Could not link the shared conversation: {conversationError}. The avatar and voice
                  surfaces still work; reopen from the main chat to restore the transcript.
                </p>
              ) : (
                <ThreadView
                  turns={turns}
                  streaming={streaming}
                  chat={chat}
                  conversationId={contact?.id ? (chat.getState().conversationId ?? null) : null}
                  empty="Transcript will appear here."
                />
              )}
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
          getCatalog={() => stageHost?.listLoadedGestures?.() ?? []}
          onPlay={(id, loop) => stageHost?.playGesture?.(id, loop, 'user', 'debug')}
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

      {menu.open ? (
        <SceneMenuAnchorContext.Provider value={menuAnchor}>
          <SceneContextMenu
            debugEnabled={debugEnabled}
            open={{
              galleryOpen,
              motionFeedOpen,
              gestureTestOpen,
              statusMotionsOpen,
            }}
            poseResetAvailable={Boolean(stageHost?.resetPose)}
            onAction={onMenuAction}
            onClose={closeSceneMenu}
          />
        </SceneMenuAnchorContext.Provider>
      ) : null}
    </div>
    </MotionFeedProvider>
  );
}

/**
 * Fullscreen toggle glyph. Inline SVG rather than an emoji/symbol so it renders
 * identically across platforms and stays crisp at the compact 22px button size.
 * `exit` swaps the corner arrows inward (contract) for outward (expand).
 */
function FullscreenGlyph({ exit }: { exit: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      {exit ? (
        // Contract: corner brackets pulled inward (Minimize).
        <path d="M4.5 1.5 V4.5 H1.5 M7.5 1.5 V4.5 H10.5 M4.5 10.5 V7.5 H1.5 M7.5 10.5 V7.5 H10.5" />
      ) : (
        // Expand: corner brackets pushed outward (Maximize).
        <path d="M1.5 4.5 V1.5 H4.5 M7.5 1.5 H10.5 V4.5 M1.5 7.5 V10.5 H4.5 M10.5 7.5 V10.5 H7.5" />
      )}
    </svg>
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
