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
// Motion-feed / status-motion debug surfaces. The *panels* now render in their
// own standalone windows (Deliverable 3), but the companion still needs the
// action-feed provider (to mirror events to those windows) and the status-motion
// hook (to cycle working clips on the live stage).
import {
  MotionFeedProvider,
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
  IDLE_MOVE_KEYS,
  isLocomotionKey,
  isTypingTarget,
  isIdleMoveInput,
  moveInputFromKeys,
  moveSpeedForKeys,
  readMoveKeys,
  type MoveKeys,
} from '../companion/locomotion-keys.js';
import { CompanionAvatarGallery } from './CompanionAvatarGallery.js';
import {
  bridge,
  callBridge,
  hasBridgeMethod,
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
  mappedLocalAvatar,
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
import { normalizePoseContext, poseToBrowserContext } from '../../shared/companion.js';
import type { CompanionToolId, LocalAvatarsConfig } from '../../shared/ipc.js';

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

// Reuse the same presence store ConfigSheet writes to, so a model chosen there
// is the one the companion opens with.
const presenceStore = createPresenceStore('nexus-chat-react');
const avatarStore = createCompanionAvatarStore('nexus-desktop');

/** Bottom-left WASD hint shown only when the mounted stage is walkable. */
const locomotionHint: CSSProperties = {
  position: 'absolute',
  left: 10,
  bottom: 10,
  zIndex: 15,
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: '5px 8px',
  borderRadius: 8,
  border: '1px solid #2a333d',
  background: 'rgba(15,20,26,0.85)',
  color: '#9aa7b5',
  fontSize: 11,
  pointerEvents: 'none',
};

const kbd: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 16,
  height: 16,
  padding: '0 3px',
  borderRadius: 4,
  border: '1px solid #3a4654',
  background: '#1c2430',
  color: '#e8eef4',
  fontSize: 10,
  fontFamily: 'inherit',
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
  // This device's own avatar library + per-agent mapping (Deliverable 2).
  const [localAvatars, setLocalAvatars] = useState<LocalAvatarsConfig | null>(null);
  const clientRef = useRef<ReturnType<typeof createRegionCommandClient> | null>(null);
  // 3D companion host (flat canvas or walkable scene). The character tool pack
  // and the debug panels bind to whichever stage is mounted.
  const [avatarHost, setAvatarHost] = useState<CompanionStageHost | null>(null);
  // Debug surfaces: from Settings, force-enabled by `?companionDebug=1`.
  const [debug, setDebug] = useState<CompanionDebugSettings | null>(null);
  // User-facing avatar behaviour (click nod). Defaults ON when settings are absent.
  const [avatarSettings, setAvatarSettings] = useState<CompanionAvatarSettings | null>(null);
  const forcedDebug = useMemo(() => new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('companionDebug') === '1', []);
  /**
   * Detached tool windows (Deliverable 3). Each context-menu tool ("Motion feed",
   * "Gesture tester", "Status motions") opens as its own `BrowserWindow` scoped to
   * this contact, so nothing is docked inside the companion anymore. This tracks
   * *whether* main reports one open, so the menu can show it as active and the
   * companion only runs the (small) state-relay loop while something listens.
   */
  const [toolWindowsOpen, setToolWindowsOpen] = useState(false);
  // Which of this agent's tools currently have a window open (for the menu's
  // per-row state and to know what the relay needs to publish).
  const [openTools, setOpenTools] = useState<CompanionToolId[]>([]);
  const [statusMotions, setStatusMotions] = useState<StatusMotionMap>(() => parseStatusMotions(null));
  const registeredToolsRef = useRef<Set<string>>(new Set());
  // WASD/Shift/Space state (Deliverable 4). Kept in a ref so the key handlers can
  // drive the live host without re-rendering the whole companion every keypress.
  const moveKeysRef = useRef<MoveKeys>({ ...IDLE_MOVE_KEYS });
  /** Live pressed key codes, cleared on blur. */
  const pressedKeysRef = useRef<Set<string>>(new Set());
  /** Whether a non-idle input is currently pushed (skips redundant no-op pushes). */
  const moveInputPushedRef = useRef(false);

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

  /**
   * WASD / Shift / Space locomotion (Deliverable 4).
   *
   * The keyboard only drives the walkable scene (and the shared room scene); the
   * flat avatar stage has no ground plane, so the listeners are inert without
   * `setMoveInput`. Key events are filtered so the composer keeps typing (`W` in a
   * text field must not walk the rig) and so a held key does not keep walking
   * after the window loses focus.
   *
   * `Space` stays a held flag: the locomotion tick consumes it as a rising edge
   * and the animator plays the `jump` clip on the edge, so a held key cannot
   * re-fire or leave the rig stuck airborne.
   */
  useEffect(() => {
    const host = stageHost;
    if (!host?.setMoveInput) return;
    // Capture the (guarded, non-optional) method so the closures below do not
    // have to re-narrow the live host on every keypress.
    const setMoveInput = host.setMoveInput;
    const push = () => {
      if (hostGetterRef.current !== host) return;
      const keys = moveKeysRef.current;
      host.setAnalogSpeed?.(moveSpeedForKeys(keys));
      const input = moveInputFromKeys(keys);
      // Skip a redundant no-op push (every frame of a held idle key).
      if (isIdleMoveInput(input) && !moveInputPushedRef.current) return;
      moveInputPushedRef.current = !isIdleMoveInput(input);
      setMoveInput(input);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isLocomotionKey(e.code) || isTypingTarget(e.target)) return;
      // Keep Space from scrolling and WASD from any default page pan.
      e.preventDefault();
      moveKeysRef.current = readMoveKeys(pressedKeysRef.current.add(e.code));
      push();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!isLocomotionKey(e.code)) return;
      pressedKeysRef.current.delete(e.code);
      moveKeysRef.current = readMoveKeys(pressedKeysRef.current);
      push();
    };
    // Losing focus clears the input so a held key does not walk the rig forever.
    const clear = () => {
      pressedKeysRef.current.clear();
      moveKeysRef.current = { ...IDLE_MOVE_KEYS };
      setMoveInput({ x: 0, z: 0, yaw: 0, jump: false });
      moveInputPushedRef.current = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', clear);
      clear();
    };
  }, [stageHost]);

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

  // This device's own avatar library (Deliverable 2). Read once on mount and
  // refreshed after an import/remove; a preload that predates the feature simply
  // yields `null` and the gallery falls back to its old copy.
  useEffect(() => {
    if (!hasBridgeMethod(bridge, 'localAvatarsList')) return;
    let cancelled = false;
    const read = () => {
      void callBridge<LocalAvatarsConfig | null>(bridge, 'localAvatarsList', null).then((config) => {
        if (!cancelled) setLocalAvatars(config);
      });
    };
    read();
    // The Settings surface can add/remove models and remap agents while this
    // window is open, so re-read on focus — no reload (which would drop the live
    // voice call) and no polling.
    const onFocus = () => read();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  /**
   * The library avatar mapped to **this** agent wins the initial selection when
   * the user has not explicitly picked a tile in this window. It is deliberately
   * per-contact: several companions can be open and each remembers its own
   * agent's model instead of one global avatar.
   */
  const mappedLocal = useMemo(
    () => mappedLocalAvatar(localAvatars, launch.contactId),
    [localAvatars, launch.contactId],
  );
  const effectiveChoiceId = useMemo(() => {
    if (choiceId) return choiceId;
    return mappedLocal ? `local:${mappedLocal.id}` : null;
  }, [choiceId, mappedLocal]);

  const choices: CompanionAvatarChoice[] = useMemo(
    () =>
      buildAvatarChoices({
        contact,
        presence: basePresence,
        assets,
        localAvatars,
      }),
    [contact, basePresence, assets, localAvatars],
  );
  const resolved = useMemo(
    () => resolveAvatarSelection(choices, effectiveChoiceId),
    [choices, effectiveChoiceId],
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
      // Deliverable 2: a picked library model becomes this agent's remembered
      // mapping (so the gallery highlights it and a reopen restores it). Picking
      // anything else clears the mapping, so it never overrides an explicit pick.
      if (hasBridgeMethod(bridge, 'localAvatarsSetMapping')) {
        const avatarId = choice.local ? (choice.localAvatarId ?? null) : null;
        void callBridge<LocalAvatarsConfig | null>(
          bridge,
          'localAvatarsSetMapping',
          null,
          launch.contactId,
          avatarId,
        ).then((config) => {
          if (config) setLocalAvatars(config);
        });
      }
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
        case 'gestures':
        case 'status-motions':
          // Deliverable 3: these open as their own windows, scoped to this
          // contact's agent, instead of docking inside the companion.
          void callBridge<{ contactId: string } | null>(bridge, 'companionOpenTool', null, {
            tool: action as CompanionToolId,
            contactId: launch.contactId,
            agentName: launch.title ?? contact?.name ?? null,
          });
          break;
      }
    },
    [resetPose, launch.contactId, launch.title, contact?.name],
  );

  // Deliverable 3: main tells us which of our tool windows are open, so the
  // companion only runs the state-relay loop while a window is listening and the
  // menu can show each tool row's live state.
  useEffect(() => {
    const off = onBridge<{ contactId: string; open: boolean; tools?: string[] }>(
      bridge,
      'onCompanionToolPresence',
      (presence) => {
        if (!presence || presence.contactId !== launch.contactId) return;
        const tools = (presence.tools ?? []) as CompanionToolId[];
        setOpenTools(tools);
        setToolWindowsOpen(Boolean(presence.open));
      },
    );
    return () => off();
  }, [launch.contactId]);

  // Deliverable 3: a status-motions edit made in a detached tool window is relayed
  // back here — the window that owns the agent's session persists + applies it.
  useEffect(() => {
    const off = onBridge<{ contactId: string; statusMotions: Record<string, unknown> | null }>(
      bridge,
      'onCompanionToolSync',
      (sync) => {
        if (!sync || sync.contactId !== launch.contactId) return;
        const next = parseStatusMotions(sync.statusMotions);
        setStatusMotions(next);
        const profile = presenceStore.get(launch.contactId);
        if (profile) {
          presenceStore.set(launch.contactId, {
            ...profile,
            settings: {
              ...(profile.settings ?? {}),
              status_motions: serializeStatusMotions(next),
            },
          });
        }
      },
    );
    return () => off();
  }, [launch.contactId]);

  // Deliverable 3: turn metadata for the next outbound companion turn — where the
  // avatar stands now. Read at send time (see `CompanionComposer.getTurnContext`)
  // so a turn carries the live pose, and shape it as a `browserContext` block the
  // chat call already forwards.
  const getTurnContext = useCallback((): Record<string, unknown> | undefined => {
    const host = hostGetterRef.current;
    if (!host?.getPoseFeedback) return undefined;
    const pose = normalizePoseContext(host.getPoseFeedback(), launch.contactId);
    return poseToBrowserContext(pose);
  }, [launch.contactId]);

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
  /**
   * Deliverable 4: whether the mounted stage is the walkable scene (flat stage
   * with scene mode on, or a shared room). Only then do WASD/Shift/Space mean
   * anything, so the on-screen hint is shown only here.
   */
  const walkable = Boolean(launch.roomId) || (!launch.roomId && debugEnabled.sceneMode && !isImageAvatar);

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
        <CompanionAvatarGallery
          choices={choices}
          resolved={resolved}
          onChoose={chooseAvatar}
          onClose={() => setGalleryOpen(false)}
          onOpenSettings={() => void callBridge<boolean>(bridge, 'openSettings', false)}
          onLibraryChange={setLocalAvatars}
        />
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
        {walkable && stageHost?.setMoveInput ? (
          // Deliverable 4: the 3D scene is keyboard-drivable here. The hint is
          // pointer-events:none so it never eats a scene click / right-click.
          <div style={locomotionHint} aria-hidden>
            <kbd style={kbd}>W</kbd>
            <kbd style={kbd}>A</kbd>
            <kbd style={kbd}>S</kbd>
            <kbd style={kbd}>D</kbd>
            <span style={{ margin: '0 4px' }}>walk</span>
            <kbd style={kbd}>Shift</kbd>
            <span style={{ margin: '0 4px' }}>run</span>
            <kbd style={kbd}>Space</kbd>
            <span>jump</span>
          </div>
        ) : null}
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

      {showComposer ? (
        <CompanionComposer contactId={launch.contactId} getTurnContext={getTurnContext} />
      ) : null}

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

      {/* Deliverable 3: the debug tool panels are no longer docked here — they
          open as their own per-agent windows. This relay keeps the owning
          companion streaming live state (status motions, loaded gestures, action
          feed) to those windows only while one is listening. */}
      <CompanionToolRelay
        contactId={launch.contactId}
        active={toolWindowsOpen}
        statusMotions={statusMotions}
        getGestures={() => hostGetterRef.current?.listGestures?.() ?? []}
      />

      {menu.open ? (
        <SceneMenuAnchorContext.Provider value={menuAnchor}>
          <SceneContextMenu
            debugEnabled={debugEnabled}
            open={{
              galleryOpen,
              // A tool row shows as active when that tool's own window is open.
              motionFeedOpen: openTools.includes('motion-feed'),
              gestureTestOpen: openTools.includes('gestures'),
              statusMotionsOpen: openTools.includes('status-motions'),
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

/**
 * Tool-state relay (Deliverable 3). Runs inside the `MotionFeedProvider` so it
 * can read the live action feed, and mirrors this agent's stage into its own
 * detached tool windows while any is open.
 *
 * The gestures are read straight off the live host each tick; the action feed
 * comes from the provider (its events update every action, so an effect keyed on
 * them republishes immediately rather than on a poll). Publishing stops when the
 * last tool window closes, so an idle companion does no periodic work.
 */
function CompanionToolRelay({
  contactId,
  active,
  statusMotions,
  getGestures,
}: {
  contactId: string;
  active: boolean;
  statusMotions: StatusMotionMap;
  getGestures: () => string[];
}) {
  const feed = useMotionFeed();
  useEffect(() => {
    if (!active) return;
    void callBridge<boolean>(bridge, 'companionToolPublish', false, {
      contactId,
      statusMotions: serializeStatusMotions(statusMotions),
      gestures: getGestures(),
      actionFeed: feed.events,
    });
    // `feed.events` is a fresh array per event, so this republishes on every
    // action without a timer; `statusMotions` publishes on an edit too. The
    // gestures are read through the getter so a stage swap is reflected live.
  }, [active, contactId, statusMotions, getGestures, feed.events]);
  return null;
}
