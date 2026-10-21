/**
 * IPC contract between the Electron main process and the renderer.
 *
 * The renderer is sandboxed (contextIsolation on, nodeIntegration off) and only
 * sees the narrow surface exposed by the preload bridge. Types here are shared
 * by main, preload, and renderer so the contract stays in one place.
 */

import type { AuthIdentity, DesktopConnectionConfig, LoginCredentials } from '@nexus/node-core';
import type { CompanionLaunch } from './companion.js';

export type { CompanionLaunch, CompanionMode } from './companion.js';

export type ConnectionConfigPatch = Partial<DesktopConnectionConfig>;

export type AuthState =
  | { status: 'signed_out' }
  | { status: 'two_factor_required'; authRequestId: string; factors: string[]; message?: string }
  | { status: 'signed_in'; token: string; identity: AuthIdentity };

export type LoginRequest = LoginCredentials;

export type TwoFactorRequest = {
  authRequestId: string;
  code?: string;
  factor?: string;
};

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

export type LocalModelBackend = {
  id: string;
  kind: LocalModelBackendKind;
  label: string;
  baseUrl: string;
  /** Disabled entries are placeholders (e.g. ComfyUI preview). */
  enabled: boolean;
};

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
  checkedAt: string;
};

export type LocalModelsSnapshot = {
  backends: LocalModelBackendStatus[];
};

/** Desktop-local speech models (Phase 11e): install + run STT/TTS on-device. */
export type LocalVoiceModelKind = 'stt' | 'tts';

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
};

export type ToolInvocationResult = {
  ok: boolean;
  data?: unknown;
  error?: string;
};

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

export type StoragePage = {
  items: StorageFileRow[];
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

/** Methods exposed on `window.nexus` by the preload bridge. */
export type NexusBridge = {
  getVersion(): Promise<string>;
  getConnectionConfig(): Promise<DesktopConnectionConfig>;
  setConnectionConfig(patch: ConnectionConfigPatch): Promise<DesktopConnectionConfig>;
  getAuthState(): Promise<AuthState>;
  login(req: LoginRequest): Promise<AuthState>;
  submitTwoFactor(req: TwoFactorRequest): Promise<AuthState>;
  logout(): Promise<void>;
  getDeviceStatus(): Promise<DeviceStatus>;
  registerDevice(): Promise<DeviceStatus>;
  listLocalModels(refresh?: boolean): Promise<LocalModelsSnapshot>;
  getToolsConfig(): Promise<ToolsConfig>;
  setWorkspaces(workspaces: WorkspaceRoot[]): Promise<ToolsConfig>;
  setLocalCommands(commands: LocalCommandSkill[]): Promise<ToolsConfig>;
  runTool(req: ToolInvocation): Promise<ToolInvocationResult>;
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
  storageTrashFile(fileId: string): Promise<void>;
  storageRestoreFile(fileId: string): Promise<void>;
  storageRenameFile(fileId: string, newName: string): Promise<void>;
  storageMoveFile(fileId: string, targetFolderId: string | null): Promise<void>;
  // Local GPU runner (Phase 4).
  runnerGetState(): Promise<LocalRunnerState>;
  runnerSetSettings(patch: Partial<LocalRunnerSettings>): Promise<LocalRunnerState>;
  runnerStart(): Promise<LocalRunnerState>;
  runnerStop(): Promise<LocalRunnerState>;
  runnerRegister(): Promise<LocalRunnerState>;
  // Identity / account switching (Phase 9).
  identitySnapshot(): Promise<IdentitySnapshot>;
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
  openExternal(url: string): Promise<void>;
  // Immersive companion window (Phase 7a).
  companionOpen(launch: CompanionLaunch): Promise<{ opened: boolean; contactId: string }>;
  companionClose(contactId: string): Promise<boolean>;
  companionList(): Promise<string[]>;
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
  localVoiceProbeResources(): Promise<LocalVoiceResourceSnapshot>;};

/** IPC channel names. Kept explicit so main/preload stay in sync. */
export const IPC = {
  version: 'nexus:version',
  configGet: 'nexus:config:get',
  configSet: 'nexus:config:set',
  authState: 'nexus:auth:state',
  authLogin: 'nexus:auth:login',
  authTwoFactor: 'nexus:auth:two-factor',
  authLogout: 'nexus:auth:logout',
  deviceStatus: 'nexus:device:status',
  deviceRegister: 'nexus:device:register',
  localModelsList: 'nexus:local-models:list',
  toolsGet: 'nexus:tools:get',
  toolsSetWorkspaces: 'nexus:tools:set-workspaces',
  toolsSetLocalCommands: 'nexus:tools:set-local-commands',
  toolsRun: 'nexus:tools:run',
  storageWorkspaces: 'nexus:storage:workspaces',
  storageFolderList: 'nexus:storage:folder-list',
  storageListFiles: 'nexus:storage:list-files',
  storageCapabilities: 'nexus:storage:capabilities',
  storageUpload: 'nexus:storage:upload',
  storageDownloadUrl: 'nexus:storage:download-url',
  storageTrashFile: 'nexus:storage:trash-file',
  storageRestoreFile: 'nexus:storage:restore-file',
  storageRenameFile: 'nexus:storage:rename-file',
  storageMoveFile: 'nexus:storage:move-file',
  runnerGetState: 'nexus:runner:get-state',
  runnerSetSettings: 'nexus:runner:set-settings',
  runnerStart: 'nexus:runner:start',
  runnerStop: 'nexus:runner:stop',
  runnerRegister: 'nexus:runner:register',
  identitySnapshot: 'nexus:identity:snapshot',
  identityListMemberships: 'nexus:identity:list-memberships',
  identitySwitch: 'nexus:identity:switch',
  identitySwitchAccount: 'nexus:identity:switch-account',
  identityLogout: 'nexus:identity:logout',
  identityStartMembership: 'nexus:identity:start-membership',
  identityCompleteMembership: 'nexus:identity:complete-membership',
  assetAgentSnapshot: 'nexus:asset-agent:snapshot',
  assetAgentScan: 'nexus:asset-agent:scan',
  assetAgentSetPreferLocal: 'nexus:asset-agent:set-prefer-local',
  companionOpen: 'nexus:companion:open',
  companionClose: 'nexus:companion:close',
  companionList: 'nexus:companion:list',
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
  openExternal: 'nexus:open-external',
} as const;
