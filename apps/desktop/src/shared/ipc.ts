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
  openExternal: 'nexus:open-external',
} as const;
