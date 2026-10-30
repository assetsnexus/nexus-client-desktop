/**
 * IPC contract between the Electron main process and the renderer.
 *
 * The renderer is sandboxed (contextIsolation on, nodeIntegration off) and only
 * sees the narrow surface exposed by the preload bridge. Types here are shared
 * by main, preload, and renderer so the contract stays in one place.
 */

import type {
  AuthIdentity,
  CountryRow,
  DesktopConnectionConfig,
  LoginCredentials,
  PasswordlessChannel,
  RegionRow,
} from '@nexus/node-core';
import type {
  CompanionAction,
  CompanionLaunch,
  CompanionPresent,
  CompanionSessionView,
  CompanionSttOwner,
  CompanionTitleReport,
  CompanionToolPresence,
  CompanionToolSnapshot,
  CompanionToolSync,
} from './companion.js';
import type { RegionEnvironment } from './sandbox-environment.js';
import type {
  WakeSettings,
  WakeWordBinding,
  WakeAgentRow,
  QueuedUtterance,
  WakeEngineKind,
} from './wake.js';
import type { AppLockSettings, AppLockState } from './app-lock.js';
import type { AudioSettings } from './audio.js';
import type { LogoutChoice, LogoutReport, LogoutStep } from './logout.js';
import type {
  InstalledNexusApp,
  TrayAppItem,
  TrayAppSettings,
} from './nexus-apps.js';
// Imported (not only re-exported) because the bridge contract below *uses*
// `LocalAvatarsConfig` in method signatures, which a bare `export type … from`
// does not bring into scope.
import type { LocalAvatarsConfig } from './local-avatars.js';

export type { RegionEnvironment } from './sandbox-environment.js';

export type {
  LocalAvatarKind,
  LocalAvatarRecord,
  LocalAvatarsConfig,
} from './local-avatars.js';
export {
  DEFAULT_LOCAL_AVATARS,
  LOCAL_AVATAR_ACCEPT,
  LOCAL_AVATAR_EXTENSIONS,
  LOCAL_AVATAR_HOST,
  LOCAL_AVATAR_MIME,
  LOCAL_AVATAR_SCHEME,
  avatarIdSlug,
  avatarKindFromFileName,
  avatarLabelFromFileName,
  isSupportedAvatarFileName,
  isDeviceLocalAvatarUrl,
  localAvatarCorsHeaders,
  localAvatarFileNameFromPath,
  localAvatarUrl,
  mappedAvatarId,
  mappedLocalAvatar,
  normalizeContactMappings,
  normalizeLocalAvatarRecord,
  normalizeLocalAvatarsConfig,
  pruneContactMappings,
  removeLocalAvatar,
} from './local-avatars.js';

export type {
  AppLockSettings,
  AppLockState,
} from './app-lock.js';
export {
  DEFAULT_APP_LOCK_SETTINGS,
  LOCK_TIMEOUT_CHOICES,
  PIN_MIN_LENGTH,
  PIN_MAX_LENGTH,
} from './app-lock.js';

export type {
  LogoutChoice,
  LogoutStep,
  LogoutStepResult,
  LogoutReport,
} from './logout.js';

export type {
  WakeSettings,
  WakeWordBinding,
  WakeAgentRow,
  QueuedUtterance,
  WakeActivationMode,
  WakeCaptureMode,
  WakeUnsentPolicy,
  WakeAutoMapMode,
  WakeEngineKind,
} from './wake.js';

export type {
  CompanionAction,
  CompanionLaunch,
  CompanionMode,
  CompanionPoseContext,
  CompanionPresent,
  CompanionSessionStatus,
  CompanionSessionView,
  CompanionSttOwner,
  CompanionTitleReport,
  CompanionToolPresence,
  CompanionToolRoute,
  CompanionToolSnapshot,
  CompanionToolSync,
  SttOwnerElection,
} from './companion.js';
export { normalizePoseContext, poseToBrowserContext } from './companion.js';
export type { CountryRow, RegionRow } from '@nexus/node-core';
export type { CountryRegionResolution } from './login-region.js';

export type {
  AppVisibilityMode,
  CustomTrayApp,
  InstalledNexusApp,
  TrayAppGroup,
  TrayAppItem,
  TrayAppSettings,
} from './nexus-apps.js';
export {
  DEFAULT_TRAY_APP_SETTINGS,
  MAX_CUSTOM_TRAY_APPS,
  isSafeExternalUrl,
} from './nexus-apps.js';

export type ConnectionConfigPatch = Partial<DesktopConnectionConfig>;

/**
 * Non-secret desktop UI preferences. `locale` is validated by the renderer
 * against the locales it ships; an unknown value falls back to the OS locale.
 */
export type UiSettings = {
  locale: string | null;
  notifications: NotificationSettings;
  /**
   * Last home country picked on the login screen (ISO 3166-1 alpha-2), so the
   * picker remembers the choice the way the portal's `anx_login_country` does.
   */
  loginCountry: string | null;
  /** App PIN inactivity-lock preferences (the PIN itself is never exposed). */
  appLock: AppLockSettings;
  /** Tray "Nexus apps" visibility (allow/deny mode + custom entries). */
  trayApps: TrayAppSettings;
  /**
   * Companion 3D debug surfaces (motion feed / gesture tester / status motions /
   * walkable scene). All off by default; a developer can also force them on with
   * `?companionDebug=1` in the companion window URL.
   */
  companionDebug: CompanionDebugSettings;
  /** Companion avatar behaviour (non-debug): click nod, etc. */
  companionAvatar: CompanionAvatarSettings;
  /** Audio device preferences: primary/allowed speakers + primary/wake microphones. */
  audio: AudioSettings;
};

/**
 * Companion avatar behaviour settings (user-facing).
 */
export type CompanionAvatarSettings = {
  /** Nod (configurable gesture) when the user clicks anywhere in the companion. */
  clickNod: boolean;
  /** Gesture clip id played on click; defaults to the bundled `nod`. */
  clickNodGesture: string;
  /**
   * How far the companion's head/neck can turn toward the cursor, in degrees
   * (default 30). The backbone of head-follow liveliness: the head bone gets
   * roughly half of this, so the tight library default (20) reads as "barely
   * moves" on a companion that must track the cursor across a whole screen.
   */
  gazeYawMaxDeg: number;
  /** Head/neck pitch cone toward the cursor, in degrees (default 22). */
  gazePitchMaxDeg: number;
};

export const DEFAULT_COMPANION_AVATAR_SETTINGS: CompanionAvatarSettings = {
  clickNod: true,
  clickNodGesture: 'nod',
  gazeYawMaxDeg: 30,
  gazePitchMaxDeg: 22,
};

/** Clamp helper for the finite-degree settings below. */
function clampDegree(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Coerce a persisted/patched companion-avatar block field-by-field. */
export function normalizeCompanionAvatarSettings(raw: unknown): CompanionAvatarSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_COMPANION_AVATAR_SETTINGS };
  const rec = raw as Record<string, unknown>;
  const gesture =
    typeof rec.clickNodGesture === 'string' && rec.clickNodGesture.trim()
      ? rec.clickNodGesture.trim()
      : DEFAULT_COMPANION_AVATAR_SETTINGS.clickNodGesture;
  return {
    // Default ON: a nod on click is the expected lively default; explicit false disables.
    clickNod: rec.clickNod !== false,
    clickNodGesture: gesture,
    // Match `clampGazeLimits` bounds in character-kit so persisted values are valid there.
    gazeYawMaxDeg: clampDegree(rec.gazeYawMaxDeg, DEFAULT_COMPANION_AVATAR_SETTINGS.gazeYawMaxDeg, 10, 60),
    gazePitchMaxDeg: clampDegree(
      rec.gazePitchMaxDeg,
      DEFAULT_COMPANION_AVATAR_SETTINGS.gazePitchMaxDeg,
      8,
      40,
    ),
  };
};

/**
 * Which companion debug surfaces are visible. Everything defaults to `false` so
 * a normal companion window stays clean; the surfaces are opt-in from Settings.
 */
export type CompanionDebugSettings = {
  /** Live action-feed table (source / status / Δ / op / detail). */
  motionFeed: boolean;
  /** Gesture catalogue player (play one / play all one-shots). */
  gestureTest: boolean;
  /** Status-motion editor (thinking/writing/… clip pools). */
  statusMotions: boolean;
  /** Render the walkable SceneRoom (grid + room bounds) instead of the flat stage. */
  sceneMode: boolean;
};

export const DEFAULT_COMPANION_DEBUG_SETTINGS: CompanionDebugSettings = {
  motionFeed: false,
  gestureTest: false,
  statusMotions: false,
  sceneMode: false,
};

/**
 * A normalized OS-global cursor sample for a companion window.
 *
 * `x`/`y` are relative to the **display work area the companion sits on** —
 * `0` at the left/top edge of the screen, `1` at the right/bottom. This is a
 * stable, monitor-relative frame; the renderer re-normalizes it into a single
 * **window-anchored** gaze frame (`companionCursorToGazeNdc`) that continues to
 * the screen edge, so the aim is a pure function of the cursor position.
 *
 * `bounds` (window) and `display` (work area) are carried so the renderer can
 * build that frame without another IPC round-trip. `focused` and `withinWindow`
 * are reported for the host's information; they must **not** select a different
 * gaze frame (an earlier design did, which is what made head tracking flap
 * between two aims depending on OS focus).
 */
export type CompanionCursorCoords = {
  contactId: string;
  x: number;
  y: number;
  /** Cursor lies outside the display work area. */
  outside: boolean;
  /** Cursor lies inside the companion window bounds (reported, not frame-selecting). */
  withinWindow: boolean;
  /** Companion window currently has OS focus (reported, not frame-selecting). */
  focused: boolean;
  screenX: number;
  screenY: number;
  bounds: { x: number; y: number; width: number; height: number };
  display: { x: number; y: number; width: number; height: number };
};

/** Coerce a persisted/patched companion-debug block field-by-field. */
export function normalizeCompanionDebugSettings(raw: unknown): CompanionDebugSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_COMPANION_DEBUG_SETTINGS };
  const rec = raw as Record<string, unknown>;
  const flag = (key: keyof CompanionDebugSettings): boolean => rec[key] === true;
  return {
    motionFeed: flag('motionFeed'),
    gestureTest: flag('gestureTest'),
    statusMotions: flag('statusMotions'),
    sceneMode: flag('sceneMode'),
  };
}

/**
 * The companion right-click menu "tool" subviews that can be detached into
 * their own `BrowserWindow` (Deliverable 3). Each one is scoped to the current
 * agent/contact, never global.
 */
export type CompanionToolId = 'motion-feed' | 'gestures' | 'status-motions';

/** Every detachable companion tool, in menu order. */
export const COMPANION_TOOL_IDS: readonly CompanionToolId[] = [
  'motion-feed',
  'gestures',
  'status-motions',
];

/** Launch payload for a standalone companion tool window. */
export type CompanionToolLaunch = {
  tool: CompanionToolId;
  /** Agent/contact the tool is scoped to (its settings are per contact). */
  contactId: string;
  /** Display name of the agent, for the window title. */
  agentName?: string;
  /**
   * Conversation binding, when known. A tool window is popped out of a specific
   * conversation and resolves the *same* live session as its companion, so the
   * address rides the tool hash too (see `buildCompanionToolHash`) instead of
   * leaving the window to guess which conversation it belongs to.
   */
  conversationId?: string | null;
  agentId?: string | null;
  virtualEmployeeId?: string | null;
};

/** Coerce an unknown value into a known tool id, or `null` when unrecognised. */
export function normalizeCompanionToolId(raw: unknown): CompanionToolId | null {
  return typeof raw === 'string' && (COMPANION_TOOL_IDS as readonly string[]).includes(raw)
    ? (raw as CompanionToolId)
    : null;
}

/**
 * How a new-message OS notification is presented. The default is a full card
 * with sender + preview and no sound — a sound on every message is intrusive, so
 * it is opt-in.
 */
export type NotificationSettings = {
  /** Master switch for OS notifications while the window is unattended. */
  enabled: boolean;
  /** `full` shows the message body; `title_only` shows just the title line. */
  cardMode: 'full' | 'title_only';
  /** Include who sent the message. */
  showSender: boolean;
  /** Include the message text (ignored for `title_only`). */
  showPreview: boolean;
  /** Play the OS notification sound. Off by default. */
  sound: boolean;
  /**
   * When the app is locked (PIN gate), replace the card content with a neutral
   * notice so a locked machine cannot leak message text or the sender. On by
   * default; the user may explicitly turn it off.
   */
  suppressWhenLocked: boolean;
};

/**
 * Canonical notification-settings defaults, shared by the main process (applied
 * when reading/patching the persisted block) and the renderer (initial UI state)
 * so the two can never drift.
 */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  cardMode: 'full',
  showSender: true,
  showPreview: true,
  // Off by default: an unexpected sound is worse than a missed chime.
  sound: false,
  // On by default: a locked machine must not leak message content.
  suppressWhenLocked: true,
};

/** What the renderer reports to main about an inbound message. */
export type DesktopNotificationPayload = {
  messageId: string;
  conversationId: string | null;
  contactId: string | null;
  agentId: string | null;
  senderName: string | null;
  preview: string | null;
  title: string | null;
};

/**
 * A wake binding resolved for arming in the renderer: the engine kind, the
 * phrase, and (for `builtin`) the installed ONNX bytes. Never carries auth
 * material — a wake word cannot authenticate.
 */
export type WakeBindingResolution = {
  binding: WakeWordBinding;
  engineKind: WakeEngineKind;
  armed: boolean;
  /** Present only for a `builtin` detector whose model is installed. */
  modelBytes: Uint8Array | null;
  /**
   * Present only for a `custom_sample` detector: the decoded log-mel envelope of
   * the enrolled phrase, ready to feed the on-device detector without a fetch.
   */
  customSampleFingerprint: WakeTemplateFingerprintWire | null;
  /**
   * True for an `stt_phrase` binding: the phrase is matched against on-device
   * transcription rather than a fixed keyword model. The renderer arms an
   * STT-phrase detector and asks main to transcribe gated speech
   * (`wakeTranscribeLocal`), which never leaves the machine.
   */
  transcribeLocally: boolean;
  /** Human-safe reason when the binding cannot be armed. */
  unavailableReason: string | null;
};

/**
 * Structural, serializable mirror of `@nexus/wake-word`'s
 * `WakeTemplateFingerprint` (the arrays serialize as plain number arrays across
 * IPC). Device-local only; never leaves the machine.
 */
export type WakeTemplateFingerprintWire = {
  envelope: number[];
  frames: number;
  sampleRate: number;
  hopSamples: number;
};

/** Live state of the wake listener, for the bottom-bar indicator. */
export type WakeListenState = {
  /** Master switch from settings. */
  enabled: boolean;
  /** True while at least one detector is genuinely armed. */
  listening: boolean;
  /** Phrases currently armed, for the visualization label. */
  activePhrases: string[];
  /** Smoothed input level 0..1, for the waveform. */
  level: number;
  /**
   * The most recent on-device speech recognition result (the words the wake
   * engine actually transcribed), so the bottom bar can stream what was heard
   * and highlight the wake word inside it. Null before the first segment.
   */
  transcript: string | null;
  /** Last detection, so the UI can flash. */
  lastDetection: { phrase: string; agentId: string | null; at: number } | null;
  /**
   * True while a wake session is capturing the user's speech to an agent. Wake
   * phrase detection is suppressed for the duration so the agent's own name is
   * not treated as a new activation mid-utterance; the bottom bar shows a
   * "paused — speaking to X" state instead of "listening".
   */
  capturing: boolean;
  /** Non-fatal reason when listening is desired but not possible. */
  message: string | null;
};

/**
 * Readiness of on-device wake transcription (`stt_phrase`). Mirrors the main
 * process's `WakeSttStatus` so the settings UI can highlight the *exact* field
 * that needs configuring, and live-updates when a model or runner is installed.
 */
export type WakeSttStatus = {
  ready: boolean;
  reason: string | null;
  /** Machine-readable cause when not ready, for targeted UI guidance. */
  code: 'no_model' | 'no_runner' | 'server_failed' | 'cloud_refused' | null;
  /** The local speech model that would serve the wake, when installed. */
  modelId: string | null;
  modelLabel: string | null;
  /** True when a custom local endpoint is configured instead of a catalog model. */
  usingCustomEndpoint: boolean;
  /** True when a runnable `whisper-server` was found (managed copy or PATH). */
  runnerInstalled: boolean;
  /**
   * Threads the managed server would use. whisper.cpp defaults to 4, which idles
   * most of a CPU and made on-device transcripts feel realtime-less; surfaced so
   * the settings UI can explain the speed.
   */
  threads: number;
  /**
   * Which on-device engine would serve the wake: the faster-whisper GPU engine
   * (`faster_whisper`, effectively realtime), the CPU whisper.cpp server
   * (`whisper_cpp`), or the user's custom local endpoint (`custom`).
   */
  backend: 'whisper_cpp' | 'faster_whisper' | 'custom';
};

export type AuthState =
  | { status: 'signed_out' }
  | ({ status: 'two_factor_required' } & PasswordlessChallengeState)
  | { status: 'signed_in'; token: string; identity: AuthIdentity };

/**
 * Startup session hydration verdict (Deliverable 2). The renderer uses this to
 * choose between the signed-in shell, a retryable offline screen, and sign-in —
 * and to know *why* when it lands on sign-in.
 */
export type SessionHydrationState = {
  view: 'signed_in' | 'offline_retry' | 'signed_out';
  reason:
    | 'no_session'
    | 'corrupted'
    | 'expired'
    | 'revoked'
    | 'unauthorized'
    | 'region_unreachable'
    | 'ok';
  /** Human-safe explanation for the offline / signed-out screen. */
  message: string | null;
  /** True when the region was unreachable and the user may retry. */
  canRetry: boolean;
  /** True when a stored session existed at startup. */
  hasSession: boolean;
  /** The active token when hydrated as signed in, else null. */
  token: string | null;
  identity: AuthIdentity | null;
};

export type LoginRequest = LoginCredentials;

/**
 * An in-flight verification step. Both the password login and the passwordless
 * (email / SMS / voice) flows land here: the region returns an opaque
 * `loginToken` and the methods the account can complete with. The token never
 * reaches the renderer's storage; it only rides back on the next IPC call.
 */
export type PasswordlessChallengeState = {
  /** Opaque temporary token; main process keeps it and echoes it back. */
  loginToken: string;
  /** Which flow produced the challenge, so the UI can word itself correctly. */
  flow: 'password' | 'passwordless';
  /** Methods the account can complete with, e.g. `['email','authenticator']`. */
  methods: string[];
  /** Legacy alias for `methods`. */
  factors: string[];
  /** Masked destination copy, e.g. `{ sentTo: 'a***@example.com' }`. */
  hint?: { channelType?: string; sentTo?: string | null; methodSlug?: string };
  message?: string;
};

export type TwoFactorRequest = {
  /** Verification code (email / SMS / voice / authenticator). */
  code: string;
  /** Method to verify with; defaults to the first advertised method. */
  method?: string;
};

/** Cross-device login link ("sign in with the Nexus app"). */
export type DeviceLinkSessionStart = {
  /** Short code rendered as a QR and shown for typing. */
  userCode: string;
  /** Deep link (`assetsnexus://link?code=…`) that opens the app directly. */
  appLink: string;
  /** Web fallback: the portal approval page. */
  verificationUri: string;
  expiresAt: string;
  /** Recommended poll interval, seconds. */
  interval: number;
};

export type DeviceLinkPollOutcome =
  | { status: 'pending'; interval: number }
  | { status: 'approved'; authState: AuthState }
  | { status: 'denied' }
  | { status: 'expired' };

/** Identity / account switching (Phase 9). Serializable views of the store. */
export type IdentityRow = {
  key: string;
  kind: 'private' | 'business';
  userId: string | null;
  orgId: string | null;
  role: string | null;
  label: string;
  expiresAt: string | null;
  active: boolean;
};

export type AccountRow = {
  userId: string;
  email: string | null;
  active: boolean;
  identities: IdentityRow[];
};

export type IdentitySnapshot = {
  accounts: AccountRow[];
  accountSwitcherEnabled: boolean;
  activeUserId: string | null;
};

export type MembershipRow = {
  membershipId: string;
  orgId: string | null;
  role: string | null;
  businessEmail: string | null;
  orgName: string | null;
  /** Organisation logo (`orgLogo` from `anx.organization.membership.list`). */
  orgLogo: string | null;
};

/**
 * One chat identity session (`@nexus/chat-react` `ChatIdentitySession`).
 *
 * The chat sidebar fans `anx.communicate.conversations.list` out over every
 * stored identity so one window lists the private context and each org
 * membership, exactly like the portal. Tokens live in the main process; the
 * renderer already holds the active one, so the full set is handed over for the
 * same reason — the chat client must send each row under its own identity.
 */
export type ChatIdentityRow = {
  key: string;
  label: string;
  userId: string;
  orgId: string | null;
  role: string | null;
  deviceId: string | null;
  token: string;
  avatarUrl: string | null;
  orgLogo: string | null;
};

export type MembershipLoginStart = {
  kind: 'authenticated' | 'two_factor_required';
  orgId: string | null;
  /** Present when a challenge was issued. */
  loginToken?: string;
  methods?: string[];
  methodGroups?: { user: string[]; membership: string[] };
  hint?: { channelType?: string; sentTo?: string | null; methodSlug?: string };
  biometricApprovalRequired?: boolean;
  complianceWarnings?: Array<{ code: string; message: string }>;
};

/** Local asset-agent discovery (Phase 10). Serializable view of a LAN match. */
export type AssetAgentPeerRow = {
  contactId: string;
  assetId: string;
  name: string | null;
  host: string;
  port: number;
  routeKind: 'lan_mdns' | 'intranet';
  hostsRooms: boolean;
  fingerprint: string;
  region: string;
};

export type AssetAgentDiscoverySnapshot = {
  /** Whether the user enabled preferring the local path. */
  preferLocalEnabled: boolean;
  /** Our region, used to reject foreign peers. */
  region: string | null;
  matches: AssetAgentPeerRow[];
  rejectedForeignRegion: number;
  unmatched: number;
  scannedAt: string;
  detail?: string;
};

/** Desktop calendar (Phase 7b). Serializable view of a region calendar event. */
export type CalendarMeetingKind =
  | 'nexus'
  | 'zoom'
  | 'teams'
  | 'google_meet'
  | 'webex'
  | 'custom'
  | 'in_person';

export type CalendarEventRow = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  allDay: boolean;
  status: 'tentative' | 'confirmed' | 'cancelled';
  location: string | null;
  description: string | null;
  /** Resolved meeting provider + join target, from event metadata. */
  meetingKind: CalendarMeetingKind;
  joinUrl: string | null;
  roomId: string | null;
  /** The caller's own attendee response, when they are an attendee. */
  myStatus: 'needs_action' | 'accepted' | 'declined' | 'tentative' | null;
};

export type CalendarListInput = {
  from?: string;
  to?: string;
  limit?: number;
  includeCancelled?: boolean;
};

export type CalendarCreateInput = {
  title: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  description?: string;
  location?: string;
  /** Meeting provider; drives the metadata written to the event. */
  meetingKind?: CalendarMeetingKind;
  joinUrl?: string;
  /** Link the meeting to a conversation room (nexus-kind meetings). */
  roomId?: string;
  attendees?: Array<{ userId?: string; externalEmail?: string; displayName?: string }>;
};

export type CalendarAttendeeStatus = 'needs_action' | 'accepted' | 'declined' | 'tentative';

/** Meetings / room media view (Phase 7c/7d/11). Serializable room roster. */
export type MeetingRoomParticipantRow = {
  id: string;
  type: string;
  displayName: string | null;
  avatarUrl: string | null;
  /** Phase 7d — persisted media moderation state on the room seat. */
  muted?: boolean;
  listening?: boolean;
  videoEnabled?: boolean;
};

/**
 * Per-participant embodiment presence (Phase 11e), structurally matching
 * `@nexus/chat-core` `ParticipantPresenceV1` / `@nexus/meetings-core`
 * `MeetingPresence`. Carried for agent participants so the meeting Scene tab
 * reuses the DM VRM/gesture rail verbatim.
 */
export type MeetingRoomPresenceRow = {
  vrmUrl: string | null;
  gestureManifestUrl: string | null;
  defaultMood: string | null;
  voiceId: string | null;
  lipSyncEnabled: boolean;
  vrmValidationStatus: string | null;
  embodiment: Record<string, unknown> | null;
};

export type MeetingRoomRow = {
  id: string;
  title: string;
  type: string;
  conversationId: string | null;
  sceneId: string | null;
  participants: MeetingRoomParticipantRow[];
  /** Presence keyed by participant id (agents only, best-effort). */
  presence: Record<string, MeetingRoomPresenceRow>;
};

/**
 * Voice capabilities the desktop can actually offer (Phase 11e), so the meeting
 * voice bar disables a mode with an honest reason instead of failing at start.
 */
export type MeetingVoiceAvailability = {
  realtimeAvailable: boolean;
  cloudSttAvailable: boolean;
  cloudTtsAvailable: boolean;
  localSttAvailable: boolean;
  localTtsAvailable: boolean;
};


export type DeviceStatus = {
  registered: boolean;
  deviceId: string | null;
  /** True when a local keypair exists. */
  hasKeys: boolean;
};

export type LocalModelBackendKind = 'ollama' | 'comfyui';

/**
 * One user-configured local model instance. The user may add 0..n of these
 * (several Ollama boxes, a ComfyUI rig, …); each carries its own TLS policy so a
 * self-signed cert on their own network can be trusted explicitly.
 */
export type LocalModelBackend = {
  id: string;
  kind: LocalModelBackendKind;
  label: string;
  baseUrl: string;
  /** Disabled entries are skipped by the prober and the router. */
  enabled: boolean;
  /**
   * Relax certificate validation for this instance only. Required for a
   * self-signed `https` endpoint; never inferred, always explicit.
   */
  ignoreTls: boolean;
  /** Optional bearer token for a protected instance. */
  apiKey: string | null;
  /** Optional PEM CA bundle to trust for this instance (instead of ignoring TLS). */
  customCaPem: string | null;
};

/** How the next local job is routed across the configured instances. */
export type LocalModelsRoutingPolicy = 'first_available' | 'least_busy' | 'round_robin';

export type LocalModelHealth = 'healthy' | 'unreachable' | 'disabled' | 'checking' | 'unknown';

export type LocalModelRow = {
  id: string;
  name: string;
  sizeBytes?: number | null;
};

export type LocalModelBackendStatus = {
  backend: LocalModelBackend;
  health: LocalModelHealth;
  detail?: string;
  models: LocalModelRow[];
  /** True when the instance reports in-flight work (loaded models / queued jobs). */
  busy: boolean;
  /** Ollama: model names currently held in memory. */
  loadedModels: string[];
  checkedAt: string;
};

export type LocalModelsSnapshot = {
  backends: LocalModelBackendStatus[];
  /** Instance the next job would be routed to, given the current policy. */
  routedBackendId: string | null;
  /** Active routing policy (mirrors the persisted setting). */
  policy: LocalModelsRoutingPolicy;
};

/** The persisted instance list + routing policy (what the settings UI edits). */
export type LocalModelsConfig = {
  instances: LocalModelBackend[];
  policy: LocalModelsRoutingPolicy;
};

/** Desktop-local speech models (Phase 11e): install + run STT/TTS on-device. */
export type LocalVoiceModelKind = 'stt' | 'tts' | 'vad' | 'wake';

export type LocalVoiceInstallState =
  | 'not_installed'
  | 'downloading'
  | 'installed'
  | 'error';

export type LocalVoiceEngineState = 'unloaded' | 'loading' | 'ready' | 'error';

/** One installable / installed speech model row for the settings UI. */
export type LocalVoiceModelRow = {
  id: string;
  kind: LocalVoiceModelKind;
  label: string;
  source: 'region' | 'custom';
  /** Primary download URL (public repo), or null for a custom endpoint. */
  downloadUrl: string | null;
  /** Project / model card page (GitHub or HuggingFace) for attribution. */
  sourceUrl: string | null;
  sizeBytes: number | null;
  /** Approximate VRAM this model needs when loaded on a GPU. */
  vramGiB: number | null;
  runtime: string | null;
  licenseKeys: string[];
  installState: LocalVoiceInstallState;
  installedBytes: number;
  downloadPercent: number | null;
  error?: string | null;
};

/** Live free/total RAM + VRAM for the settings progress bars. */
export type LocalVoiceResourceSnapshot = {
  ram: { totalBytes: number; freeBytes: number } | null;
  vram: { totalBytes: number; freeBytes: number; vendor: 'nvidia' | 'amd' | 'unknown' } | null;
  vramReason: string | null;
  checkedAt: string;
};

/** Which protocol a custom (self-hosted) engine speaks. */
export type LocalVoiceProtocol =
  | 'nexus'
  | 'openai_audio'
  | 'whisper_rest'
  | 'ollama'
  | 'custom';

/** A custom self-hosted STT/TTS endpoint (advanced). */
export type LocalVoiceEndpoint = {
  kind: LocalVoiceModelKind;
  protocol: LocalVoiceProtocol;
  baseUrl: string;
  ignoreTls: boolean;
  apiKey?: string | null;
};

export type LocalVoiceSettings = {
  enabled: boolean;
  /** Seconds a local engine may idle before it is unloaded (VRAM/RAM saver). */
  idleTimeoutSeconds: number;
  /** Preferred engine per modality: cloud region inference or an on-device model. */
  sttEngine: 'cloud' | 'local';
  ttsEngine: 'cloud' | 'local';
  sttModelId: string | null;
  ttsModelId: string | null;
  customSttEndpoint: LocalVoiceEndpoint | null;
  customTtsEndpoint: LocalVoiceEndpoint | null;
  /** Acknowledge self-signed TLS for custom endpoints. */
  ignoreTlsForCustom: boolean;
  /**
   * On-device STT backend: `auto` prefers the faster-whisper GPU engine when it
   * is installed and an NVIDIA GPU is available, else the whisper.cpp CPU server.
   */
  sttBackend: SttBackend;
  /** CTranslate2 compute precision; `auto` picks the best for the device. */
  sttComputeType: SttComputeType;
};

export type LocalVoiceEngineRow = {
  id: string;
  kind: LocalVoiceModelKind;
  state: LocalVoiceEngineState;
  lastUsedAtMs: number | null;
  unloadAtMs: number | null;
  error: string | null;
};

export type LocalVoiceState = {
  settings: LocalVoiceSettings;
  resources: LocalVoiceResourceSnapshot;
  models: LocalVoiceModelRow[];
  engines: LocalVoiceEngineRow[];
  /** Directory the models install into (shown for transparency). */
  modelsDir: string;
};

export type LocalVoiceSettingsPatch = Partial<LocalVoiceSettings>;

/** On-device STT backend preference (renderer mirror of `@nexus/local-voice`). */
export type SttBackend = 'auto' | 'whisper_cpp' | 'faster_whisper';

/** CTranslate2 compute precision for the faster-whisper engine. */
export type SttComputeType = 'auto' | 'float16' | 'int8_float16' | 'int8' | 'float32';

/**
 * State of the faster-whisper GPU STT engine. It is a Python runtime, so unlike
 * the whisper.cpp binary it needs a local Python + a created virtualenv. Mirrors
 * the main process's `GpuEngineStatus`.
 */
export type GpuSttEngineStatus = {
  installed: boolean;
  /** Directory the private Python environment lives in. */
  envDir: string;
  /** The detected NVIDIA GPU, or null when none was found. */
  gpu: { name: string; memoryMiB: number; driverVersion: string | null } | null;
  /** True when the GPU has enough VRAM to be worth using. */
  gpuUsable: boolean;
  /** True when a `python3` interpreter was found to build the venv from. */
  pythonAvailable: boolean;
  /** Interpreter used, when found. */
  pythonPath: string | null;
  /** pip requirement specifiers that will be installed. */
  requirements: string[];
  state: 'missing' | 'installing' | 'installed' | 'error';
  progressPercent: number | null;
  error: string | null;
  instructions: { manualRequired: boolean; steps: string[] };
};

/**
 * State of the speech-engine runner binary (`whisper-server`) that the local
 * wake / STT engines spawn. Downloaded by the app into its data folder, or
 * resolved from an existing system install.
 */
export type VoiceBinaryStatus = {
  id: 'whisper-server';
  installed: boolean;
  /** Where a runnable binary was found. */
  source: 'managed' | 'path' | 'missing';
  path: string | null;
  installDir: string;
  /** Whether a one-click install is possible on this platform/arch. */
  canInstall: boolean;
  assetLabel: string | null;
  assetSizeBytes: number | null;
  state: 'idle' | 'downloading' | 'extracting' | 'installing' | 'error';
  downloadPercent: number | null;
  error: string | null;
  /** Honest per-OS setup steps, always shown (and used when install is impossible). */
  instructions: {
    command: string | null;
    steps: string[];
    manualRequired: boolean;
    expectsOnPath: string;
  };
};

/**
 * Local GPU runner (Phase 4): expose this machine's local model server to the
 * user's agents via BYOK, registered as `edge_gpu_sidecar`.
 */
export type LocalRunnerSettings = {
  /** Whether the loopback runner should run + be registered while signed in. */
  enabled: boolean;
  /** Upstream OpenAI-compatible local server (e.g. Ollama `http://127.0.0.1:11434`). */
  upstreamBaseUrl: string;
  /** Label shown in the model picker. */
  name: string;
  /** Advertised default model id (optional). */
  defaultModel?: string;
  /** 'user' (default) or 'org' scope for the BYOK registration. */
  scope: 'user' | 'org';
};

export type LocalRunnerState = {
  settings: LocalRunnerSettings;
  /** Runtime availability of the loopback proxy (not the upstream). */
  availability: 'stopped' | 'starting' | 'available' | 'error' | 'disabled';
  detail?: string;
  /** The `https://127.0.0.1:<port>/v1` endpoint the region is told to call. */
  endpointUrl?: string;
  /** Certificate alt names for the loopback leaf. */
  altNames?: string[];
  certFingerprint?: string;
  certNotAfter?: string;
  /** Whether the endpoint is currently registered as a BYOK provider. */
  registered: boolean;
  providerId?: string;
  wrapperId?: string;
  lastCheckedAt?: string;
};

/** Client-tool surface: workspaces + the gated shell / sandboxed fs tools. */
export type WorkspaceMode = 'read-only' | 'read-write';

export type WorkspaceRoot = {
  id: string;
  label: string;
  path: string;
  mode: WorkspaceMode;
};

export type LocalCommandVariant = {
  id: string;
  label: string;
  os: 'linux' | 'darwin' | 'win32';
  argv: string[];
  cwd?: string;
  access: 'read' | 'write';
  approval: 'auto' | 'ask';
};

export type LocalCommandSkill = {
  skillId: string;
  title: string;
  oneLiner: string;
  triggerHints: string[];
  body: string;
  suggestedTools: string[];
  commands: LocalCommandVariant[];
};

export type ToolsConfig = {
  workspaces: WorkspaceRoot[];
  localCommands: LocalCommandSkill[];
};

export type ToolInvocation = {
  name: string;
  [k: string]: unknown;
  /**
   * Which agent requested the call, and the conversation it belongs to. Sent by
   * the renderer tool bridge purely so the main process can correlate the audit
   * entry with a conversation. **These are audit metadata only** — they grant no
   * authority and are never used for policy. Both are optional; a call made
   * outside a chat turn simply records `null`.
   */
  agentId?: string | null;
  conversationId?: string | null;
};

export type ToolInvocationResult = {
  ok: boolean;
  data?: unknown;
  error?: string;
};

// ─── Client-tool audit trail (local-only, immutable by agents) ──────────────
export type {
  AuditFacet,
  AuditFacets,
  AuditFilter,
  AuditRetention,
  AuditOutcome,
  ClientToolAuditEntry,
} from './audit.js';
export {
  AUDIT_RETENTION_CHOICES,
  DEFAULT_AUDIT_RETENTION,
  BYTES_PER_MIB,
} from './audit.js';

/**
 * Read-only snapshot the audit browser renders. `retention` is the configurable
 * block; `path` is shown for transparency (main owns the file). There is
 * deliberately **no** bridge method to append/clear/trim — the store is
 * main-process only.
 */
export type AuditSnapshot = {
  entries: import('./audit.js').ClientToolAuditEntry[];
  retention: import('./audit.js').AuditRetention;
  facets: import('./audit.js').AuditFacets;
  /** Path of the append-only JSONL file (display only). */
  path: string;
  /** Retained entry count (before any UI filter). */
  total: number;
  /** Retained bytes on disk. */
  sizeBytes: number;
};

// ─── Durable chat cache (metadata only) ─────────────────────────────────────
export type {
  ChatCacheSettings,
  ChatCacheStats,
} from './chat-cache.js';
export {
  CHAT_CACHE_MAX_MIB_CHOICES,
  DEFAULT_CHAT_CACHE_MAX_BYTES,
  BYTES_PER_MIB as CHAT_CACHE_BYTES_PER_MIB,
} from './chat-cache.js';

/** Storage explorer (Phase 2): a thin, serializable view of the region data. */
export type StorageWorkspaceRow = {
  id: string;
  name: string;
  ownerUserId: string | null;
  orgId: string | null;
  memberUserIds: string[];
};

export type StorageFileRow = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
  workspaceId: string | null;
  folderId: string | null;
  encryptionTier: string;
  createdAt: string | null;
  revisionNo: number | null;
};

// ─── Phase 3: bucket revision management ────────────────────────────────────

export type StorageRevisionRow = {
  revisionNo: number;
  parentRevisionNo: number;
  sizeBytes: number;
  sha256: string;
  contentType: string;
  command: string;
  reason: string | null;
  createdAt: string | null;
};

export type StorageRevisionPage = {
  fileId: string;
  currentRevisionNo: number | null;
  sha256: string | null;
  items: StorageRevisionRow[];
  /**
   * True when the region does not serve `anx.file.revision.list`
   * (`COMMAND_NOT_FOUND`). The explorer shows an explicit "not available on
   * this region" state instead of a raw command error. Optional so older
   * preload/main builds stay compatible.
   */
  unsupported?: boolean;
  /**
   * True when the request failed at the *transport* layer (a dropped/reset
   * socket, e.g. a keep-alive race or a region restart) rather than being
   * delivered and refused. The explorer shows a clear, retryable state instead
   * of a raw `RegionAuthError: read ECONNRESET`. Enables the main-process
   * adapter to degrade gracefully without weakening real command errors.
   */
  transportFailed?: boolean;
  /** Human-readable transport failure copy; shown with the retry affordance. */
  transportMessage?: string;
};

export type StoragePage = {  items: StorageFileRow[];
  total: number | null;
  nextCursor: string | null;
  encryptionSummary: Record<string, number>;
};

export type StorageCapabilities = {
  read: boolean;
  partialWrite: boolean;
  revert: boolean;
  livePreview: boolean;
  shareLinks: boolean;
  pageDwell: boolean;
  presignPut: boolean;
  presignGet: boolean;
};

export type StorageFolderRow = {
  id: string;
  name: string;
  parentFolderId: string | null;
};

export type StorageUploadRequest = {
  workspaceId?: string;
  folderId?: string | null;
  name: string;
  contentType: string;
  /** Base64 payload (the renderer reads the file via the File API). */
  base64Data: string;
};

// ─── Phase: drag-and-drop transfer (upload queue + save/drag-out) ───────────

/**
 * How a transfer writes its bytes. `auto` prefers a streaming presign-PUT
 * request body (real byte progress); `buffer` forces the legacy
 * read-all-then-base64 command, which is honestly reported as indeterminate.
 */
export type StorageTransferMode = 'auto' | 'stream' | 'buffer';

/**
 * One file's upload. The renderer only has paths (`webUtils.getPathForFile`),
 * so main reads the bytes itself and this request carries **no** base64 payload
 * — that is what keeps hundreds of files off the renderer heap.
 */
export type StorageUploadOneRequest = {
  /** Renderer-generated id; also the key for progress + cancel. */
  transferId: string;
  workspaceId: string;
  /** Folder id to upload into; `null`/omitted means the workspace root. */
  folderId?: string | null;
  /** Workspace-relative folder prefix to materialize (`''` = target folder). */
  prefix: string;
  /** Destination file name inside the target folder. */
  name: string;
  /** Absolute source path on disk (from the OS drop). */
  absPath: string;
  contentType: string;
  sizeBytes: number;
  mode?: StorageTransferMode;
};

/** How each byte was actually delivered, so the UI can tell truth from guess. */
export type StorageTransferTransport = 'stream' | 'buffer' | 'none';

export type StorageUploadOneResult = {
  transferId: string;
  ok: boolean;
  fileId: string | null;
  transport: StorageTransferTransport;
  /** Bytes flushed to the transport (0 when the path was indeterminate). */
  sentBytes: number;
  /** True when the path could not report byte granularity. */
  indeterminate: boolean;
  cancelled: boolean;
  error?: string;
};

/** Per-file progress pushed from main while a transfer is running. */
export type StorageTransferProgress = {
  transferId: string;
  sentBytes: number;
  totalBytes: number;
  indeterminate: boolean;
};

export type StorageTransferCancelResult = { transferId: string; cancelled: boolean };

/** A resolved fetchable URL for a file (presigned GET, or the region proxy). */
export type StorageDownloadLink = { url: string; presigned: boolean };

/**
 * Real bytes for an inline image/PDF preview, fetched by main and base64-encoded
 * so the sandboxed renderer never has to reach the (cross-origin) storage host
 * itself. `contentType` is the type the response actually served, so the
 * renderer can build a correctly-typed `blob:` URL.
 */
export type StoragePreviewBytes =
  | { ok: true; base64: string; contentType: string; sizeBytes: number }
  | { ok: false; error?: string; tooLarge?: boolean };

/** Result of saving one file to a user-chosen path via the native dialog. */
export type StorageSaveResult = {
  saved: boolean;
  cancelled: boolean;
  path: string | null;
  bytes: number;
  error?: string;
};

/** One file found by recursing a dropped directory (path relative to its root). */
export type StorageDropFile = {
  path: string;
  relPath: string;
  sizeBytes: number;
};

/** One top-level entry a drop or path-list produced. */
export type StorageDropEntry = {
  path: string;
  name: string;
  isDirectory: boolean;
  /** Size for a plain file; 0 for a directory. */
  sizeBytes: number;
  /** Populated only for directories: every file found beneath it. */
  children?: StorageDropFile[];
  /** Set when a directory could not be read at all. */
  error?: string;
};

export type StorageDropExpansion = { entries: StorageDropEntry[] };

// ─── Phase 3: bucket-subdir <-> local-dir multi-sync ────────────────────────

export type StorageSyncMode = 'two-way' | 'download-only' | 'upload-only';
export type StorageSyncConflictPolicy = 'newest-wins' | 'local-wins' | 'remote-wins' | 'keep-both';

/** One bucket-subdir -> local-dir link (serializable view of SyncBinding). */
export type StorageSyncBindingRow = {
  id: string;
  name: string;
  workspaceId: string;
  workspaceName: string | null;
  remoteFolderId: string | null;
  remoteFolderPath: string;
  localDir: string;
  mode: StorageSyncMode;
  conflictPolicy: StorageSyncConflictPolicy;
  enabled: boolean;
  intervalSeconds: number;
  exclude: string[];
  createdAt: string;
  updatedAt: string;
};

export type StorageSyncBindingInput = {
  name: string;
  workspaceId: string;
  remoteFolderId?: string | null;
  remoteFolderPath?: string;
  localDir: string;
  mode?: StorageSyncMode;
  conflictPolicy?: StorageSyncConflictPolicy;
  enabled?: boolean;
  intervalSeconds?: number;
  exclude?: string[];
};

export type StorageSyncActionRow = {
  kind: string;
  relPath: string;
  reason: string;
  resolution?: string;
};

export type StorageSyncRunStatus = 'idle' | 'running' | 'ok' | 'error';

/** Result of one sync pass for one binding. */
export type StorageSyncRunResult = {
  bindingId: string;
  status: StorageSyncRunStatus;
  startedAt: string;
  finishedAt: string;
  summary: Record<string, number>;
  actions: StorageSyncActionRow[];
  conflicts: StorageSyncActionRow[];
  error?: string | null;
};

export type StorageSyncState = {
  bindings: StorageSyncBindingRow[];
  /** Last run per binding id. */
  lastRuns: Record<string, StorageSyncRunResult>;
  /** Whether the background scheduler is ticking. */
  schedulerRunning: boolean;
};

/** A remote directory entry the user can pick as a sync target. */
export type StorageRemoteFolderRow = {
  id: string;
  name: string;
  path: string;
  parentFolderId: string | null;
};

// ─── Phase 3: native mount daemon ───────────────────────────────────────────

export type MountDeliveryMode = 'kernel' | 'mirror';
export type MountStateName = 'stopped' | 'starting' | 'mounted' | 'degraded' | 'error';

export type MountSessionRow = {
  id: string;
  workspaceId: string;
  workspaceName: string | null;
  remoteFolderId: string | null;
  remoteFolderPath: string;
  mountpoint: string;
  mode: 'read-only' | 'read-write';
  delivery: MountDeliveryMode;
  state: MountStateName;
  cacheDir: string;
  journalPath: string;
  volumeName: string;
  createdAt: string;
  updatedAt: string;
  error: string | null;
};

export type MountSessionInput = {
  workspaceId: string;
  remoteFolderId?: string | null;
  remoteFolderPath?: string;
  mountpoint: string;
  mode?: 'read-only' | 'read-write';
  volumeName?: string;
  delivery?: MountDeliveryMode;
};

export type MountCapabilitiesRow = {
  platform: string;
  driver: string;
  helperPresent: boolean;
  helperPath: string | null;
  delivery: MountDeliveryMode;
  warnings: string[];
};

export type MountSnapshot = {
  capabilities: MountCapabilitiesRow;
  sessions: MountSessionRow[];
};

/**
 * Certificate trust ("trust this certificate").
 *
 * A TLS failure to the region / gateway that is *only* an untrusted certificate
 * surfaces as a prompt; the user may pin that exact certificate for that exact
 * host. Trust is a fingerprint scoped to a host — never a blanket accept.
 */
export type CertificateTrustReason =
  | 'authority-invalid'
  | 'self-signed'
  | 'name-mismatch'
  | 'expired'
  | 'unknown';

/** Certificate facts shown in the trust prompt. */
export type CertificatePromptInfo = {
  host: string;
  fingerprint: string;
  subject: string;
  issuer: string;
  validFrom: string | null;
  validTo: string | null;
  /** Chromium's verdict string, e.g. `CERT_AUTHORITY_INVALID`. */
  verificationResult: string;
  reason: CertificateTrustReason;
};

/** A persisted user trust decision (a fingerprint pinned to a host). */
export type CertificateTrustEntry = {
  host: string;
  fingerprint: string;
  subject: string;
  issuer: string;
  validFrom: string | null;
  validTo: string | null;
  trustedAt: number;
};

/** Methods exposed on `window.nexus` by the preload bridge. */
export type NexusBridge = {
  getVersion(): Promise<string>;  getConnectionConfig(): Promise<DesktopConnectionConfig>;
  setConnectionConfig(patch: ConnectionConfigPatch): Promise<DesktopConnectionConfig>;
  /** Non-secret UI preferences (locale, notifications). */
  getUiSettings(): Promise<UiSettings>;
  setUiSettings(patch: Partial<UiSettings>): Promise<UiSettings>;
  /** Current user-approved TLS certificate pins (region/gateway). */
  certTrustList(): Promise<CertificateTrustEntry[]>;
  /** Revoke a pin; omit `fingerprint` to revoke every pin for that host. */
  certTrustRevoke(host: string, fingerprint?: string): Promise<CertificateTrustEntry[]>;
  /** A TLS connection needs trust: main asks the renderer to show the prompt. */
  onCertTrustPrompt(listener: (info: CertificatePromptInfo) => void): () => void;
  /** The user's answer to the trust prompt. */
  certTrustRespond(decision: { host: string; fingerprint: string; trusted: boolean }): Promise<void>;
  /** Report an inbound chat message so main can raise an OS notification. */
  notifyIncoming(
    payload: DesktopNotificationPayload,
    opts?: { force?: boolean },
  ): Promise<void>;
  /** Subscribe to a notification click, to route the renderer to the message. */
  onNotificationActivated(
    listener: (payload: DesktopNotificationPayload) => void,
  ): () => void;
  // Wake words (on-device detection + agent mapping).
  wakeGetSettings(): Promise<WakeSettings>;
  wakeSetSettings(next: WakeSettings): Promise<WakeSettings>;
  /** Mappable agents for the wake settings picker (owned + public employees). */
  wakeListAgents(): Promise<WakeAgentRow[]>;
  /** Resolve a binding for arming, including installed model bytes. */
  wakeResolveBinding(binding: WakeWordBinding | string): Promise<WakeBindingResolution | null>;
  /** Report live listener state so the main process can track it (tray tooltip). */
  wakeReportState(state: WakeListenState): Promise<void>;
  /** A wake fired: main brings the window forward for the mapped agent. */
  wakeActivated(payload: { phrase: string; agentId: string | null }): Promise<void>;
  /** Subscribe to a wake activation routed from main (to open chat + dictate). */
  onWakeActivated(
    listener: (payload: { phrase: string; agentId: string | null }) => void,
  ): () => void;
  /** Unsubmitted wake transcripts kept for review (the `queue` unsent policy). */
  wakeGetQueue(): Promise<QueuedUtterance[]>;
  /** Replace the unsent queue (used after the user reviews/dismisses entries). */
  wakeSetQueue(queue: QueuedUtterance[]): Promise<QueuedUtterance[]>;
  /**
   * Whether a wake can transcribe on-device right now (`stt_phrase` bindings),
   * with an honest reason when it cannot. Local-only — never the region.
   */
  wakeSttStatus(): Promise<WakeSttStatus>;
  /**
   * Transcribe one wake utterance **on this machine**. Returns null when nothing
   * was recognised. Audio never leaves the device; a non-local target is refused.
   *
   * `phrases` (optional) are the currently armed wake phrases (agent names). They
   * bias the decoder so unusual proper nouns are recognized; the renderer sends
   * them because auto-mapped phrases exist only there, not in persisted settings.
   */
  wakeTranscribeLocal(input: {
    pcm: Float32Array;
    sampleRate: number;
    phrases?: string[];
  }): Promise<string | null>;
  getAuthState(): Promise<AuthState>;
  login(req: LoginRequest): Promise<AuthState>;
  submitTwoFactor(req: TwoFactorRequest): Promise<AuthState>;
  /** Re-target which enrolled method the pending challenge uses. */
  authSwitchTwoFactor(method: string): Promise<AuthState>;
  // Country/region picker (public commands; no session required).
  /** Active/preview countries for the login country picker. */
  authListCountries(): Promise<CountryRow[]>;
  /** Regions (incl. inactive) so a country can be resolved to its region. */
  authListRegions(): Promise<RegionRow[]>;
  /**
   * Sandbox vs production for the connected region (public; no session needed).
   * Mirrors the portal's `anx.config.environment` header-badge lookup. Resolves
   * to null when the region cannot be read, so the UI fails closed and never
   * blocks login.
   */
  authRegionEnvironment(): Promise<RegionEnvironment | null>;
  /** Passwordless (email / SMS / voice) code sign-in, step 1. */
  authStartPasswordless(input: { channel: PasswordlessChannel; identifier: string }): Promise<AuthState>;
  /** Passwordless code sign-in, step 2. */
  authVerifyPasswordless(input: { code: string }): Promise<AuthState>;
  /** Re-send the passwordless code, optionally switching channel. */
  authResendPasswordless(input?: { channel?: PasswordlessChannel }): Promise<AuthState>;
  /** Abandon an in-flight password / passwordless challenge. */
  authCancelChallenge(): Promise<AuthState>;
  /** Start a QR "sign in with the Nexus app" link. */
  authDeviceLinkStart(): Promise<DeviceLinkSessionStart>;
  /** Poll an in-flight link; the approved branch signs this device in. */
  authDeviceLinkPoll(): Promise<DeviceLinkPollOutcome>;
  logout(): Promise<void>;
  /**
   * Startup hydration: decide whether the stored session is still valid and what
   * the renderer should show. Never signs a user out because the network is down.
   */
  hydrateSession(): Promise<SessionHydrationState>;
  /** Subscribe to global session loss (device removed in the portal). */
  onSessionLost(listener: (loss: { reason: string; deviceRevoked: boolean; message: string }) => void): () => void;
  // App PIN lock (Deliverable 3). A UI gate only; never gates crypto or 2FA.
  appLockGetState(): Promise<AppLockState>;
  appLockSetPin(pin: string): Promise<AppLockState>;
  appLockClearPin(): Promise<AppLockState>;
  appLockUpdateSettings(patch: Partial<AppLockSettings>): Promise<AppLockState>;
  /** Record user activity so the idle timer resets. */
  appLockNoteActivity(): Promise<void>;
  /** Ask main whether the UI should lock now (idle timeout elapsed). */
  appLockEvaluate(): Promise<boolean>;
  /** Attempt to unlock with the PIN; false when it is wrong. */
  appLockUnlock(pin: string): Promise<boolean>;
  /** Lock immediately (explicit "lock now"). */
  appLockLock(): Promise<void>;
  // Logout (Deliverable 5): the two-choice flow, never leaving the user stuck.
  logoutRun(choice: LogoutChoice): Promise<LogoutReport>;
  /** Retry only the steps a previous report listed as retryable. */
  logoutRetry(steps: LogoutStep[], choice: LogoutChoice): Promise<LogoutReport>;
  getDeviceStatus(): Promise<DeviceStatus>;
  registerDevice(): Promise<DeviceStatus>;
  listLocalModels(refresh?: boolean): Promise<LocalModelsSnapshot>;
  /** Configured local model instances + the persisted routing policy. */
  localModelsGetConfig(): Promise<LocalModelsConfig>;
  /** Add or replace one instance (by id); returns the new config. */
  localModelsUpsert(instance: LocalModelBackend): Promise<LocalModelsConfig>;
  localModelsRemove(id: string): Promise<LocalModelsConfig>;
  localModelsSetPolicy(policy: LocalModelsRoutingPolicy): Promise<LocalModelsConfig>;
  /** Probe a single instance (the settings "Test" button) without persisting. */
  localModelsTest(instance: LocalModelBackend): Promise<LocalModelBackendStatus>;
  getToolsConfig(): Promise<ToolsConfig>;
  setWorkspaces(workspaces: WorkspaceRoot[]): Promise<ToolsConfig>;
  setLocalCommands(commands: LocalCommandSkill[]): Promise<ToolsConfig>;
  runTool(req: ToolInvocation): Promise<ToolInvocationResult>;
  /**
   * **Read-only** client-tool audit trail. The store is written exclusively by
   * the main process; no method here can append, clear or trim it, and no
   * agent-facing tool call can reach it. `auditSetRetention` only adjusts the
   * configurable window (main applies the trim); it is a user settings action,
   * never an agent one.
   */
  auditSnapshot(filter?: import('./audit.js').AuditFilter): Promise<AuditSnapshot>;
  /** Update the retention window; the main process re-trims immediately. */
  auditSetRetention(retention: Partial<import('./audit.js').AuditRetention>): Promise<AuditSnapshot>;
  /**
   * Durable, metadata-only chat cache. The renderer's chat panel injects this as
   * its `ChatCacheAdapter`, so a reload renders the list + thread skeletons
   * instantly while bodies are refetched via the delta. Values are opaque
   * strings; the byte bound + LRU live in the main process.
   */
  chatCacheGet(key: string): Promise<string | null>;
  chatCacheSet(key: string, value: string): Promise<void>;
  chatCacheDelete(key: string): Promise<void>;
  chatCacheKeys(): Promise<string[]>;
  /** Wipe every cached entry (logout / identity switch). */
  chatCacheClear(): Promise<void>;
  chatCacheStats(): Promise<import('./chat-cache.js').ChatCacheStats>;
  /** Persist the byte cap; main re-trims immediately and returns fresh stats. */
  chatCacheSetMaxBytes(maxBytes: number): Promise<import('./chat-cache.js').ChatCacheStats>;
  // Storage explorer (Phase 2).
  storageWorkspaces(): Promise<StorageWorkspaceRow[]>;
  storageFolderList(workspaceId: string, parentFolderId?: string | null): Promise<StorageFolderRow[]>;
  storageListFiles(input: {
    workspaceId?: string;
    folderId?: string | null;
    cursor?: string | null;
    search?: string;
    status?: string;
    limit?: number;
  }): Promise<StoragePage>;
  storageCapabilities(kind?: string): Promise<StorageCapabilities>;
  storageUpload(req: StorageUploadRequest): Promise<StorageFileRow>;
  storageDownloadUrl(fileId: string): Promise<{ url: string; presigned: boolean }>;
  // Bucket revision management (Phase 3).
  storageListRevisions(fileId: string, limit?: number): Promise<StorageRevisionPage>;
  storageRevertRevision(fileId: string, revisionNo: number): Promise<{ revertedTo: number; revisionNo: number }>;
  storageTrashFile(fileId: string): Promise<void>;
  storageRestoreFile(fileId: string): Promise<void>;
  storageRenameFile(fileId: string, newName: string): Promise<void>;
  storageMoveFile(fileId: string, targetFolderId: string | null): Promise<void>;
  // Drag-and-drop transfer: folder expansion, per-file uploads with real
  // progress, cancel, and save/drag-out. All bytes are moved by the main
  // process; the renderer only sends paths.
  storageExpandDrop(paths: string[]): Promise<StorageDropExpansion>;
  /** Upload one dropped file; resolves when it lands (or fails). */
  storageUploadOne(req: StorageUploadOneRequest): Promise<StorageUploadOneResult>;
  /** Cancel an in-flight single-file transfer; aborts the underlying request. */
  storageTransferCancel(transferId: string): Promise<StorageTransferCancelResult>;
  /** Subscribe to per-file upload progress pushed from main. */
  onStorageTransferProgress(
    listener: (progress: StorageTransferProgress) => void,
  ): () => void;
  /** Materialize a fetchable download URL (presigned GET or the proxy). */
  storageDownloadLink(fileId: string): Promise<StorageDownloadLink>;
  /** Save one file to a path chosen via the native dialog (streams to disk). */
  storageSaveFile(fileId: string, suggestedName: string): Promise<StorageSaveResult>;
  /** Pick a directory, then save many files into it (native dialog). */
  storageSaveFilesToDir(
    files: Array<{ fileId: string; name: string }>,
  ): Promise<{ saved: number; cancelled: boolean; dir: string | null }>;
  /** Stage a file into app temp storage for an OS drag-out; returns its path. */
  storagePrepareDrag(fileId: string, name: string): Promise<{ path: string | null; error?: string; name?: string }>;
  /** Start an OS drag-out of a staged file (called on `dragstart`). */
  storageStartDrag(fileId: string, name: string): Promise<void>;
  /** Clean up temp files staged for a drag-out (called on `dragend`). */
  storageReleaseDrag(fileId: string): Promise<void>;
  /** Fetch real bytes for an inline image/PDF preview (bounded; streams in main). */
  storagePreviewBytes(fileId: string): Promise<StoragePreviewBytes>;
  /**
   * Absolute OS path for a dropped `File`. Electron 32+ removed the `file.path`
   * property; `webUtils.getPathForFile` (preload-only) is the supported API and
   * is exposed here because the sandboxed renderer cannot reach `webUtils`.
   */
  getPathForFile(file: File): string;
  // Bucket-subdir <-> local-dir multi-sync (Phase 3).
  syncGetState(): Promise<StorageSyncState>;
  syncListRemoteFolders(workspaceId: string): Promise<StorageRemoteFolderRow[]>;
  syncAddBinding(input: StorageSyncBindingInput): Promise<StorageSyncState>;
  syncUpdateBinding(id: string, patch: Partial<StorageSyncBindingInput>): Promise<StorageSyncState>;
  syncRemoveBinding(id: string): Promise<StorageSyncState>;
  syncRunNow(id: string): Promise<StorageSyncRunResult>;
  syncRunAll(): Promise<StorageSyncState>;
  /** Pick a local directory via the native dialog; null when cancelled. */
  syncChooseLocalDir(): Promise<string | null>;
  // Native mount daemon (Phase 3).
  mountSnapshot(): Promise<MountSnapshot>;
  mountAddSession(input: MountSessionInput): Promise<MountSnapshot>;
  mountRemoveSession(id: string): Promise<MountSnapshot>;
  mountStartSession(id: string): Promise<MountSnapshot>;
  mountStopSession(id: string): Promise<MountSnapshot>;
  mountChooseMountpoint(): Promise<string | null>;
  // Local GPU runner (Phase 4).
  runnerGetState(): Promise<LocalRunnerState>;
  runnerSetSettings(patch: Partial<LocalRunnerSettings>): Promise<LocalRunnerState>;
  runnerStart(): Promise<LocalRunnerState>;
  runnerStop(): Promise<LocalRunnerState>;
  runnerRegister(): Promise<LocalRunnerState>;
  // Identity / account switching (Phase 9).
  identitySnapshot(): Promise<IdentitySnapshot>;
  /**
   * Every stored token-bearing identity for the active account, presented the
   * way `@nexus/chat-react` expects (`ChatIdentitySession[]`). Used to fan the
   * chat conversation list out over private + each org membership, matching the
   * portal sidebar's identity chips.
   */
  identityChatSessions(): Promise<ChatIdentityRow[]>;
  identityListMemberships(): Promise<MembershipRow[]>;
  identitySwitch(key: string): Promise<IdentitySnapshot>;
  identitySwitchAccount(userId: string): Promise<IdentitySnapshot>;
  identityLogout(key?: string): Promise<IdentitySnapshot>;
  identityStartMembership(req: { membershipId: string; businessEmail: string; password?: string }): Promise<MembershipLoginStart>;
  identityCompleteMembership(req: {
    loginToken: string;
    method: string;
    code: string;
    businessEmail?: string;
  }): Promise<IdentitySnapshot>;
  // Local asset-agent discovery (Phase 10).
  assetAgentDiscoverySnapshot(): Promise<AssetAgentDiscoverySnapshot>;
  assetAgentDiscoveryScan(): Promise<AssetAgentDiscoverySnapshot>;
  assetAgentSetPreferLocal(enabled: boolean): Promise<AssetAgentDiscoverySnapshot>;
  // Tray "Nexus apps" (Login-with-ANX installed apps + the section preview).
  /**
   * Installed Nexus apps (connected via Login with ANX) as the tray would list
   * them right now — already filtered by the persisted allow/deny settings.
   */
  trayListApps(): Promise<InstalledNexusApp[]>;
  /**
   * The resolved tray list (installed + custom), for the settings preview.
   * Never throws: an unreachable region yields the custom entries only.
   */
  trayResolvedApps(): Promise<TrayAppItem[]>;
  openExternal(url: string): Promise<void>;
  // Immersive companion window (Phase 7a).
  companionOpen(launch: CompanionLaunch): Promise<{ opened: boolean; contactId: string }>;
  companionClose(contactId: string): Promise<boolean>;
  companionList(): Promise<string[]>;
  /**
   * Report the human label a companion renderer resolved for its own window, so
   * main can apply it with `win.setTitle`.
   *
   * The launch title is only a hint captured when the window was created; the
   * renderer owns the live session, so it is the only surface that can name the
   * window once the contact/agent/room data has loaded. Without this the OS
   * caption stays the neutral `Nexus Companion` forever. Id-shaped/blank labels
   * are rejected in main. Returns false when the window is gone.
   */
  companionSetTitle(report: CompanionTitleReport): Promise<boolean>;
  /**
   * Pin / unpin a companion above other windows. Returns the applied state, or
   * `null` when no companion is open for that contact.
   */
  companionSetAlwaysOnTop(contactId: string, onTop: boolean): Promise<boolean | null>;
  /** Whether a contact's companion is currently pinned (`null` when not open). */
  companionIsAlwaysOnTop(contactId: string): Promise<boolean | null>;
  /**
   * Subscribe to OS-global cursor coordinates for the companion window.
   *
   * The main process samples the OS cursor (native X11 pointer when available)
   * while any companion is open and pushes a sample normalized to the **display
   * work area**, together with the window bounds, so the avatar's head/eye gaze
   * follows the pointer anywhere on the display — not only while it is inside the
   * window. Returns an unsubscribe fn.
   *
   * The renderer maps every sample through one continuous window-anchored gaze
   * frame (`companionCursorToGazeNdc`); `focused` / `withinWindow` are reported
   * but never select a different frame.
   */
  onCompanionGlobalCursor(
    listener: (coords: CompanionCursorCoords) => void,
  ): () => void;
  /**
   * Subscribe to a live wake activation pushed into an *open* companion window
   * (main → renderer), so a wake that resolves to companion mode hands the
   * addressed agent + conversation to the already-running window without a reload
   * (a reload would restart its live voice session). Returns an unsubscribe fn.
   */
  onCompanionPresent(listener: (payload: CompanionPresent) => void): () => void;
  /**
   * Hand a live wake activation to an *open* companion window (main hands it
   * over without a reload, so its call is not torn down). Returns false when no
   * companion is open for the contact, so the caller can fall back to
   * `companionOpen`. Used by the companion-first wake policy and the widget's
   * "open companion" link when the window already exists.
   */
  companionPresent(payload: CompanionPresent): Promise<boolean>;
  /**
   * Relay a wake-dictation session view (owner renderer → companion window) so
   * the companion strip mirrors the live turn. Returns false when no companion is
   * open for the contact.
   */
  companionPushSession(view: CompanionSessionView): Promise<boolean>;
  /**
   * Subscribe to the session view pushed for the companion strip (companion
   * renderer side). Returns an unsubscribe fn.
   */
  onCompanionSession(listener: (view: CompanionSessionView) => void): () => void;
  /**
   * Subscribe to the single-owner STT election (companion renderer side): tells
   * this window whether it currently owns the microphone. Only the primary
   * companion runs the live dictation preview / auto-answers a wake; a demoted
   * window stays in display-only mode. Returns an unsubscribe fn.
   */
  onCompanionSttOwner(listener: (message: CompanionSttOwner) => void): () => void;
  /**
   * Send a composer control (submit / cancel / send-as-voice / edit) back to the
   * window that owns the session. Returns false when no companion is open.
   */
  companionAction(action: CompanionAction): Promise<boolean>;
  /**
   * Subscribe to a companion composer control relayed from main into the
   * session-owning window. Returns an unsubscribe fn.
   */
  onCompanionActionRelay(listener: (action: CompanionAction) => void): () => void;
  /**
   * Open one companion context-menu tool in its own `BrowserWindow`, scoped to
   * the current agent/contact (its settings are per contact, never global).
   * Resolves the tool window's contact id, or `null` when it could not open.
   */
  companionOpenTool(input: CompanionToolLaunch): Promise<{ contactId: string } | null>;
  /** Close the tool windows for a contact (one tool when `tool` is given). */
  companionCloseTool(contactId: string, tool?: CompanionToolId): Promise<boolean>;
  /**
   * Subscribe to the tool-scoped state a companion window shares with its
   * detached tool windows (main → renderer), tagged with the owning contact so a
   * window ignores every other agent's state. Returns an unsubscribe fn.
   */
  onCompanionToolSnapshot(listener: (snapshot: CompanionToolSnapshot) => void): () => void;
  /**
   * Subscribe (companion window) to whether any of *its* tool windows are open,
   * so it only runs the tool-state relay loop while something is listening.
   */
  onCompanionToolPresence(listener: (presence: CompanionToolPresence) => void): () => void;
  /**
   * Push a tool-scoped state snapshot from the companion that owns a contact to
   * its open tool windows (renderer → main → windows of that contact).
   */
  companionToolPublish(snapshot: CompanionToolSnapshot): Promise<boolean>;
  /**
   * Push a status-motions edit from a detached tool window back to the owning
   * companion (window → main → the contact's companion window).
   */
  companionToolSync(sync: CompanionToolSync): Promise<boolean>;
  /**
   * Subscribe to a status-motions edit relayed from another window of the same
   * contact. Returns an unsubscribe fn.
   */
  onCompanionToolSync(listener: (sync: CompanionToolSync) => void): () => void;
  // Local VRM/GLB avatar library (Deliverable 2).
  /** Read the persisted library + the per-contact avatar mapping. */
  localAvatarsList(): Promise<LocalAvatarsConfig>;
  /**
   * Open the native file picker and import `.vrm` / `.glb` files into the
   * library. Resolves the updated config (unchanged when the user cancels).
   */
  localAvatarsPick(): Promise<LocalAvatarsConfig>;
  /** Remove a library entry (and its copied file). */
  localAvatarsRemove(id: string): Promise<LocalAvatarsConfig>;
  /** Remember (or clear, with `null`) the library avatar one agent renders with. */
  localAvatarsSetMapping(contactId: string, avatarId: string | null): Promise<LocalAvatarsConfig>;
  /**
   * Ask the main shell window to open its Settings surface (the gallery links
   * here to configure client-remembered agent ↔ avatar mappings). Resolves true
   * when the request was delivered.
   */
  openSettings(): Promise<boolean>;
  /** Subscribe to that request in the main shell window. Returns an unsubscribe fn. */
  onOpenSettings(listener: () => void): () => void;
  // Desktop calendar (Phase 7b).
  calendarListEvents(input?: CalendarListInput): Promise<CalendarEventRow[]>;
  calendarUpcoming(): Promise<CalendarEventRow[]>;
  calendarCreateEvent(input: CalendarCreateInput): Promise<CalendarEventRow>;
  calendarCancelEvent(eventId: string): Promise<void>;
  calendarRespond(eventId: string, status: CalendarAttendeeStatus): Promise<CalendarEventRow>;
  calendarOpenJoin(eventId: string): Promise<{ opened: boolean; url: string | null; roomId?: string | null }>;
  // Meetings / room media (Phase 7c/7d/11).
  meetingsGetRoom(roomId: string): Promise<MeetingRoomRow | null>;
  /** Phase 11e: voice capabilities (realtime + cloud/local STT/TTS) for the bar. */
  meetingsVoiceCapabilities(): Promise<MeetingVoiceAvailability>;
  // Desktop-local speech models (Phase 11e).
  localVoiceGetState(): Promise<LocalVoiceState>;
  localVoiceSetSettings(patch: LocalVoiceSettingsPatch): Promise<LocalVoiceState>;
  localVoiceRefreshCatalog(): Promise<LocalVoiceState>;
  localVoiceInstall(modelId: string): Promise<LocalVoiceState>;
  localVoiceCancelInstall(modelId: string): Promise<LocalVoiceState>;
  localVoiceRemove(modelId: string): Promise<LocalVoiceState>;
  localVoiceProbeResources(): Promise<LocalVoiceResourceSnapshot>;
  // Speech-engine runner binary (`whisper-server`) — the executable the local
  // STT / wake engines need, provisioned by the app so a downloaded model is
  // runnable without a manual PATH install.
  voiceBinaryStatus(): Promise<VoiceBinaryStatus>;
  voiceBinaryInstall(): Promise<VoiceBinaryStatus>;
  voiceBinaryCancelInstall(): Promise<VoiceBinaryStatus>;
  voiceBinaryRemove(): Promise<VoiceBinaryStatus>;
  // faster-whisper GPU engine: a private Python runtime for near-realtime local
  // STT on an NVIDIA GPU (status / install / cancel / remove).
  gpuSttStatus(): Promise<GpuSttEngineStatus>;
  gpuSttInstall(): Promise<GpuSttEngineStatus>;
  gpuSttCancelInstall(): Promise<GpuSttEngineStatus>;
  gpuSttRemove(): Promise<GpuSttEngineStatus>;
};

/** IPC channel names. Kept explicit so main/preload stay in sync. */
export const IPC = {
  version: 'nexus:version',
  configGet: 'nexus:config:get',
  configSet: 'nexus:config:set',
  certTrustList: 'nexus:cert-trust:list',
  certTrustRevoke: 'nexus:cert-trust:revoke',
  certTrustPrompt: 'nexus:cert-trust:prompt',
  certTrustRespond: 'nexus:cert-trust:respond',
  uiSettingsGet: 'nexus:ui-settings:get',
  uiSettingsSet: 'nexus:ui-settings:set',
  notifyIncoming: 'nexus:notify:incoming',
  notifyActivated: 'nexus:notify:activated',
  wakeGetSettings: 'nexus:wake:get-settings',
  wakeSetSettings: 'nexus:wake:set-settings',
  wakeListAgents: 'nexus:wake:list-agents',
  wakeResolveBinding: 'nexus:wake:resolve-binding',
  wakeReportState: 'nexus:wake:report-state',
  wakeActivated: 'nexus:wake:activated',
  wakeGetQueue: 'nexus:wake:get-queue',
  wakeSetQueue: 'nexus:wake:set-queue',
  wakeSttStatus: 'nexus:wake:stt-status',
  wakeTranscribeLocal: 'nexus:wake:transcribe-local',
  localModelsGetConfig: 'nexus:local-models:get-config',
  localModelsUpsert: 'nexus:local-models:upsert',
  localModelsRemove: 'nexus:local-models:remove',
  localModelsSetPolicy: 'nexus:local-models:set-policy',
  localModelsTest: 'nexus:local-models:test',
  authState: 'nexus:auth:state',
  authLogin: 'nexus:auth:login',
  authTwoFactor: 'nexus:auth:two-factor',
  authSwitchTwoFactor: 'nexus:auth:switch-two-factor',
  authListCountries: 'nexus:auth:list-countries',
  authListRegions: 'nexus:auth:list-regions',
  authRegionEnvironment: 'nexus:auth:region-environment',
  authPasswordlessStart: 'nexus:auth:passwordless-start',
  authPasswordlessVerify: 'nexus:auth:passwordless-verify',
  authPasswordlessResend: 'nexus:auth:passwordless-resend',
  authCancelChallenge: 'nexus:auth:cancel-challenge',
  authDeviceLinkStart: 'nexus:auth:device-link-start',
  authDeviceLinkPoll: 'nexus:auth:device-link-poll',
  authLogout: 'nexus:auth:logout',
  authHydrate: 'nexus:auth:hydrate',
  authSessionLost: 'nexus:auth:session-lost',
  appLockGetState: 'nexus:app-lock:get-state',
  appLockSetPin: 'nexus:app-lock:set-pin',
  appLockClearPin: 'nexus:app-lock:clear-pin',
  appLockUpdateSettings: 'nexus:app-lock:update-settings',
  appLockNoteActivity: 'nexus:app-lock:note-activity',
  appLockEvaluate: 'nexus:app-lock:evaluate',
  appLockUnlock: 'nexus:app-lock:unlock',
  appLockLock: 'nexus:app-lock:lock',
  logoutRun: 'nexus:logout:run',
  logoutRetry: 'nexus:logout:retry',
  deviceStatus: 'nexus:device:status',
  deviceRegister: 'nexus:device:register',
  localModelsList: 'nexus:local-models:list',
  toolsGet: 'nexus:tools:get',
  toolsSetWorkspaces: 'nexus:tools:set-workspaces',
  toolsSetLocalCommands: 'nexus:tools:set-local-commands',
  toolsRun: 'nexus:tools:run',
  auditSnapshot: 'nexus:audit:snapshot',
  auditSetRetention: 'nexus:audit:set-retention',
  chatCacheGet: 'nexus:chat-cache:get',
  chatCacheSet: 'nexus:chat-cache:set',
  chatCacheDelete: 'nexus:chat-cache:delete',
  chatCacheKeys: 'nexus:chat-cache:keys',
  chatCacheClear: 'nexus:chat-cache:clear',
  chatCacheStats: 'nexus:chat-cache:stats',
  chatCacheSetMaxBytes: 'nexus:chat-cache:set-max-bytes',
  storageWorkspaces: 'nexus:storage:workspaces',
  storageFolderList: 'nexus:storage:folder-list',
  storageListFiles: 'nexus:storage:list-files',
  storageCapabilities: 'nexus:storage:capabilities',
  storageUpload: 'nexus:storage:upload',
  storageDownloadUrl: 'nexus:storage:download-url',
  storageListRevisions: 'nexus:storage:list-revisions',
  storageRevertRevision: 'nexus:storage:revert-revision',
  storageTrashFile: 'nexus:storage:trash-file',
  storageRestoreFile: 'nexus:storage:restore-file',
  storageRenameFile: 'nexus:storage:rename-file',
  storageMoveFile: 'nexus:storage:move-file',
  storageExpandDrop: 'nexus:storage:expand-drop',
  storageUploadOne: 'nexus:storage:upload-one',
  storageTransferCancel: 'nexus:storage:transfer-cancel',
  storageTransferProgress: 'nexus:storage:transfer-progress',
  storageDownloadLink: 'nexus:storage:download-link',
  storageSaveFile: 'nexus:storage:save-file',
  storageSaveFilesToDir: 'nexus:storage:save-files-to-dir',
  storagePrepareDrag: 'nexus:storage:prepare-drag',
  storageStartDrag: 'nexus:storage:start-drag',
  storageReleaseDrag: 'nexus:storage:release-drag',
  storagePreviewBytes: 'nexus:storage:preview-bytes',
  syncGetState: 'nexus:sync:get-state',
  syncListRemoteFolders: 'nexus:sync:list-remote-folders',
  syncAddBinding: 'nexus:sync:add-binding',
  syncUpdateBinding: 'nexus:sync:update-binding',
  syncRemoveBinding: 'nexus:sync:remove-binding',
  syncRunNow: 'nexus:sync:run-now',
  syncRunAll: 'nexus:sync:run-all',
  syncChooseLocalDir: 'nexus:sync:choose-local-dir',
  mountSnapshot: 'nexus:mount:snapshot',
  mountAddSession: 'nexus:mount:add-session',
  mountRemoveSession: 'nexus:mount:remove-session',
  mountStartSession: 'nexus:mount:start-session',
  mountStopSession: 'nexus:mount:stop-session',
  mountChooseMountpoint: 'nexus:mount:choose-mountpoint',
  runnerGetState: 'nexus:runner:get-state',
  runnerSetSettings: 'nexus:runner:set-settings',
  runnerStart: 'nexus:runner:start',
  runnerStop: 'nexus:runner:stop',
  runnerRegister: 'nexus:runner:register',
  identitySnapshot: 'nexus:identity:snapshot',
  identityChatSessions: 'nexus:identity:chat-sessions',
  identityListMemberships: 'nexus:identity:list-memberships',
  identitySwitch: 'nexus:identity:switch',
  identitySwitchAccount: 'nexus:identity:switch-account',
  identityLogout: 'nexus:identity:logout',
  identityStartMembership: 'nexus:identity:start-membership',
  identityCompleteMembership: 'nexus:identity:complete-membership',
  assetAgentSnapshot: 'nexus:asset-agent:snapshot',
  assetAgentScan: 'nexus:asset-agent:scan',
  assetAgentSetPreferLocal: 'nexus:asset-agent:set-prefer-local',
  trayAppsList: 'nexus:tray-apps:list',
  trayAppsResolved: 'nexus:tray-apps:resolved',
  companionOpen: 'nexus:companion:open',
  companionClose: 'nexus:companion:close',
  companionList: 'nexus:companion:list',
  /**
   * Companion renderer → main title report (`win.setTitle`). The launch title is
   * frozen at create time, so the renderer pushes the label it resolved from the
   * live session here and main re-applies the OS caption.
   */
  companionTitle: 'nexus:companion:title',
  companionSetAlwaysOnTop: 'nexus:companion:set-always-on-top',
  companionIsAlwaysOnTop: 'nexus:companion:is-always-on-top',
  /**
   * Live wake activation pushed into an open companion (main → renderer) so a
   * wake addressing an agent whose companion is already up foregrounds it and
   * hands it the dictation surface without reloading (a reload would restart the
   * live voice call).
   */
  companionPresent: 'nexus:companion:present',
  /**
   * Renderer → main request to deliver that activation to an open companion
   * (distinct from the push channel above so an invoke and a broadcast never
   * share a name). Resolves false when no companion is open for the contact.
   */
  companionPresentRequest: 'nexus:companion:present-request',
  /**
   * Wake-dictation session view pushed into a companion (main → companion
   * renderer) so its STT preview + composer mirror the live turn owned by the
   * main renderer.
   */
  companionSession: 'nexus:companion:session',
  /**
   * Renderer → main relay of a session view (main renderer → companion window),
   * so the capture owner stays the single writer of the session.
   */
  companionPushSession: 'nexus:companion:push-session',
  /**
   * Single-owner STT election pushed into a companion (main → companion
   * renderer). Exactly one surface may capture the mic; when a wake or a focus
   * change moves ownership, every open companion is told whether it is primary,
   * so a demoted window can relinquish the mic instead of competing.
   */
  companionSttOwner: 'nexus:companion:stt-owner',
  /**
   * Companion → main relay of a composer control (submit / cancel / send-as-voice
   * / edit). Main forwards it to the window that owns the session.
   */
  companionAction: 'nexus:companion:action',
  /** Main → capture-owner relay of a companion composer control. */
  companionActionRelay: 'nexus:companion:action-relay',
  /** Push OS-global cursor samples to a companion window (main → renderer). */
  companionGlobalCursor: 'nexus:companion:global-cursor',
  /**
   * Open one companion context-menu tool ("Motion feed" / "Gestures" /
   * "Status motions") in its own `BrowserWindow`, scoped to the current
   * agent/contact. Renderer → main invoke; resolves the window's contact id
   * (or null when it could not open).
   */
  companionOpenTool: 'nexus:companion:open-tool',
  /** Close a previously opened tool window (all tools for a contact, or one). */
  companionCloseTool: 'nexus:companion:close-tool',
  /**
   * Tool-scoped state for detached companion tool windows (Deliverable 3).
   * `snapshot` (main → window) carries the owning contact's status motions;
   * `publish`/`sync` carry the same state the other way, and `sync` is what a
   * tool window uses to write a status-motions edit back to its companion.
   */
  companionToolSnapshot: 'nexus:companion:tool-snapshot',
  companionToolPublish: 'nexus:companion:tool-publish',
  companionToolSync: 'nexus:companion:tool-sync',
  /** Main → companion: whether any of its tool windows are currently open. */
  companionToolPresence: 'nexus:companion:tool-presence',
  /**
   * Local VRM/GLB library (Deliverable 2). `list` reads the persisted library
   * plus the per-contact mapping, `pick` opens the native file dialog and copies
   * the chosen file into the library, `remove` deletes an entry, and
   * `set-mapping` remembers which library avatar one agent renders with.
   */
  localAvatarsList: 'nexus:local-avatars:list',
  localAvatarsPick: 'nexus:local-avatars:pick',
  localAvatarsRemove: 'nexus:local-avatars:remove',
  localAvatarsSetMapping: 'nexus:local-avatars:set-mapping',
  /** Companion/child window → main shell: open the Settings surface. */
  openSettings: 'nexus:shell:open-settings',
  calendarListEvents: 'nexus:calendar:list-events',
  calendarUpcoming: 'nexus:calendar:upcoming',
  calendarCreateEvent: 'nexus:calendar:create-event',
  calendarCancelEvent: 'nexus:calendar:cancel-event',
  calendarRespond: 'nexus:calendar:respond',
  calendarOpenJoin: 'nexus:calendar:open-join',
  meetingsGetRoom: 'nexus:meetings:get-room',
  meetingsVoiceCapabilities: 'nexus:meetings:voice-capabilities',
  localVoiceState: 'nexus:local-voice:state',
  localVoiceSetSettings: 'nexus:local-voice:set-settings',
  localVoiceRefreshCatalog: 'nexus:local-voice:refresh-catalog',
  localVoiceInstall: 'nexus:local-voice:install',
  localVoiceCancelInstall: 'nexus:local-voice:cancel-install',
  localVoiceRemove: 'nexus:local-voice:remove',
  localVoiceProbeResources: 'nexus:local-voice:probe-resources',
  voiceBinaryStatus: 'nexus:voice-binary:status',
  voiceBinaryInstall: 'nexus:voice-binary:install',
  voiceBinaryCancelInstall: 'nexus:voice-binary:cancel-install',
  voiceBinaryRemove: 'nexus:voice-binary:remove',
  gpuSttStatus: 'nexus:gpu-stt:status',
  gpuSttInstall: 'nexus:gpu-stt:install',
  gpuSttCancelInstall: 'nexus:gpu-stt:cancel-install',
  gpuSttRemove: 'nexus:gpu-stt:remove',
  openExternal: 'nexus:open-external',
} as const;
