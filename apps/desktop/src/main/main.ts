/**
 * Electron main process.
 *
 * Owns the native shell: window lifecycle, connection settings, secure storage,
 * region auth/device session, local-model detection, and the IPC surface the
 * sandboxed renderer consumes through the preload bridge.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, nativeImage, Notification, session, shell, Tray } from 'electron';
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
import { createCustomCaVerifier } from './custom-ca.js';
import { createSettingsStore } from './settings-store.js';
import { SafeStorageStore } from './secure-store.js';
import { createAuthManager } from './auth-manager.js';
import { readRegionEnvironment } from './region-environment.js';
import { probeBackend, probeLocalModels } from './local-models.js';
import { createLocalModelsStore } from './local-models-store.js';
import { createToolsStore } from './tools-store.js';
import { runTool } from './tool-runner.js';
import { createStorageManager } from './storage-manager.js';
import { createSyncManager } from './sync-manager.js';
import { createMountDaemon } from './mount-daemon.js';
import { createRunnerManager } from './runner-manager.js';
import { createIdentityManager } from './identity-manager.js';
import { createAssetAgentDiscoveryManager } from './asset-agent-discovery.js';
import { createBonjourBackend } from './mdns-bonjour.js';
import { createCompanionWindowManager, defaultCompanionPreloadPath } from './companion-window.js';
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
import { normalizeWakeBinding } from '../shared/wake.js';
import { createWakeManager } from './wake-manager.js';
import { createWakeAgentDirectory } from './wake-agents.js';
import {
  IPC,
  type CalendarAttendeeStatus,
  type CalendarCreateInput,
  type CalendarListInput,
  type CompanionLaunch,
  type ConnectionConfigPatch,
  type LocalRunnerSettings,
  type LoginRequest,
  type StorageUploadRequest,
  type ToolInvocation,
  type TwoFactorRequest,
  type UiSettings,
} from '../shared/ipc.js';

// The main + preload bundles are emitted as CJS (see scripts/build-main.mjs /
// dev.mjs), so `import.meta.url` is empty and unusable here. Node's CJS loader
// provides `__dirname` for the running `dist-electron/main.cjs`, which is the
// directory both the dev renderer URL and the packaged preload path resolve against.
const __dirname_ = __dirname;
const isDev = !app.isPackaged;

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

// Desktop-local model instances (Ollama / ComfyUI). The user may configure
// several and have a job routed to the first available (or least-busy, or a
// round-robin) one. Probing never throws; a dead box just drops out of rotation.
const localModelsStore = createLocalModelsStore();

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
  // Spawn the runner the app installed into its data folder when present; fall
  // back to PATH resolution otherwise.
  binaryResolver: (command) => voiceBinaries.resolveBinary(command),
  // Tell "install a model" apart from "install the runner" for the UI.
  runnerInstalled: () => voiceBinaries.isInstalled(),
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
  onActivate: (activation) => {
    showMainWindow();
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
// (the chat SPA is not mounted while settings is open).
const wakeAgentDirectory = createWakeAgentDirectory({
  getSender: () => getAuthManager().createSender(),
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
 * window; the context menu offers show/quit.
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
  const menu = Menu.buildFromTemplate([
    { label: 'Show Nexus', click: () => showMainWindow() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (mainWindow?.isVisible() && mainWindow.isFocused()) mainWindow.hide();
    else showMainWindow();
  });
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
}

/**
 * Trust a custom CA in the renderer session so `fetch` from the renderer works
 * against a self-signed local region node, matching the main-process trust.
 *
 * The verify proc is a *pin*, not a bypass: we accept a chain only when the
 * presented leaf is genuinely issued by a certificate we were explicitly given
 * in `customCaPem`. Chromium only hands us the leaf for a private/self-signed CA
 * (no issuer chain), so we cannot compare fingerprints against the CA bundle —
 * instead we verify the leaf's signature against the CA public key, check
 * validity windows, and check the leaf covers the requested host. An empty or
 * missing CA reverts to Chromium's default verification (never a blanket accept).
 */
async function applyCustomCa(connection: DesktopConnectionConfig): Promise<void> {
  if (!looksLikePemCertificate(connection.customCaPem)) {
    // No custom CA configured: restore default verification in case a previous
    // session (e.g. after a settings change) had installed a pin.
    session.defaultSession.setCertificateVerifyProc(null);
    return;
  }
  const trusted = certificateFingerprints(connection.customCaPem);
  if (!trusted.size) return;
  const verify = createCustomCaVerifier(connection.customCaPem, trusted);
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    callback(verify(request));
  });
}

function resolveRendererUrl(): string {
  const devServer = process.env.NEXUS_RENDERER_URL;
  if (isDev && devServer) return devServer;
  // Vite emits to dist/renderer/index.html (see vite.config.ts outDir), so from
  // __dirname_ (dist-electron) it is a sibling `dist/` folder, not `renderer/`.
  return `file://${join(__dirname_, '../dist/renderer/index.html')}`;
}

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

function registerIpc(): void {
  ipcMain.handle(IPC.version, () => app.getVersion());

  ipcMain.handle(IPC.configGet, () => settings.getConnectionConfig());
  ipcMain.handle(IPC.configSet, (_e, patch: ConnectionConfigPatch) => {
    const next = settings.setConnectionConfig(patch ?? {});
    authManager = null; // rebuild client options against the new region
    // Re-pin the renderer's certificate trust so a CA change takes effect
    // without an app restart (main-process fetch resolves it per call).
    void applyCustomCa(next);
    return next;
  });

  ipcMain.handle(IPC.uiSettingsGet, () => settings.getUiSettings());
  ipcMain.handle(IPC.uiSettingsSet, (_e, patch: Partial<UiSettings>) =>
    settings.setUiSettings(patch ?? {}),
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
    async (_e, payload: { pcm?: ArrayBuffer | Uint8Array; sampleRate?: number }) => {
      const raw = payload?.pcm;
      if (!raw) return null;
      const pcm =
        raw instanceof Float32Array
          ? raw
          : raw instanceof Uint8Array
            ? new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4))
            : new Float32Array(raw as ArrayBuffer);
      const sampleRate = Number(payload?.sampleRate) || 16_000;
      return wakeStt.transcribe(pcm, sampleRate);
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
  ipcMain.handle(IPC.toolsRun, (_e, req: ToolInvocation) => runTool(req as never, { store: toolsStore }));

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
  ipcMain.handle(IPC.identityListMemberships, () => identityManager.listMemberships());
  ipcMain.handle(IPC.identitySwitch, (_e, key: string) => identityManager.switchIdentity(key));
  ipcMain.handle(IPC.identitySwitchAccount, (_e, userId: string) => identityManager.switchAccount(userId));
  ipcMain.handle(IPC.identityLogout, (_e, key?: string) => identityManager.logout(key));
  ipcMain.handle(
    IPC.identityStartMembership,
    (_e, req: { membershipId: string; businessEmail: string; password?: string }) =>
      identityManager.startMembership(req),
  );
  ipcMain.handle(
    IPC.identityCompleteMembership,
    (_e, req: { loginToken: string; method: string; code: string; businessEmail?: string }) =>
      identityManager.completeMembership(req),
  );

  // Local asset-agent discovery (Phase 10).
  ipcMain.handle(IPC.assetAgentSnapshot, () => assetAgentDiscovery.snapshot());
  ipcMain.handle(IPC.assetAgentScan, () => assetAgentDiscovery.scan());
  ipcMain.handle(IPC.assetAgentSetPreferLocal, (_e, enabled: boolean) =>
    assetAgentDiscovery.setPreferLocal(enabled === true),
  );

  // Immersive companion window (Phase 7a).
  ipcMain.handle(IPC.companionOpen, (_e, launch: CompanionLaunch) =>
    companionWindows.open(launch),
  );
  ipcMain.handle(IPC.companionClose, (_e, contactId: string) => companionWindows.close(contactId));
  ipcMain.handle(IPC.companionList, () => companionWindows.openContactIds());

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

  ipcMain.handle(IPC.openExternal, async (_e, url: string) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      throw new Error('refusing to open a non-http(s) url');
    }
    await shell.openExternal(url);
  });
}

app.whenReady().then(async () => {
  // Windows groups taskbar buttons by AppUserModelID and picks the taskbar icon
  // from the matching shortcut. Without this the window icon set below is
  // ignored on Windows and the app shows up as a generic Electron entry.
  app.setAppUserModelId(DESKTOP_APP_ID);
  applyEnvConnectionOverrides();
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
  syncManager.stop();
  mountDaemon.dispose();
  void localVoiceManager.dispose();
  void runnerManager.dispose();
});
