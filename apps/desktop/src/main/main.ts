/**
 * Electron main process.
 *
 * Owns the native shell: window lifecycle, connection settings, secure storage,
 * region auth/device session, local-model detection, and the IPC surface the
 * sandboxed renderer consumes through the preload bridge.
 */

import { existsSync, createReadStream, statSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { Readable } from 'node:stream';
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, nativeImage, Notification, protocol, screen, session, shell, Tray } from 'electron';
import {
  DESKTOP_APP_ID,
  certificateFingerprints,
  connectionPatchFromEnv,
  createNodeFetch,
  loadDotenvFile,
  looksLikePemCertificate,
  resolveEnvFilePath,
  type AuthClientOptions,
  type DesktopConnectionConfig,
} from '@nexus/node-core';
import { createCertificateVerifyProc } from './custom-ca.js';
import {
  createCertPromptBridge,
  createCertTrustStore,
  type CertPromptInfo,
} from './trusted-certs.js';
import {
  createSenderGuard,
  hardenWebContents,
  installPermissionGuard,
  installSenderGuard,
  type SessionLike,
} from './ipc-guard.js';
import { createSettingsStore } from './settings-store.js';
import { SafeStorageStore } from './secure-store.js';
import { createAuthManager } from './auth-manager.js';
import { readRegionEnvironment } from './region-environment.js';
import { probeBackend, probeLocalModels } from './local-models.js';
import { createLocalModelsStore } from './local-models-store.js';
import { createToolsStore } from './tools-store.js';
import { createLogger } from './logger.js';
import { createAuditStore } from './audit-store.js';
import { createChatCacheStore } from './chat-cache-store.js';
import { createToolAuditor } from './tool-audit.js';
import { filterAuditEntries, auditFacets } from '../shared/audit.js';
import { createStorageManager } from './storage-manager.js';
import { createStorageTransferManager } from './storage-transfer-manager.js';
import { createSyncManager } from './sync-manager.js';
import { createMountDaemon } from './mount-daemon.js';
import { createRunnerManager } from './runner-manager.js';
import { createIdentityManager } from './identity-manager.js';
import { createAssetAgentDiscoveryManager } from './asset-agent-discovery.js';
import { createAppLockManager } from './app-lock.js';
import { createLogoutManager } from './logout-manager.js';
import { createNexusAppsProvider } from './nexus-apps.js';
import { buildTrayMenu } from './tray-menu.js';
import { createBonjourBackend } from './mdns-bonjour.js';
import { createCompanionWindowManager, defaultCompanionPreloadPath } from './companion-window.js';
import { createGlobalCursorTracker } from './global-cursor.js';
import { createLocalAvatarStore } from './local-avatar-store.js';
import {
  LOCAL_AVATAR_EXTENSIONS,
  LOCAL_AVATAR_HOST,
  LOCAL_AVATAR_MIME,
  LOCAL_AVATAR_SCHEME,
  localAvatarCorsHeaders,
  localAvatarFileNameFromPath,
  normalizeCompanionToolId,
  type CompanionToolLaunch,
} from '../shared/ipc.js';
import { createGlobalPointerSource } from './global-pointer.js';
import { createCalendarManager } from './calendar-manager.js';
import { createMeetingsManager } from './meetings-manager.js';
import { createLocalVoiceManager } from './local-voice-manager.js';
import { pickDisplaySource } from './display-media.js';
import {
  createNotificationManager,
  type NotificationPayload,
} from './notifications.js';
import { createWakeHost } from './wake-host.js';
import { createWakeStt } from './wake-stt.js';
import { createVoiceBinaryManager } from './voice-binaries.js';
import { createGpuSttEngine } from './gpu-stt-engine.js';
import { FASTER_WHISPER_DEFAULT_PORT } from '@nexus/local-voice';
import { normalizeWakeBinding, wakeRaisesMainWindow } from '../shared/wake.js';
import { createWakeManager } from './wake-manager.js';
import { createWakeAgentDirectory } from './wake-agents.js';
import {
  IPC,
  type AppLockSettings,
  type AuditSnapshot,
  type CalendarAttendeeStatus,
  type CalendarCreateInput,
  type CalendarListInput,
  type CertificatePromptInfo,
  type CertificateTrustEntry,
  type CompanionAction,
  type CompanionLaunch,
  type CompanionPresent,
  type CompanionSessionView,
  type CompanionTitleReport,
  type CompanionToolSnapshot,
  type CompanionToolSync,
  type ConnectionConfigPatch,
  type LocalRunnerSettings,
  type LoginRequest,
  type LogoutChoice,
  type LogoutStep,
  type StorageUploadRequest,
  type StorageUploadOneRequest,
  type ToolInvocation,
  type TwoFactorRequest,
  type UiSettings,
} from '../shared/ipc.js';
import {
  isSafeExternalUrl,
  resolveTrayApps,
  type InstalledNexusApp,
  type TrayAppItem,
} from '../shared/nexus-apps.js';
// The main + preload bundles are emitted as CJS (see scripts/build-main.mjs /
// dev.mjs), so `import.meta.url` is empty and unusable here. Node's CJS loader
// provides `__dirname` for the running `dist-electron/main.cjs`, which is the
// directory both the dev renderer URL and the packaged preload path resolve against.
const __dirname_ = __dirname;
const isDev = !app.isPackaged;

/**
 * Register the `nexus-avatar:` scheme as privileged **before** the app is ready.
 *
 * The renderer loads library models with `fetch()` (the character kit's own
 * `loadCachedGltf` path). A plain `file://` URL works once packaged but not in
 * dev, where the renderer's origin is the Vite http server and Chromium refuses
 * a `file:` fetch from it. Marking the scheme `standard` + `secure` +
 * `supportFetchAPI` + `corsEnabled` makes the same `nexus-avatar://avatar/<id>`
 * URL resolve in both layouts without widening the renderer's origin. Must be
 * called at module load — `protocol.handle` itself is installed once ready.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: LOCAL_AVATAR_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

/**
 * Serve one library file for `nexus-avatar://avatar/<id>.<vrm|glb>`.
 *
 * The path is reduced to a single `<id>.<ext>` segment (`localAvatarFileNameFromPath`
 * rejects `..`/separators) and then joined under the store's own library
 * directory, so a crafted URL can never read outside it. The response is a
 * streamed `Readable` (Electron's `protocol.handle` contract) with
 * `Content-Length` so the kit's progress bar reports real bytes.
 *
 * Every response — including the error paths — carries the CORS headers from
 * {@link localAvatarCorsHeaders}: the renderer fetches from a different origin
 * (the dev http server / the packaged `file://`), so without
 * `Access-Control-Allow-Origin` Chromium reports a bare `Failed to fetch` and
 * the model never loads (the scheme is registered `corsEnabled`). An `OPTIONS`
 * preflight is answered directly, since a browser may preflight the GET.
 */
function installLocalAvatarProtocol(): void {
  protocol.handle(LOCAL_AVATAR_SCHEME, (request) => {
    try {
      const origin = request.headers.get('Origin');
      const cors = localAvatarCorsHeaders(origin);
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: cors });
      }
      const url = new URL(request.url);
      if (url.hostname !== LOCAL_AVATAR_HOST) {
        return new Response('not found', { status: 404, headers: cors });
      }
      const fileName = localAvatarFileNameFromPath(url.pathname);
      if (!fileName) return new Response('not found', { status: 404, headers: cors });
      const filePath = join(localAvatarStore.libraryDir(), fileName);
      if (!existsSync(filePath)) {
        return new Response('not found', { status: 404, headers: cors });
      }
      const { size } = statSync(filePath);
      const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>;
      return new Response(stream, {
        status: 200,
        headers: {
          ...cors,
          'Content-Type': LOCAL_AVATAR_MIME,
          'Content-Length': String(size),
        },
      });
    } catch {
      return new Response('bad request', { status: 400, headers: localAvatarCorsHeaders() });
    }
  });
}

/**
 * Window / taskbar icon.
 *
 * electron-builder derives the packaged .ico/.icns from `build/icon.png` (see
 * electron-builder.yml), but that only brands the installer and the OS-level
 * shortcut. The running window and the Linux taskbar entry read the icon we
 * hand to the window at runtime, so resolve `build/window-icon.png` for both
 * layouts:
 *   - packaged: `build/` is not shipped inside the asar, so use the
 *     extraResource copy electron-builder places next to the app bundle.
 *   - dev: read the source file from the repo.
 *
 * Kept at 128px on purpose: X11 silently drops `_NET_WM_ICON` entries of 256px
 * and above, so handing it the 1024px builder master leaves the taskbar
 * unbranded. Returns undefined when the file is absent, which makes Electron
 * fall back to its default icon rather than throwing.
 */
function resolveWindowIcon(): string | undefined {
  const candidates = isDev
    ? [join(__dirname_, '../build/window-icon.png')]
    : [join(process.resourcesPath, 'window-icon.png')];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const settings = createSettingsStore();

/**
 * User-approved TLS certificate pins ("trust this certificate") + the prompt
 * coalescer that asks the user before anything is trusted. Both are main-process
 * only; the renderer sees them through the narrow IPC surface below.
 */
const certTrustStore = createCertTrustStore();
const certPrompt = createCertPromptBridge({
  store: certTrustStore,
  confirm: (info) => askTrustCertificate(info),
  // A new pin must re-pin the session so Chromium re-runs verification (its
  // verify-proc result is cached) and the retried request succeeds.
  onChanged: () => void applyCustomCa(settings.getConnectionConfig()),
});

/**
 * Ask the user whether to trust a presented certificate. Prefers the in-window
 * renderer prompt (rich certificate details + explicit action) and falls back to
 * a native main-process dialog when no window is available. Resolves true only on
 * explicit approval, false on cancel / dismiss / any error.
 */
async function askTrustCertificate(info: CertPromptInfo): Promise<boolean> {
  const win = mainWindow;
  if (win && !win.isDestroyed()) {
    return new Promise<boolean>((resolve) => {
      const payload: CertificatePromptInfo = { ...info };
      const settle = (trusted: boolean) => {
        certTrustPending = null;
        resolve(trusted);
      };
      certTrustPending = { host: info.host, fingerprint: info.fingerprint, settle };
      try {
        win.webContents.send(IPC.certTrustPrompt, payload);
      } catch {
        settle(false);
        return;
      }
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
  }
  try {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Cancel', 'Trust this certificate'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Untrusted certificate',
      message: `The connection to ${info.host} presented a certificate that is not trusted.`,
      detail: [
        info.subject ? `Subject: ${info.subject}` : '',
        info.issuer ? `Issuer: ${info.issuer}` : '',
        info.validTo ? `Valid to: ${info.validTo}` : '',
        `SHA-256: ${info.fingerprint}`,
        '',
        'Only trust this if the server is your own. Trusting a certificate you do not recognise could let a third party read or change your traffic.',
      ]
        .filter(Boolean)
        .join('\n'),
    });
    return response === 1;
  } catch {
    return false;
  }
}

/** The trust prompt awaiting a renderer answer (null when none is open). */
let certTrustPending: {
  host: string;
  fingerprint: string;
  settle: (trusted: boolean) => void;
} | null = null;

/**
 * Structured local logging + the client-tool audit store (both main-process
 * only). The log lands at `<userData>/logs/desktop.log`; the append-only audit
 * JSONL at `<userData>/audit/client-tools.jsonl`. `userData` is available once
 * the app module is loaded, which it is here.
 */
const dataDir = app.getPath('userData');
const logger = createLogger({ dir: join(dataDir, 'logs'), minLevel: isDev ? 'debug' : 'info' });
const auditStore = createAuditStore({
  filePath: join(dataDir, 'audit', 'client-tools.jsonl'),
  logger,
});
// Audit sink wired at the tool choke point. The store is passed in (never the
// renderer), so nothing an agent can reach can read, mutate or truncate it.
const toolAuditor = createToolAuditor({ audit: auditStore, logger });
// Durable, metadata-only chat cache (conversation list + short turn previews).
// The renderer's chat panel injects it as its `ChatCacheAdapter`; the byte bound
// is user-configurable from Settings and defaults to 100 MiB.
const chatCacheStore = createChatCacheStore({
  filePath: join(dataDir, 'chat-cache', 'chat-cache.json'),
  logger,
});

/**
 * Redirect the client at a locally-running region node + portal for testing.
 *
 * Reads `NEXUS_*` values from a `.env` (see `resolveEnvFilePath`), with real
 * shell environment variables taking precedence. This runs before the window
 * exists and only *adds* the keys the environment supplied, so a developer's
 * saved settings are untouched when no `.env` is present — shipping builds with
 * no `.env` behave exactly as before.
 */
function applyEnvConnectionOverrides(): void {
  const envPath = resolveEnvFilePath({
    envFileVar: process.env.NEXUS_ENV_FILE ?? null,
    appPath: app.getAppPath(),
    mainDir: __dirname_,
    cwd: process.cwd(),
  });
  if (!envPath) return;
  const fileEnv = loadDotenvFile(envPath);
  const patch = connectionPatchFromEnv(fileEnv);
  if (Object.keys(patch).length === 0) return;
  try {
    const applied = settings.setConnectionConfig(patch);
    console.log(
      `[env] connection overrides applied from ${envPath}: region=${applied.regionUrl} portal=${applied.portalUrl}`,
    );
  } catch (error) {
    // A malformed URL in .env must not stop the app from booting; the user can
    // still fix it in settings.
    console.warn('[env] ignoring invalid connection override:', error);
  }
}

const secureStore = new SafeStorageStore();
const toolsStore = createToolsStore();
const storageManager = createStorageManager({
  getSender: () => getAuthManager().createSender(),
  getRegionUrl: () => settings.getConnectionConfig().regionUrl,
  fetchFn: regionFetch(),
});
// Drag-and-drop transfer: folder expansion, per-file uploads with real byte
// progress (streamed presign-PUT), cancel, save-to-disk and OS drag-out. The
// renderer only sends paths; all file IO stays in the main process.
const storageTransfer = createStorageTransferManager({
  getSender: () => getAuthManager().createSender(),
  getRegionUrl: () => settings.getConnectionConfig().regionUrl,
  getWebContents: () => mainWindow?.webContents ?? null,
  getTls: () => {
    const cfg = settings.getConnectionConfig();
    return { caPem: cfg.customCaPem ?? null, allowInsecure: (cfg as { allowInsecure?: boolean }).allowInsecure === true };
  },
  fetchFn: regionFetch(),
});
// Phase 3: link bucket sub-dirs to local dirs, multiple syncs at once.
const syncManager = createSyncManager({
  getSender: () => getAuthManager().createSender(),
  getRegionUrl: () => settings.getConnectionConfig().regionUrl,
  fetchFn: regionFetch(),
});
// Phase 3: mount a bucket sub-dir as a local directory (kernel helper or mirror).
const mountDaemon = createMountDaemon({
  getSender: () => getAuthManager().createSender(),
  getRegionUrl: () => settings.getConnectionConfig().regionUrl,
  getToken: () => getAuthManager().getToken(),
  fetchFn: regionFetch(),
});
const runnerManager = createRunnerManager({
  secureStore,
  getSender: () => getAuthManager().createSender(),
});
const identityManager = createIdentityManager({
  getSender: () => getAuthManager().createSender(),
});

/**
 * App PIN inactivity lock (Deliverable 3). A **UI gate only**: it hides the
 * renderer behind a PIN after idle time; it never blocks a command, a region
 * call or biometric/2FA. The PIN is salted-hashed in the secure store and is
 * cleared by any sign-out / switch-user / permanent-logout (the recovery path),
 * so the user can never be permanently locked out.
 */
const appLockManager = createAppLockManager({
  secureStore,
  getSettings: () => settings.getUiSettings().appLock,
  setSettings: (patch) => settings.setUiSettings({ appLock: { ...settings.getUiSettings().appLock, ...patch } }).appLock,
});
// Phase 10: LAN/intranet asset-agent discovery. Contacts come from the region's
// asset-agent list; the region slug comes from the region directory.
const assetAgentDiscovery = createAssetAgentDiscoveryManager({
  backend: createBonjourBackend(),
  resolveRegion: async () => {
    try {
      const sender = await getAuthManager().createSender();
      const result = await sender.send('anx.region.node.info', {});
      const managed = (result as { data?: { managedRegions?: Array<{ slug?: string }> } }).data
        ?.managedRegions;
      return managed?.find((r) => r.slug)?.slug ?? null;
    } catch {
      return null;
    }
  },
  getContacts: async () => {
    try {
      const sender = await getAuthManager().createSender();
      const result = await sender.send('anx.communicate.contacts.asset-agents.list', {});
      const rows =
        (result as { data?: { contacts?: unknown[]; assetAgents?: unknown[] } }).data?.assetAgents ??
        (result as { data?: { contacts?: unknown[]; assetAgents?: unknown[] } }).data?.contacts ??
        [];
      return (Array.isArray(rows) ? rows : []).flatMap((row) => {
        const r = row as { assetId?: string; assetAgentKey?: string; agentKey?: string; name?: string; id?: string };
        if (!r?.assetId) return [];
        const key = r.assetAgentKey ?? r.agentKey ?? '';
        return [{ id: r.id ?? `${r.assetId}:${key}`, assetId: r.assetId, agentKey: key, name: r.name ?? null }];
      });
    } catch {
      return [];
    }
  },
});

let mainWindow: BrowserWindow | null = null;
let authManager: ReturnType<typeof createAuthManager> | null = null;

/**
 * True once the user asked to quit. Closing the window otherwise just hides it
 * to the tray, so this is what distinguishes "hide" from "exit".
 */
let isQuitting = false;

// Phase 7a: immersive companion window (one per contact).
const companionWindows = createCompanionWindowManager({
  resolveRendererUrl,
  preloadPath: defaultCompanionPreloadPath(),
  harden: (contents) =>
    hardenWebContents(contents, {
      trustedUrls: trustedRendererUrls,
      openExternal: (url) => void openExternalUrl(url),
    }),
  // A closed window (X button, or `companionClose`) must not leave the sampler
  // running; stop it once the last companion is gone.
  onClosed: () => {
    if (companionWindows.listWindows().length === 0) companionCursor.stop();
  },
});

/**
 * OS-global cursor feed for companion avatars. Started when the first companion
 * opens and stopped when the last one closes, so the ~30 Hz sampler never runs
 * while nothing is on screen.
 */
const companionCursor = createGlobalCursorTracker({
  listWindows: () => companionWindows.listWindows(),
  // Electron's cursor probe freezes when no app window is focused on X11; the
  // native X11 pointer stream keeps reporting the true position everywhere.
  pointerSource: createGlobalPointerSource({
    getCursorPoint: () => screen.getCursorScreenPoint(),
  }),
});

// Phase 7b: desktop calendar. Region-node owns the calendar; this only calls it.
const calendarManager = createCalendarManager({
  getSender: () => getAuthManager().createSender(),
});

// Phase 7c/7d/11: room media view. A nexus meeting is a linked conversation
// room; this projects the roster from `anx.communicate.rooms.get`.
const meetingsManager = createMeetingsManager({
  getSender: () => getAuthManager().createSender(),
});

// Phase 11e: desktop-local speech models (on-device Whisper / Piper) + the
// RAM/VRAM probe. Downloads go to userData; the idle lifecycle frees VRAM.
// The runner *binary* (`whisper-server`) is provisioned by `voiceBinaries` — see
// below — so a downloaded model is actually runnable without a manual install.
const localVoiceManager = createLocalVoiceManager({
  getSender: () => getAuthManager().createSender(),
  resolveBinary: (binary) => voiceBinaries.resolveBinary(binary),
});

/**
 * Downloads/installs the runner executable the local speech engines need
 * (`whisper-server`). Model weights were already downloadable; this closes the
 * gap so "download a Whisper model" works end-to-end. Resolution prefers an
 * existing PATH install, then the app-managed copy under userData.
 */
const voiceBinaries = createVoiceBinaryManager();

/**
 * faster-whisper GPU STT engine (near-realtime local speech on an NVIDIA GPU).
 * It is a private Python runtime under the app data dir; this resolves the
 * shipped server script across the dev / packaged layouts and wires the status +
 * one-click install IPC. The wake + dictation paths prefer it when ready.
 */
const gpuStt = createGpuSttEngine({
  dataDir: app.getPath('userData'),
  // Dev: the script sits in the sibling `packages/local-voice/python`. Packaged:
  // electron-builder copies it to `resources/` (see electron-builder.yml). Both
  // are tried so no environment has to guess.
  scriptPath: isDev
    ? join(__dirname_, '../../../packages/local-voice/python/local-stt-server.py')
    : join(process.resourcesPath, 'local-voice/local-stt-server.py'),
  scriptCandidates: [
    join(__dirname_, '../../../packages/local-voice/python/local-stt-server.py'),
    join(process.resourcesPath, 'local-voice/local-stt-server.py'),
    join(process.resourcesPath, 'local-stt-server.py'),
  ],
});

// Desktop-local model instances (Ollama / ComfyUI). The user may configure
// several and have a job routed to the first available (or least-busy, or a
// round-robin) one. Probing never throws; a dead box just drops out of rotation.
const localModelsStore = createLocalModelsStore();

/**
 * Local VRM/GLB avatar library (Deliverable 2). Files the user picks are copied
 * into `userData/avatar-library` and served to the renderer over the
 * `nexus-avatar:` protocol, so a picked model keeps working after the source
 * file moves. The store is Electron-free apart from `app.getPath`, so its
 * add/remove/map behaviour is unit-tested with a temp dir.
 */
const localAvatarStore = createLocalAvatarStore();

/**
 * Local-only STT for `stt_phrase` wake words. A wake word must never stream
 * audio to the cloud before it fires (see `WAKE_WORD_TRUST`), so this refuses any
 * non-local target and serves an installed whisper.cpp model over loopback.
 */
const wakeStt = createWakeStt({
  modelsDir: () => localVoiceManager.modelsDirectory(),
  customEndpoint: () => localVoiceManager.customSttEndpoint(),
  findModel: (id) => localVoiceManager.findModel(id),
  isInstalled: (id) => localVoiceManager.isInstalled(id),
  selectedModelId: () => localVoiceManager.selectedSttModelId(),
  // Fall back to any installed speech model when the user never picked one, so
  // "I installed Whisper" is enough for wake to work.
  listModels: () => localVoiceManager.listModels(),
  // Bias the decoder toward the currently armed phrases (agent names) so unusual
  // proper nouns are recognized rather than guessed into similar-sounding words.
  wakePhrases: () => {
    try {
      return wakeManager
        .getSettings()
        .bindings.filter((b) => b.enabled)
        .map((b) => b.phrase);
    } catch {
      return [];
    }
  },
  // Spawn the runner the app installed into its data folder when present; fall
  // back to PATH resolution otherwise.
  binaryResolver: (command) => voiceBinaries.resolveBinary(command),
  // Tell "install a model" apart from "install the runner" for the UI.
  runnerInstalled: () => voiceBinaries.isInstalled(),
  // When the faster-whisper GPU engine is installed and the user's backend
  // preference allows it, serve the wake from the GPU (effectively realtime)
  // instead of the CPU whisper.cpp server.
  gpuRunner: {
    // A high port, deliberately clear of 8080-8090 where common dev services squat
    // (InfluxDB owns 8086 on the dev box); a stolen port silently forced CPU.
    port: FASTER_WHISPER_DEFAULT_PORT,
    isInstalled: () => gpuStt.isInstalled(),
    preferred: () => localVoiceManager.preferGpuStt(gpuStt),
    spawn: (input) => gpuStt.spawnServer(input),
  },
});

/**
 * Wake-word manager + host. The manager owns the persisted phrase→agent mapping
 * and routes a wake event to the mapped agent; the host reads installed ONNX
 * bytes off disk for the renderer to arm a detector. Detection itself runs in the
 * renderer (`@nexus/wake-word` needs Web Audio). A wake never authenticates.
 */
const wakeManager = createWakeManager({
  settingsPath: join(app.getPath('userData'), 'wake.json'),
  queuePath: join(app.getPath('userData'), 'wake-queue.json'),
  resolveBinding: (bindingId) => wakeHost.resolveBinding(bindingId),
  localSttReady: (binding) => {
    const model = binding.modelId ? localVoiceManager.findModel(binding.modelId) : null;
    if (model?.kind === 'stt') return localVoiceManager.isInstalled(model.id);
    // No (valid) speech model pinned on the binding: mirror `wakeStt`'s
    // auto-select so a user who simply installed a speech model is not told the
    // wake is unready. A custom local endpoint also counts as ready.
    const anyInstalledStt = localVoiceManager
      .listModels()
      .some((m) => m.kind === 'stt' && m.files.length > 0 && localVoiceManager.isInstalled(m.id));
    return anyInstalledStt || Boolean(localVoiceManager.customSttEndpoint()?.baseUrl);
  },
  persist: (next) => next,
  /**
   * Companion-first focus policy. A wake that resolves to **companion** mode must
   * NOT force the main window forward — only the addressed agent's companion
   * should pop forward. Main resolves the mode from persisted settings (the same
   * {@link resolveWakeActivationMode} the renderer router uses) and additionally
   * checks whether the mapped agent already has an open companion: when it does,
   * it raises that window; otherwise the renderer will open one via
   * `present()`. For chat/widget modes (or an unknown agent) main still raises the
   * main window.
   *
   * The renderer is always told, so it can run the session regardless of surface.
   */
  onActivate: (activation) => {
    const settings = wakeManager.getSettings();
    const agentId = activation.agentId;
    const companionOpen = Boolean(
      agentId && companionWindows.openContactIds().includes(agentId),
    );
    // Companion-first: raise the companion for a companion-mode wake instead of
    // forcing the main window forward (only pop the main window when there is no
    // companion to own the surface). The renderer is always told, so it can run
    // the session regardless of surface.
    if (companionOpen && agentId && !wakeRaisesMainWindow({ settings, companionOpen })) {
      companionWindows.raise(agentId);
    } else {
      showMainWindow();
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.wakeActivated, activation);
    }
  },
});

const wakeHost = createWakeHost({
  modelsDir: localVoiceManager.modelsDirectory(),
  findModel: (id) => localVoiceManager.findModel(id),
  readSettings: () => wakeManager.getSettings(),
});

// Wake settings picker: the mappable agents, read straight from the region
// (the chat SPA is not mounted while settings is open). Agents are scoped to
// the JWT tenant, so the directory fans out over every stored membership and
// unions the rows — otherwise an app agent installed by a non-active org (e.g.
// `xcamp`) never appears.
const wakeAgentDirectory = createWakeAgentDirectory({
  getSender: () => getAuthManager().createSender(),
  listIdentities: () =>
    identityManager
      .listSessions()
      .filter((session) => session.token)
      .map((session) => ({
        key: session.key,
        userId: session.userId,
        orgId: session.orgId,
        token: session.token,
        deviceId: session.deviceId,
      })),
  getClientOptions: () => authClientOptions(),
});

/**
 * OS notifications for new chat messages. The renderer reports inbound
 * messages; main decides whether the window is unattended and raises a native
 * card. Settings are read per notification so a change applies immediately.
 */
const notificationManager = createNotificationManager({
  getSettings: () => settings.getUiSettings().notifications,
  getAttention: () => {
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    return {
      minimized: mainWindow.isMinimized(),
      visible: mainWindow.isVisible(),
      focused: mainWindow.isFocused(),
    };
  },
  // Locked UI => the card must not leak sender/content (Deliverable 4).
  isLocked: () => appLockManager.isLockedNow(),
  isSupported: () => Notification.isSupported(),
  createNotification: (content) =>
    new Notification({ title: content.title, body: content.body, silent: content.silent }),
  focusWindow: () => showMainWindow(),
  onActivate: (payload) => {
    // Bring the window up first, then let the renderer route to the message.
    showMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.notifyActivated, payload);
    }
  },
});

let tray: Tray | null = null;

/**
 * Installed Nexus apps for the tray menu.
 *
 * "Installed apps" are the third-party apps the user connected over *Login with
 * ANX* (OAuth2). The region exposes them as OAuth2 grants, and the list command
 * is **identity-scoped** (personal session vs. one org membership), so the
 * provider calls it once per stored session and unions the rows by `clientId`
 * (see `nexus-apps.ts`). Cached briefly so opening the tray repeatedly does not
 * hammer the region; rebuilt on demand when auth state changes.
 */
let installedAppsCache: { at: number; apps: InstalledNexusApp[] } | null = null;
const INSTALLED_APPS_TTL_MS = 60_000;

const nexusAppsProvider = createNexusAppsProvider({
  listIdentities: () =>
    identityManager
      .listSessions()
      .filter((session) => session.token)
      .map((session) => ({
        key: session.key,
        userId: session.userId,
        orgId: session.orgId,
        // The identity label is the org name for a business session (falling back
        // to the business email), which is exactly the submenu heading we want.
        orgName:
          session.orgId && session.label && session.label !== session.orgId ? session.label : null,
        token: session.token,
        // Device validation is mandatory for every authenticated command.
        deviceId: session.deviceId,
      })),
  getClientOptions: () => authClientOptions(),
});

/**
 * Installed apps, cached for a short window. A region failure never throws: the
 * tray keeps "Show Nexus" + "Open portal" and simply omits the app section.
 */
async function loadInstalledApps(): Promise<InstalledNexusApp[]> {
  if (!identityManager.hasActiveSession()) return [];
  if (installedAppsCache && Date.now() - installedAppsCache.at < INSTALLED_APPS_TTL_MS) {
    return installedAppsCache.apps;
  }
  try {
    const { apps } = await nexusAppsProvider.list();
    installedAppsCache = { at: Date.now(), apps };
    return apps;
  } catch {
    return [];
  }
}

/** Drop the cache so the next tray rebuild refetches (auth/login/logout/settings). */
function invalidateInstalledApps(): void {
  installedAppsCache = null;
}

/** The full resolved tray list: installed (filtered) + custom entries. */
async function resolveTrayAppItems(): Promise<TrayAppItem[]> {
  const installed = await loadInstalledApps();
  return resolveTrayApps({ installed, settings: settings.getUiSettings().trayApps });
}

/** Open an http(s) URL externally; anything else is refused in main. */
async function openExternalUrl(url: string): Promise<void> {
  if (!isSafeExternalUrl(url)) return;
  await shell.openExternal(url);
}

/**
 * (Re)build the tray context menu from the current auth state, portal URL and
 * resolved app list. Safe to call repeatedly — each call replaces the menu.
 */
async function refreshTrayMenu(): Promise<void> {
  if (!tray) return;
  const signedIn = identityManager.hasActiveSession();
  const appItems = signedIn ? await resolveTrayAppItems() : [];
  const template = buildTrayMenu({
    signedIn,
    portalUrl: settings.getConnectionConfig().portalUrl ?? null,
    appItems,
    onShow: () => showMainWindow(),
    onQuit: () => app.quit(),
    onOpenUrl: (url) => void openExternalUrl(url),
  });
  if (!tray) return;
  try {
    tray.setContextMenu(Menu.buildFromTemplate(template as Electron.MenuItemConstructorOptions[]));
  } catch (error) {
    // A malformed template must never leave the old (or an empty) menu in place
    // without a way out; fall back to the two essential items.
    console.warn('[tray] failed to build context menu:', error);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { id: 'show', label: 'Show Nexus', click: () => showMainWindow() },
        { type: 'separator' },
        { id: 'quit', label: 'Quit', click: () => app.quit() },
      ]),
    );
  }
}

/** Show + focus the main window (used by tray click and notification click). */
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

/**
 * Tray icon so the app can keep running (and receiving messages) with no window
 * on screen — which is exactly when notifications matter. Left-click toggles the
 * window; the context menu offers show + portal + the user's Nexus apps + quit.
 */
function createTray(): void {
  if (tray) return;
  const icon = resolveWindowIcon();
  if (!icon) return;
  try {
    tray = new Tray(nativeImage.createFromPath(icon));
  } catch (error) {
    console.warn('[tray] failed to create tray icon:', error);
    tray = null;
    return;
  }
  tray.setToolTip('Nexus');
  // Seed with the essential items synchronously so the tray is never menu-less,
  // then refresh with the dynamic app list once it resolves.
  try {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { id: 'show', label: 'Show Nexus', click: () => showMainWindow() },
        { type: 'separator' },
        { id: 'quit', label: 'Quit', click: () => app.quit() },
      ]),
    );
  } catch (error) {
    console.warn('[tray] failed to seed the context menu:', error);
  }
  void refreshTrayMenu();
  tray.on('click', () => {
    if (mainWindow?.isVisible() && mainWindow.isFocused()) mainWindow.hide();
    else showMainWindow();
  });
}

/**
 * Logout (Deliverable 5). Two explicit choices, neither leaving the user stuck:
 * "switch user" keeps local data (optionally unmounting), "permanent" wipes it.
 * Each teardown step is wrapped so a failure is reported per-step and retryable.
 */
const logoutManager = createLogoutManager({
  stopSync: () => syncManager.stop(),
  unmountAll: async () => {
    const snap = await mountDaemon.snapshot();
    for (const session of snap.sessions) {
      await mountDaemon.removeSession(session.id);
    }
  },
  clearSyncBindings: async () => {
    for (const binding of syncManager._readBindings()) {
      await syncManager.removeBinding(binding.id);
    }
  },
  clearWakeQueue: async () => {
    wakeManager.setQueue([]);
  },
  clearChatCache: async () => {
    chatCacheStore.clear();
  },
  clearIdentityStore: () => {
    identityManager.reset();
  },
  clearSecureStore: async () => {
    await secureStore.clear();
  },
  endSession: async () => {
    await getAuthManager().logout();
    // The identity store is the token authority (Phase 9), so ending the *auth
    // manager's* session is not enough: while an identity stays active,
    // `activeToken()` keeps handing the old token back to every sender and
    // `getState()` reports `signed_in` — a switch-user logout that silently did
    // not sign out. Deactivate the active session (keeping the stored accounts).
    identityManager.endActiveSession();
    // Clearing the PIN here is the documented lock-out recovery path: sign-out /
    // switch-user / permanent logout must never leave a forgotten PIN armed, or
    // the next session would be gated behind it with no way in.
    await appLockManager.clearPin();
    appLockManager.resetLocked();
  },
});

/** Rebuild the tray after any identity change (switch org / account / logout). */
function afterIdentityChange(): void {
  invalidateInstalledApps();
  void refreshTrayMenu();
}

const viewerUserId = () => {
  const snap = identityManager.getSnapshot();
  const active = snap.accounts.find((a) => a.active);
  return active?.userId ?? snap.activeUserId ?? null;
};

/** Build the region auth client options from current settings. */
function authClientOptions(): AuthClientOptions {
  const connection = settings.getConnectionConfig();
  return {
    baseUrl: connection.regionUrl,
    headers: { 'X-Anx-App': connection.appId ?? DESKTOP_APP_ID },
    // Trust the local region's self-signed CA. Node 20's global fetch has no
    // supported way to add a CA, so we bind a CA-aware fetch for this client.
    fetchFn: regionFetch(),
  };
}

/**
 * A CA-aware `fetch` for main-process requests to the region. Resolves the
 * custom CA from the *current* connection settings on each call (and caches the
 * built fetch per CA value), so a CA applied from `.env` at startup or changed
 * in settings takes effect without an app restart. Falls back to the global
 * `fetch` when no custom CA is configured.
 */
let cachedFetch: { ca: string | null; fn: typeof fetch } | null = null;
function regionFetch(): typeof fetch {
  return ((input: string | URL | { url: string }, init?: RequestInit) => {
    const caPem = settings.getConnectionConfig().customCaPem ?? null;
    if (!cachedFetch || cachedFetch.ca !== caPem) {
      cachedFetch = { ca: caPem, fn: createNodeFetch({ caPem }) };
    }
    return cachedFetch.fn(input as unknown as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;
}

/**
 * Human-readable device name shown on the "sign in with the app" approval
 * prompt, so the user recognises the requesting machine at a glance.
 */
function humanDeviceName(): string {
  const os =
    process.platform === 'darwin'
      ? 'macOS'
      : process.platform === 'win32'
        ? 'Windows'
        : process.platform === 'linux'
          ? 'Linux'
          : process.platform;
  const host = (() => {
    try {
      return hostname();
    } catch {
      return '';
    }
  })();
  return host ? `Nexus Desktop (${os}) · ${host}` : `Nexus Desktop (${os})`;
}

function getAuthManager(): ReturnType<typeof createAuthManager> {
  if (!authManager) {
    authManager = createAuthManager({
      secureStore,
      clientOptions: authClientOptions(),
      deviceName: humanDeviceName(),
      platform: process.platform,
      appVersion: app.getVersion(),
      // Phase 9: the identity store is the token authority (multi-account +
      // org identity switching).
      getActiveToken: () => identityManager.activeToken(),
      // The store also owns the session identity; the auth manager folds it
      // (plus the device keypair) back into the identity it sends, so a
      // restarted process still carries a valid `deviceId`.
      getActiveIdentity: () => identityManager.activeSession(),
      onAuthenticated: ({ token, identity }) => {
        if (!identity.userId) return;
        identityManager.recordLogin({
          userId: identity.userId,
          email: identity.email ?? null,
          orgId: identity.orgId,
          role: identity.role,
          token,
          deviceId: identity.deviceId,
        });
        // New session -> the tray's app list may change; refetch and rebuild.
        invalidateInstalledApps();
        void refreshTrayMenu();
      },
      // Device removed in the portal (or token revoked): lose ALL access at once
      // — money-grade teardown of storage, sync schedules and mounts.
      onSessionLost: (loss) => {
        void handleSessionLost(loss);
      },
    });
  }
  return authManager;
}

/**
 * Global session-loss teardown. Fired by the auth sender the instant the region
 * proves the device is gone. Wipes identity/token state, stops every background
 * scheduler and mount, and tells the renderer to return to the sign-in screen.
 */
async function handleSessionLost(loss: { reason: string; deviceRevoked: boolean; message: string }): Promise<void> {
  invalidateInstalledApps();
  try {
    identityManager.reset();
  } catch {
    /* best-effort */
  }
  try {
    syncManager.stop();
  } catch {
    /* best-effort */
  }
  try {
    mountDaemon.dispose();
  } catch {
    /* best-effort */
  }
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send(IPC.authSessionLost, loss);
    } catch {
      /* window may be gone */
    }
  }
  // The session teardown cleared the identity store: rebuild the tray so the
  // app section drops and only "Show Nexus" + "Open portal" remain.
  void refreshTrayMenu();
}

/**
 * Trust a custom CA in the renderer session so `fetch` from the renderer works
 * against a self-signed local region node, matching the main-process trust.
 *
 * The verify proc is a *pin*, not a bypass: we accept a chain only when the
 * presented leaf is genuinely issued by a certificate we were explicitly given
 * in `customCaPem`, or when the user has explicitly pinned that exact
 * certificate (fingerprint) for that exact host through the trust prompt.
 * Chromium only hands us the leaf for a private/self-signed CA (no issuer
 * chain), so a fingerprint comparison against the CA bundle could never match —
 * instead we verify the leaf's signature against the CA public key, check the
 * validity windows, and check the leaf covers the requested host.
 *
 * The proc is installed on **every** session the app can render into (the
 * default session + any named partition), because a `webview`/partitioned
 * context does not inherit the default session's handler — so custom-CA trust
 * does not silently depend on where a surface happens to be hosted. Both
 * sessions share the same decision core.
 */
async function applyCustomCa(connection: DesktopConnectionConfig): Promise<void> {
  const caPem = connection.customCaPem;
  const hasCa = typeof caPem === 'string' && looksLikePemCertificate(caPem);
  const trusted = hasCa ? certificateFingerprints(caPem) : new Set<string>();

  // Only a *parsed* CA bundle (or a user pin) justifies installing our proc; an
  // absent or broken config clears any previously-installed pin so stale custom
  // trust never lingers.
  const active = hasCa && trusted.size > 0;
  const verify = active
    ? createCertificateVerifyProc({
        caPem: caPem as string,
        trustedFingerprints: trusted,
        trustStore: certTrustStore,
        requestTrust: (info) => certPrompt.requestTrust(info),
      })
    : null;

  for (const target of [
    session.defaultSession as unknown as { setCertificateVerifyProc: (p: unknown) => void },
    ...SAFE_PARTITION_SESSIONS.map(
      (name) => session.fromPartition(name) as unknown as { setCertificateVerifyProc: (p: unknown) => void },
    ),
  ]) {
    try {
      target.setCertificateVerifyProc(verify ? (request: unknown, callback: (code: number) => void) => {
        callback(verify(request as Parameters<typeof verify>[0]));
      } : null);
    } catch {
      // Never let a session-pinning failure crash the main process.
    }
  }
}

/**
 * Named partitions the app can host content in. A `webview`/partitioned context
 * does not inherit `defaultSession`'s verify proc, so we install ours on these
 * too. Kept as an explicit allowlist (not a wildcard) so we never mutate sessions
 * we do not own.
 */
const SAFE_PARTITION_SESSIONS = ['persist:nexus', 'persist:nexus-chat', 'persist:nexus-companion'] as const;

function resolveRendererUrl(): string {
  const devServer = process.env.NEXUS_RENDERER_URL;
  if (isDev && devServer) return devServer;
  // Vite emits to dist/renderer/index.html (see vite.config.ts outDir), so from
  // __dirname_ (dist-electron) it is a sibling `dist/` folder, not `renderer/`.
  return `file://${join(__dirname_, '../dist/renderer/index.html')}`;
}

/**
 * The only renderer location the bridge trusts. Resolved lazily (the URL is
 * fixed at boot) and used for both IPC sender validation and navigation guards.
 */
const trustedRendererUrls = (): readonly string[] => [resolveRendererUrl()];

/** Validates the sender of every `ipcMain.handle` before its body runs. */
const senderGuard = createSenderGuard(trustedRendererUrls);

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1419',
    title: 'Nexus',
    webPreferences: {
      // Emitted to dist-electron/preload/preload.cjs (a subfolder of __dirname_),
      // not a sibling — joining `../preload` would look outside dist-electron and
      // silently leave `window.nexus` undefined, blanking the renderer.
      preload: join(__dirname_, 'preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Set the icon after construction: the constructor's `icon` option does not
  // reliably reach `_NET_WM_ICON` on Linux, whereas setIcon() does.
  const icon = resolveWindowIcon();
  if (icon) mainWindow.setIcon(icon);

  // Block navigation off the app's own origin (the preload — hence
  // `window.nexus` — is re-injected on every navigation) and deny `window.open`.
  hardenWebContents(mainWindow.webContents, {
    trustedUrls: trustedRendererUrls,
    openExternal: (url) => void openExternalUrl(url),
  });

  // Closing the window hides it to the tray rather than quitting, so the app can
  // keep receiving messages (and raising notifications) in the background. A real
  // quit — tray menu, Cmd+Q, `before-quit` — sets `isQuitting` and passes through.
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });

  const connection = settings.getConnectionConfig();
  await applyCustomCa(connection);

  // Phase 7c: getDisplayMedia() only resolves when the main process answers the
  // request. We auto-pick a display source (screens preferred) for our own
  // window and deny anything else. Audio is loopback only where the OS supports
  // it (Windows); elsewhere the renderer still gets the video track.
  mainWindow.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    if (!mainWindow || request.frame?.url !== mainWindow.webContents.getURL()) {
      callback({});
      return;
    }
    desktopCapturer
      .getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => {
        const chosen = pickDisplaySource(sources);
        if (!chosen) {
          callback({});
          return;
        }
        const answer: { video: Electron.DesktopCapturerSource; audio?: 'loopback' } = {
          video: chosen as unknown as Electron.DesktopCapturerSource,
        };
        if (process.platform === 'win32') answer.audio = 'loopback';
        callback(answer);
      })
      .catch(() => callback({}));
  });

  await mainWindow.loadURL(resolveRendererUrl());
  if (isDev && process.env.NEXUS_OPEN_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

/**
 * Build the read-only snapshot the audit browser renders. Applies the UI filter
 * for the rows but computes the facet lists from the whole retained set, so the
 * filter dropdowns never collapse to the current selection.
 */
function buildAuditSnapshot(filter: import('../shared/audit.js').AuditFilter): AuditSnapshot {
  const all = auditStore.list();
  return {
    entries: filterAuditEntries(all, filter),
    retention: auditStore.getRetention(),
    facets: auditFacets(all),
    path: auditStore.filePath(),
    total: all.length,
    sizeBytes: auditStore.sizeBytes(),
  };
}

function registerIpc(): void {
  // Validate the sender of every registered handler before its body runs. Must
  // run before the first `ipcMain.handle` below (it wraps the method itself).
  installSenderGuard(ipcMain, senderGuard);

  ipcMain.handle(IPC.version, () => app.getVersion());
  ipcMain.handle(IPC.configGet, () => settings.getConnectionConfig());
  ipcMain.handle(IPC.configSet, (_e, patch: ConnectionConfigPatch) => {
    const next = settings.setConnectionConfig(patch ?? {});
    authManager = null; // rebuild client options against the new region
    // Re-pin the renderer's certificate trust so a CA change takes effect
    // without an app restart (main-process fetch resolves it per call).
    void applyCustomCa(next);
    // A new portal URL (or region) changes the "Open portal" item and where the
    // tray app list is fetched from.
    invalidateInstalledApps();
    void refreshTrayMenu();
    return next;
  });

  ipcMain.handle(IPC.uiSettingsGet, () => settings.getUiSettings());
  ipcMain.handle(IPC.uiSettingsSet, (_e, patch: Partial<UiSettings>) => {
    const next = settings.setUiSettings(patch ?? {});
    // A visibility/custom-entry change must be reflected in the tray at once.
    if (patch && 'trayApps' in patch) {
      invalidateInstalledApps();
      void refreshTrayMenu();
    }
    return next;
  });

  // TLS certificate trust. `list`/`revoke` are the Settings surface; `respond`
  // settles the prompt raised by the verify proc. Trusting or revoking re-pins
  // the session so Chromium re-runs verification on the next request.
  ipcMain.handle(IPC.certTrustList, (): CertificateTrustEntry[] => certTrustStore.list());
  ipcMain.handle(IPC.certTrustRevoke, (_e, host: string, fingerprint?: string): CertificateTrustEntry[] => {
    certTrustStore.revoke(String(host ?? ''), fingerprint ? String(fingerprint) : undefined);
    void applyCustomCa(settings.getConnectionConfig());
    return certTrustStore.list();
  });
  ipcMain.handle(
    IPC.certTrustRespond,
    (_e, decision: { host?: string; fingerprint?: string; trusted?: boolean }): void => {
      // Only the prompt that is currently open may be settled, and only for the
      // exact (host, fingerprint) it asked about — a renderer cannot answer a
      // different certificate or pin arbitrary trust.
      const pending = certTrustPending;
      if (!pending) return;
      if (String(decision?.host ?? '') !== pending.host) return;
      if (String(decision?.fingerprint ?? '') !== pending.fingerprint) return;
      certTrustPending = null;
      pending.settle(decision?.trusted === true);
    },
  );
  ipcMain.handle(IPC.notifyIncoming, (_e, payload: NotificationPayload, opts?: { force?: boolean }) => {
    if (!payload || typeof payload !== 'object' || typeof payload.messageId !== 'string') return;
    notificationManager.notify(payload, { force: opts?.force === true });
  });

  ipcMain.handle(IPC.wakeGetSettings, () => wakeManager.getSettings());
  ipcMain.handle(IPC.wakeSetSettings, (_e, next: unknown) => wakeManager.setSettings(next));
  ipcMain.handle(IPC.wakeListAgents, () => wakeAgentDirectory.list());
  ipcMain.handle(IPC.wakeResolveBinding, (_e, binding: unknown) => {
    // A manual binding resolves by id (against the persisted store); an
    // auto-mapped binding arrives as a full object and is validated on main.
    if (typeof binding === 'string') return wakeManager.resolveBinding(binding);
    const normalized = normalizeWakeBinding(binding);
    return normalized ? wakeManager.resolveBinding(normalized) : null;
  });
  ipcMain.handle(IPC.wakeReportState, (_e, state: unknown) => {
    wakeManager.reportState(state);
  });
  ipcMain.handle(IPC.wakeGetQueue, () => wakeManager.getQueue());
  ipcMain.handle(IPC.wakeSetQueue, (_e, queue: unknown) => wakeManager.setQueue(queue));
  // Local-only STT for `stt_phrase` wake words. Main never sends this audio to
  // the cloud: `wakeStt` refuses a non-local target (see wake-stt.ts).
  ipcMain.handle(IPC.wakeSttStatus, () => wakeStt.status());
  ipcMain.handle(
    IPC.wakeTranscribeLocal,
    async (
      _e,
      payload: { pcm?: ArrayBuffer | Uint8Array; sampleRate?: number; phrases?: string[] },
    ) => {
      const raw = payload?.pcm;
      if (!raw) return null;
      const pcm =
        raw instanceof Float32Array
          ? raw
          : raw instanceof Uint8Array
            ? new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4))
            : new Float32Array(raw as ArrayBuffer);
      const sampleRate = Number(payload?.sampleRate) || 16_000;
      // The renderer sends the armed phrases (incl. auto-mapped ones that never
      // reach persisted settings) so phrase biasing always matches what is armed.
      const phrases = Array.isArray(payload?.phrases)
        ? payload.phrases.filter((p): p is string => typeof p === 'string')
        : [];
      return wakeStt.transcribe(pcm, sampleRate, phrases);
    },
  );
  ipcMain.handle(
    IPC.wakeActivated,
    (_e, payload: { phrase?: string; agentId?: string | null }) => {
      if (!payload || typeof payload.phrase !== 'string') return;
      wakeManager.activate({ phrase: payload.phrase, agentId: payload.agentId ?? null });
    },
  );

  ipcMain.handle(IPC.authState, () => getAuthManager().getState());
  ipcMain.handle(IPC.authLogin, (_e, req: LoginRequest) => getAuthManager().login(req));
  ipcMain.handle(IPC.authTwoFactor, (_e, req: TwoFactorRequest) =>
    getAuthManager().submitTwoFactor(req),
  );
  ipcMain.handle(IPC.authSwitchTwoFactor, (_e, method: string) =>
    getAuthManager().switchTwoFactorMethod(method),
  );
  ipcMain.handle(IPC.authListCountries, () => getAuthManager().listCountries());
  ipcMain.handle(IPC.authListRegions, () => getAuthManager().listRegions());
  // Sandbox badge: the same public command the portal uses, best-effort so an
  // unreachable region never blocks the login screen (fails closed to null).
  ipcMain.handle(IPC.authRegionEnvironment, () => readRegionEnvironment(authClientOptions()));
  ipcMain.handle(IPC.authPasswordlessStart, (_e, input) =>
    getAuthManager().startPasswordless(input),
  );
  ipcMain.handle(IPC.authPasswordlessVerify, (_e, input) =>
    getAuthManager().verifyPasswordless(input),
  );
  ipcMain.handle(IPC.authPasswordlessResend, (_e, input) =>
    getAuthManager().resendPasswordless(input),
  );
  ipcMain.handle(IPC.authCancelChallenge, () => getAuthManager().cancelChallenge());
  ipcMain.handle(IPC.authDeviceLinkStart, () => getAuthManager().startDeviceLink());
  ipcMain.handle(IPC.authDeviceLinkPoll, () => getAuthManager().pollDeviceLink());
  ipcMain.handle(IPC.authLogout, () => getAuthManager().logout());
  ipcMain.handle(IPC.authHydrate, () => getAuthManager().hydrateSession());

  // App PIN lock (Deliverable 3). A UI gate only; the PIN is hashed in main.
  ipcMain.handle(IPC.appLockGetState, () => appLockManager.getState());
  ipcMain.handle(IPC.appLockSetPin, (_e, pin: string) => appLockManager.setPin(pin));
  ipcMain.handle(IPC.appLockClearPin, () => appLockManager.clearPin());
  ipcMain.handle(IPC.appLockUpdateSettings, (_e, patch: Partial<AppLockSettings>) =>
    appLockManager.updateSettings(patch ?? {}),
  );
  ipcMain.handle(IPC.appLockNoteActivity, () => {
    appLockManager.noteActivity();
  });
  ipcMain.handle(IPC.appLockEvaluate, () => appLockManager.evaluateLocked());
  ipcMain.handle(IPC.appLockUnlock, (_e, pin: string) => appLockManager.unlock(pin));
  ipcMain.handle(IPC.appLockLock, () => appLockManager.lock());

  // Logout with two explicit choices (Deliverable 5).
  ipcMain.handle(IPC.logoutRun, (_e, choice: LogoutChoice) => logoutManager.run(choice));
  ipcMain.handle(IPC.logoutRetry, (_e, steps: LogoutStep[], choice: LogoutChoice) =>
    logoutManager.retry(Array.isArray(steps) ? steps : [], choice),
  );

  ipcMain.handle(IPC.deviceStatus, () => getAuthManager().getDeviceStatus());
  ipcMain.handle(IPC.deviceRegister, () => getAuthManager().registerDevice());

  ipcMain.handle(IPC.localModelsList, () =>
    probeLocalModels(localModelsStore.get().instances, { policy: localModelsStore.get().policy }),
  );
  ipcMain.handle(IPC.localModelsGetConfig, () => localModelsStore.get());
  ipcMain.handle(IPC.localModelsUpsert, (_e, instance: unknown) => localModelsStore.upsert(instance));
  ipcMain.handle(IPC.localModelsRemove, (_e, id: string) =>
    localModelsStore.remove(typeof id === 'string' ? id : ''),
  );
  ipcMain.handle(IPC.localModelsSetPolicy, (_e, policy: unknown) => localModelsStore.setPolicy(policy));
  ipcMain.handle(IPC.localModelsTest, (_e, instance: unknown) =>
    probeBackend((instance ?? {}) as never),
  );

  ipcMain.handle(IPC.toolsGet, () => toolsStore.get());
  ipcMain.handle(IPC.toolsSetWorkspaces, (_e, workspaces) => toolsStore.setWorkspaces(workspaces));
  ipcMain.handle(IPC.toolsSetLocalCommands, (_e, commands) =>
    toolsStore.setLocalCommands(commands),
  );
  ipcMain.handle(IPC.toolsRun, (_e, req: ToolInvocation) =>
    toolAuditor.invoke(req, { store: toolsStore }),
  );

  // Client-tool audit trail. Read-only snapshot + the configurable retention
  // setting. This is the ENTIRE audit IPC surface: there is deliberately no
  // channel to append, clear or trim, so no renderer/agent path can mutate the
  // store (which is written only inside `toolAuditor`).
  ipcMain.handle(IPC.auditSnapshot, (_e, filter?: Partial<import('../shared/audit.js').AuditFilter>) =>
    buildAuditSnapshot(filter ?? {}),
  );
  ipcMain.handle(IPC.auditSetRetention, (_e, patch: Partial<import('../shared/audit.js').AuditRetention>) => {
    auditStore.setRetention(patch ?? {});
    return buildAuditSnapshot({});
  });

  // Durable, metadata-only chat cache. The renderer's chat panel injects this
  // as its `ChatCacheAdapter`; values are opaque strings and the byte bound /
  // LRU live in the main process. No agent-facing tool reaches these channels.
  ipcMain.handle(IPC.chatCacheGet, (_e, key: string) => chatCacheStore.get(String(key ?? '')));
  ipcMain.handle(IPC.chatCacheSet, (_e, key: string, value: string) => {
    chatCacheStore.set(String(key ?? ''), String(value ?? ''));
  });
  ipcMain.handle(IPC.chatCacheDelete, (_e, key: string) => {
    chatCacheStore.delete(String(key ?? ''));
  });
  ipcMain.handle(IPC.chatCacheKeys, () => chatCacheStore.keys());
  ipcMain.handle(IPC.chatCacheClear, () => {
    chatCacheStore.clear();
  });
  ipcMain.handle(IPC.chatCacheStats, () => chatCacheStore.stats());
  ipcMain.handle(IPC.chatCacheSetMaxBytes, (_e, maxBytes: number) => {
    chatCacheStore.setSettings({ maxBytes: Number(maxBytes) });
    return chatCacheStore.stats();
  });

  // Storage explorer (Phase 2).
  ipcMain.handle(IPC.storageWorkspaces, () => storageManager.workspaces());
  ipcMain.handle(IPC.storageFolderList, (_e, workspaceId: string, parentFolderId?: string | null) =>
    storageManager.folderList(workspaceId, parentFolderId),
  );
  ipcMain.handle(IPC.storageListFiles, (_e, input) => storageManager.listFiles(input ?? {}));
  ipcMain.handle(IPC.storageCapabilities, (_e, kind?: string) => storageManager.capabilities(kind));
  ipcMain.handle(IPC.storageUpload, (_e, req: StorageUploadRequest) => storageManager.upload(req));
  ipcMain.handle(IPC.storageDownloadUrl, (_e, fileId: string) => storageManager.downloadUrl(fileId));
  ipcMain.handle(IPC.storageListRevisions, (_e, fileId: string, limit?: number) =>
    storageManager.listRevisions(fileId, limit),
  );
  ipcMain.handle(IPC.storageRevertRevision, (_e, fileId: string, revisionNo: number) =>
    storageManager.revertRevision(fileId, revisionNo),
  );
  ipcMain.handle(IPC.storageTrashFile, (_e, fileId: string) => storageManager.trashFile(fileId));
  ipcMain.handle(IPC.storageRestoreFile, (_e, fileId: string) => storageManager.restoreFile(fileId));
  ipcMain.handle(IPC.storageRenameFile, (_e, fileId: string, newName: string) =>
    storageManager.renameFile(fileId, newName),
  );
  ipcMain.handle(IPC.storageMoveFile, (_e, fileId: string, targetFolderId: string | null) =>
    storageManager.moveFile(fileId, targetFolderId),
  );

  // Drag-and-drop transfer (renderer UX ownership). Every handler moves bytes in
  // the main process; the renderer sends paths only. Progress is pushed back on
  // `IPC.storageTransferProgress` so the queue shows real byte counts.
  ipcMain.handle(IPC.storageExpandDrop, (_e, paths: string[]) =>
    storageTransfer.expandDrop(Array.isArray(paths) ? paths : []),
  );
  ipcMain.handle(IPC.storageUploadOne, (_e, req: StorageUploadOneRequest) => storageTransfer.uploadOne(req));
  ipcMain.handle(IPC.storageTransferCancel, (_e, transferId: string) => storageTransfer.cancel(transferId));
  ipcMain.handle(IPC.storageDownloadLink, (_e, fileId: string) => storageTransfer.downloadLink(fileId));
  ipcMain.handle(IPC.storageSaveFile, (_e, fileId: string, suggestedName: string) =>
    storageTransfer.saveFile(fileId, suggestedName, async (name) => {
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
      const result = win
        ? await dialog.showSaveDialog(win, { defaultPath: name })
        : await dialog.showSaveDialog({ defaultPath: name });
      return result.canceled || !result.filePath ? null : result.filePath;
    }),
  );
  ipcMain.handle(IPC.storageSaveFilesToDir, (_e, files: Array<{ fileId: string; name: string }>) =>
    storageTransfer.saveFilesToDir(Array.isArray(files) ? files : [], async () => {
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
      const result = win
        ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
        : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
      return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
    }),
  );
  ipcMain.handle(IPC.storagePrepareDrag, (_e, fileId: string, name: string) =>
    storageTransfer.prepareDrag(fileId, name),
  );
  ipcMain.handle(IPC.storageStartDrag, async (event, fileId: string, name: string) => {
    const wc = event.sender;
    if (!wc || wc.isDestroyed()) return false;
    // A 1x1 transparent icon satisfies macOS, which requires a non-empty drag
    // image; every other platform ignores it.
    const icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    );
    const driver = { icon, startDrag: (item: { file: string; icon: unknown }) => wc.startDrag(item as never) };
    // Hover warm-up normally staged the file already, so this is a synchronous
    // start inside the drag gesture. If the warm-up has not finished (or never
    // ran), stage now and start once the bytes are on disk.
    if (storageTransfer.startDrag(fileId, driver)) return true;
    const prepared = await storageTransfer.prepareDrag(fileId, typeof name === 'string' ? name : '');
    if (!prepared.path) return false;
    return storageTransfer.startDrag(fileId, driver);
  });
  ipcMain.handle(IPC.storageReleaseDrag, (_e, fileId: string) => {
    storageTransfer.releaseDrag(fileId);
  });
  ipcMain.handle(IPC.storagePreviewBytes, (_e, fileId: string) =>
    storageTransfer.readBytesForPreview(fileId),
  );

  // Bucket-subdir <-> local-dir multi-sync (Phase 3).
  ipcMain.handle(IPC.syncGetState, () => syncManager.state());
  ipcMain.handle(IPC.syncListRemoteFolders, (_e, workspaceId: string) =>
    syncManager.listRemoteFolders(workspaceId),
  );
  ipcMain.handle(IPC.syncAddBinding, (_e, input) => syncManager.addBinding(input));
  ipcMain.handle(IPC.syncUpdateBinding, (_e, id: string, patch) =>
    syncManager.updateBinding(id, patch ?? {}),
  );
  ipcMain.handle(IPC.syncRemoveBinding, (_e, id: string) => syncManager.removeBinding(id));
  ipcMain.handle(IPC.syncRunNow, (_e, id: string) => syncManager.runBinding(id));
  ipcMain.handle(IPC.syncRunAll, () => syncManager.runAll());
  ipcMain.handle(IPC.syncChooseLocalDir, async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
  });

  // Native mount daemon (Phase 3).
  ipcMain.handle(IPC.mountSnapshot, () => mountDaemon.snapshot());
  ipcMain.handle(IPC.mountAddSession, (_e, input) => mountDaemon.addSession(input));
  ipcMain.handle(IPC.mountRemoveSession, (_e, id: string) => mountDaemon.removeSession(id));
  ipcMain.handle(IPC.mountStartSession, (_e, id: string) => mountDaemon.startSession(id));
  ipcMain.handle(IPC.mountStopSession, (_e, id: string) => mountDaemon.stopSession(id));
  ipcMain.handle(IPC.mountChooseMountpoint, async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
  });

  // Local GPU runner (Phase 4).
  ipcMain.handle(IPC.runnerGetState, () => runnerManager.getState());
  ipcMain.handle(IPC.runnerSetSettings, (_e, patch: Partial<LocalRunnerSettings>) =>
    runnerManager.setSettings(patch ?? {}),
  );
  ipcMain.handle(IPC.runnerStart, () => runnerManager.start());
  ipcMain.handle(IPC.runnerStop, () => runnerManager.stop());
  ipcMain.handle(IPC.runnerRegister, () => runnerManager.register());

  // Identity / account switching (Phase 9).
  ipcMain.handle(IPC.identitySnapshot, () => identityManager.getSnapshot());
  ipcMain.handle(IPC.identityChatSessions, () => identityManager.chatIdentitySessions());
  ipcMain.handle(IPC.identityListMemberships, () => identityManager.listMemberships());
  ipcMain.handle(IPC.identitySwitch, (_e, key: string) => {
    const next = identityManager.switchIdentity(key);
    afterIdentityChange();
    return next;
  });
  ipcMain.handle(IPC.identitySwitchAccount, (_e, userId: string) => {
    const next = identityManager.switchAccount(userId);
    afterIdentityChange();
    return next;
  });
  ipcMain.handle(IPC.identityLogout, (_e, key?: string) => {
    const next = identityManager.logout(key);
    afterIdentityChange();
    return next;
  });
  ipcMain.handle(IPC.identityStartMembership,
    async (_e, req: { membershipId: string; businessEmail: string; password?: string }) => {
      const out = await identityManager.startMembership(req);
      afterIdentityChange();
      return out;
    },
  );
  ipcMain.handle(IPC.identityCompleteMembership,
    async (_e, req: { loginToken: string; method: string; code: string; businessEmail?: string }) => {
      const out = await identityManager.completeMembership(req);
      afterIdentityChange();
      return out;
    },
  );

  // Local asset-agent discovery (Phase 10).
  ipcMain.handle(IPC.assetAgentSnapshot, () => assetAgentDiscovery.snapshot());
  ipcMain.handle(IPC.assetAgentScan, () => assetAgentDiscovery.scan());
  ipcMain.handle(IPC.assetAgentSetPreferLocal, (_e, enabled: boolean) =>
    assetAgentDiscovery.setPreferLocal(enabled === true),
  );

  // Tray "Nexus apps": the settings panel shows what the tray would list.
  ipcMain.handle(IPC.trayAppsList, async () => {
    if (!identityManager.hasActiveSession()) return [];
    const installed = await loadInstalledApps();
    return resolveTrayApps({ installed, settings: settings.getUiSettings().trayApps }).filter(
      (item) => item.source === 'installed',
    );
  });
  ipcMain.handle(IPC.trayAppsResolved, async () => {
    if (!identityManager.hasActiveSession()) {
      // Signed out: the tray still shows the user's custom entries.
      return resolveTrayApps({ installed: [], settings: settings.getUiSettings().trayApps });
    }
    try {
      return await resolveTrayAppItems();
    } catch {
      return resolveTrayApps({ installed: [], settings: settings.getUiSettings().trayApps });
    }
  });

  // Immersive companion window (Phase 7a).
  ipcMain.handle(IPC.companionOpen, (_e, launch: CompanionLaunch) => {
    const result = companionWindows.open(launch);
    // Start the OS-global cursor sampler as soon as a companion exists.
    if (companionWindows.openContactIds().length > 0) companionCursor.start();
    return result;
  });
  ipcMain.handle(IPC.companionClose, (_e, contactId: string) => {
    const closed = companionWindows.close(contactId);
    if (companionWindows.openContactIds().length === 0) companionCursor.stop();
    return closed;
  });
  ipcMain.handle(IPC.companionList, () => companionWindows.openContactIds());
  // The launch title is a hint frozen at window-create time, so the companion
  // renderer reports the label it resolved from the live session and main applies
  // it to the OS caption. Without this a companion opened before its contact/room
  // resolved would keep the neutral `Nexus Companion` caption forever.
  ipcMain.handle(IPC.companionTitle, (_e, report: CompanionTitleReport) => {
    if (!report || typeof report.contactId !== 'string') return false;
    return companionWindows.retitle(report);
  });
  // Deliverable 3: open/close a companion context-menu tool ("Motion feed" /
  // "Gestures" / "Status motions") in its own BrowserWindow, scoped to the
  // current agent/contact so its per-agent settings never leak across windows.
  ipcMain.handle(IPC.companionOpenTool, (_e, input: CompanionToolLaunch) => {
    const tool = normalizeCompanionToolId(input?.tool);
    const contactId = typeof input?.contactId === 'string' ? input.contactId.trim() : '';
    if (!tool || !contactId) return null;
    return companionWindows.openTool({
      tool,
      contactId,
      agentName: typeof input.agentName === 'string' ? input.agentName : null,
      // The tool window resolves the same live session as its companion, so the
      // conversation binding is carried through (never invented when absent).
      conversationId: typeof input.conversationId === 'string' ? input.conversationId : null,
      agentId: typeof input.agentId === 'string' ? input.agentId : null,
      virtualEmployeeId: typeof input.virtualEmployeeId === 'string' ? input.virtualEmployeeId : null,
    });
  });
  ipcMain.handle(IPC.companionCloseTool, (_e, contactId: string, tool?: string) => {
    const id = typeof contactId === 'string' ? contactId.trim() : '';
    if (!id) return false;
    return companionWindows.closeTool(id, normalizeCompanionToolId(tool) ?? undefined);
  });
  // Deliverable 3 relay: a companion publishes the tool-scoped state its detached
  // tool windows render (tagged per contact), and a tool window pushes a
  // status-motions edit back to the agent's companion. Both are scoped by
  // contact id so several agents' windows never cross their settings.
  ipcMain.handle(IPC.companionToolPublish, (_e, snapshot: CompanionToolSnapshot) => {
    if (!snapshot || typeof snapshot.contactId !== 'string') return false;
    return companionWindows.publishToolSnapshot(snapshot);
  });
  ipcMain.handle(IPC.companionToolSync, (_e, sync: CompanionToolSync) => {
    if (!sync || typeof sync.contactId !== 'string') return false;
    return companionWindows.syncToolState(sync);
  });
  // Deliverable 2: the local VRM/GLB avatar library. `pick` opens the native
  // file dialog and copies the chosen model(s) into the library; `remove` deletes
  // an entry; `set-mapping` remembers which library avatar one agent renders with.
  // Every handler returns the whole config so the renderer never has to round-trip.
  ipcMain.handle(IPC.localAvatarsList, () => localAvatarStore.get());
  ipcMain.handle(IPC.localAvatarsPick, async () => {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const picked = await dialog.showOpenDialog(win!, {
      title: 'Add a 3D avatar',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '3D avatar', extensions: [...LOCAL_AVATAR_EXTENSIONS].map((e) => e.replace(/^\./, '')) },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (picked.canceled) return localAvatarStore.get();
    let config = localAvatarStore.get();
    // Add each file independently so one bad pick (unsupported / duplicate) does
    // not discard the rest of a multi-select.
    for (const filePath of picked.filePaths) {
      try {
        config = localAvatarStore.addFile(filePath);
      } catch (err) {
        logger.warn('local avatar import skipped', {
          file: filePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return config;
  });
  ipcMain.handle(IPC.localAvatarsRemove, (_e, id: string) =>
    localAvatarStore.remove(typeof id === 'string' ? id : ''),
  );
  ipcMain.handle(IPC.localAvatarsSetMapping, (_e, contactId: string, avatarId: string | null) =>
    localAvatarStore.setContactMapping(
      typeof contactId === 'string' ? contactId : '',
      typeof avatarId === 'string' && avatarId.trim() ? avatarId : null,
    ),
  );
  // Companion (or child) window → main shell: open its Settings surface. The
  // gallery links here for the client-remembered agent ↔ avatar mapping. Focus
  // the main window too, so the settings page the user asked for is visible.
  ipcMain.handle(IPC.openSettings, () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send(IPC.openSettings);
    return true;
  });
  ipcMain.handle(IPC.companionSetAlwaysOnTop, (_e, contactId: string, onTop: boolean) =>
    companionWindows.setAlwaysOnTop(contactId, onTop === true),
  );
  ipcMain.handle(IPC.companionIsAlwaysOnTop, (_e, contactId: string) =>
    companionWindows.isAlwaysOnTop(contactId),
  );
  // Hand a live wake activation to an *open* companion without reloading it (a
  // reload would restart its realtime voice call). Returns false when none is
  // open so the caller can fall back to `companionOpen`.
  ipcMain.handle(IPC.companionPresentRequest, (_e, payload: CompanionPresent) => {
    if (!payload || typeof payload.contactId !== 'string') return false;
    const delivered = companionWindows.present(payload.contactId, payload);
    if (delivered) companionWindows.raise(payload.contactId);
    return delivered;
  });
  // Session-owner (main renderer) → companion: mirror the live wake dictation
  // turn into the companion's STT preview + composer.
  ipcMain.handle(IPC.companionPushSession, (_e, view: CompanionSessionView) => {
    if (!view || typeof view.contactId !== 'string') return false;
    return companionWindows.pushSession(view.contactId, view);
  });
  // Companion → session owner: a composer control (submit/cancel/send-as-voice/
  // edit) is relayed into the window that owns the session.
  ipcMain.handle(IPC.companionAction, (_e, action: CompanionAction) => {
    if (!action || typeof action.contactId !== 'string') return false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.companionActionRelay, action);
      return true;
    }
    return false;
  });

  // Desktop calendar (Phase 7b).
  ipcMain.handle(IPC.calendarListEvents, (_e, input?: CalendarListInput) =>
    calendarManager.listEvents(input ?? {}, viewerUserId()),
  );
  ipcMain.handle(IPC.calendarUpcoming, () => calendarManager.upcoming(viewerUserId()));
  ipcMain.handle(IPC.calendarCreateEvent, (_e, input: CalendarCreateInput) =>
    calendarManager.createEvent(input, viewerUserId()),
  );
  ipcMain.handle(IPC.calendarCancelEvent, (_e, eventId: string) =>
    calendarManager.cancelEvent(eventId),
  );
  ipcMain.handle(IPC.calendarRespond, (_e, eventId: string, status: CalendarAttendeeStatus) =>
    calendarManager.respond(eventId, status, viewerUserId()),
  );
  ipcMain.handle(IPC.calendarOpenJoin, async (_e, eventId: string) => {
    const target = await calendarManager.joinTarget(eventId);
    if (target.roomId) return { opened: false, url: null, roomId: target.roomId };
    if (target.url && /^https?:\/\//i.test(target.url)) {
      await shell.openExternal(target.url);
      return { opened: true, url: target.url };
    }
    return { opened: false, url: null, roomId: null };
  });

  // Meetings / room media (Phase 7c/7d/11).
  ipcMain.handle(IPC.meetingsGetRoom, (_e, roomId: string) => meetingsManager.getRoom(roomId));
  // Phase 11e: the meeting voice bar gates on real capabilities, so the desktop
  // asks the local-voice manager what it can actually serve.
  ipcMain.handle(IPC.meetingsVoiceCapabilities, () => localVoiceManager.voiceCapabilities());

  // Desktop-local speech models (Phase 11e).
  ipcMain.handle(IPC.localVoiceState, () => localVoiceManager.getState());
  ipcMain.handle(IPC.localVoiceSetSettings, (_e, patch) =>
    localVoiceManager.setSettings(patch ?? {}),
  );
  ipcMain.handle(IPC.localVoiceRefreshCatalog, () => localVoiceManager.refreshCatalog());
  ipcMain.handle(IPC.localVoiceInstall, (_e, modelId: string) => localVoiceManager.install(modelId));
  ipcMain.handle(IPC.localVoiceCancelInstall, (_e, modelId: string) =>
    localVoiceManager.cancelInstall(modelId),
  );
  ipcMain.handle(IPC.localVoiceRemove, (_e, modelId: string) => localVoiceManager.remove(modelId));
  ipcMain.handle(IPC.localVoiceProbeResources, () => localVoiceManager.probeResources());
  // Speech-engine runner binary: check / install / remove the `whisper-server`
  // the local STT + wake engines spawn (see voice-binaries.ts).
  ipcMain.handle(IPC.voiceBinaryStatus, () => voiceBinaries.status());
  ipcMain.handle(IPC.voiceBinaryInstall, () => voiceBinaries.install());
  ipcMain.handle(IPC.voiceBinaryCancelInstall, () => voiceBinaries.cancelInstall());
  ipcMain.handle(IPC.voiceBinaryRemove, () => voiceBinaries.remove());
  // faster-whisper GPU engine: private Python runtime for near-realtime STT.
  ipcMain.handle(IPC.gpuSttStatus, () => gpuStt.status());
  ipcMain.handle(IPC.gpuSttInstall, () => gpuStt.install());
  ipcMain.handle(IPC.gpuSttCancelInstall, () => {
    gpuStt.cancelInstall();
    return gpuStt.status();
  });
  ipcMain.handle(IPC.gpuSttRemove, () => {
    gpuStt.remove();
    return gpuStt.status();
  });

  ipcMain.handle(IPC.openExternal, async (_e, url: string) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      throw new Error('refusing to open a non-http(s) url');
    }
    await shell.openExternal(url);
  });
}

// Dev-only: expose the Chrome DevTools Protocol on a local port so automated
// checks can inspect the live renderer DOM/state. Gated on both `isDev` and an
// explicit env value so it can never open in a packaged app.
if (isDev && process.env.NEXUS_REMOTE_DEBUG) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.NEXUS_REMOTE_DEBUG);
}

app.whenReady().then(async () => {
  // Windows groups taskbar buttons by AppUserModelID and picks the taskbar icon
  // from the matching shortcut. Without this the window icon set below is
  // ignored on Windows and the app shows up as a generic Electron entry.
  app.setAppUserModelId(DESKTOP_APP_ID);
  // Predictable local paths for the structured log + the append-only client-tool
  // audit trail, so both are discoverable without digging through userData.
  logger.info('desktop starting', {
    version: app.getVersion(),
    logFile: logger.filePath(),
    auditFile: auditStore.filePath(),
    retention: auditStore.getRetention(),
  });
  applyEnvConnectionOverrides();
  // Serve locally-stored avatar models over `nexus-avatar:` (Deliverable 2).
  // `protocol.handle` must run after the app is ready; the scheme privileges were
  // registered at module load (see `registerSchemesAsPrivileged`).
  installLocalAvatarProtocol();
  // Deny every session permission the app does not need (geolocation, MIDI, HID,
  // USB, serial, …) without a prompt; keep only media / screen-share / fullscreen
  // for the app's own renderer. Installed before any window exists.
  installPermissionGuard(session.defaultSession as unknown as SessionLike, trustedRendererUrls);
  registerIpc();
  createTray();
  localVoiceManager.start();
  syncManager.start();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  // With a tray the app keeps running (and receiving messages) with no window;
  // quitting is explicit via the tray menu or `before-quit`.
  if (process.platform !== 'darwin' && isQuitting) app.quit();
});

// The loopback runner must not outlive the app; close it before we exit.
app.on('before-quit', () => {
  isQuitting = true;
  tray?.destroy();
  tray = null;
  companionWindows.closeAll();
  companionCursor.stop();
  syncManager.stop();
  mountDaemon.dispose();
  void localVoiceManager.dispose();
  void runnerManager.dispose();
});
