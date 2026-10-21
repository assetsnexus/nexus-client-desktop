/**
 * IPC contract between the Electron main process and the renderer.
 *
 * The renderer is sandboxed (contextIsolation on, nodeIntegration off) and only
 * sees the narrow surface exposed by the preload bridge. Types here are shared
 * by main, preload, and renderer so the contract stays in one place.
 */

import type { AuthIdentity, DesktopConnectionConfig, LoginCredentials } from '@nexus/node-core';

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
};

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
  openExternal: 'nexus:open-external',
} as const;
