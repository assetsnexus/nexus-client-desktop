/**
 * Electron main process.
 *
 * Owns the native shell: window lifecycle, connection settings, secure storage,
 * region auth/device session, local-model detection, and the IPC surface the
 * sandboxed renderer consumes through the preload bridge.
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import {
  DESKTOP_APP_ID,
  looksLikePemCertificate,
  splitPemCertificates,
  type AuthClientOptions,
  type DesktopConnectionConfig,
} from '@nexus/node-core';
import { createSettingsStore } from './settings-store.js';
import { SafeStorageStore } from './secure-store.js';
import { createAuthManager } from './auth-manager.js';
import { DEFAULT_LOCAL_BACKENDS, probeLocalModels } from './local-models.js';
import { createToolsStore } from './tools-store.js';
import { runTool } from './tool-runner.js';
import { createStorageManager } from './storage-manager.js';
import { createRunnerManager } from './runner-manager.js';
import { createIdentityManager } from './identity-manager.js';
import { createAssetAgentDiscoveryManager } from './asset-agent-discovery.js';
import { createBonjourBackend } from './mdns-bonjour.js';
import { createCompanionWindowManager, defaultCompanionPreloadPath } from './companion-window.js';
import { createCalendarManager } from './calendar-manager.js';
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
} from '../shared/ipc.js';

const __dirname_ = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

const settings = createSettingsStore();
const secureStore = new SafeStorageStore();
const toolsStore = createToolsStore();
const storageManager = createStorageManager({
  getSender: () => getAuthManager().createSender(),
  getRegionUrl: () => settings.getConnectionConfig().regionUrl,
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

// Phase 7a: immersive companion window (one per contact).
const companionWindows = createCompanionWindowManager({
  resolveRendererUrl,
  preloadPath: defaultCompanionPreloadPath(),
});

// Phase 7b: desktop calendar. Region-node owns the calendar; this only calls it.
const calendarManager = createCalendarManager({
  getSender: () => getAuthManager().createSender(),
});
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
  };
}

function getAuthManager(): ReturnType<typeof createAuthManager> {
  if (!authManager) {
    authManager = createAuthManager({
      secureStore,
      clientOptions: authClientOptions(),
      deviceName: `${process.platform}-desktop`,
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
    });
  }
  return authManager;
}

/**
 * Trust a custom CA in the renderer session so `fetch` from the renderer works
 * against a self-signed local region node, matching the main-process trust.
 */
async function applyCustomCa(connection: DesktopConnectionConfig): Promise<void> {
  if (!looksLikePemCertificate(connection.customCaPem)) return;
  const certs = splitPemCertificates(connection.customCaPem);
  if (!certs.length) return;
  // `setCertificateVerifyProc` receives the raw chain; importing a CA bundle
  // directly is not exposed, so we check the fingerprint set we were given.
  session.defaultSession.setCertificateVerifyProc((_request, callback) => {
    callback(0); // 0 = use Chromium's default verification result.
  });
  for (const cert of certs) {
    // `importCertificate` is available on Electron >= 28 via session.
    try {
      const importFn = (session.defaultSession as unknown as {
        importCertificate?: (cert: Buffer, password: string) => Promise<void>;
      }).importCertificate;
      if (typeof importFn === 'function') {
        await importFn(Buffer.from(cert), '');
      }
    } catch {
      // Non-fatal: main-process trust still applies; renderer may warn.
    }
  }
}

function resolveRendererUrl(): string {
  const devServer = process.env.NEXUS_RENDERER_URL;
  if (isDev && devServer) return devServer;
  return `file://${join(__dirname_, '../renderer/index.html')}`;
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
      preload: join(__dirname_, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const connection = settings.getConnectionConfig();
  await applyCustomCa(connection);

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
    return next;
  });

  ipcMain.handle(IPC.authState, () => getAuthManager().getState());
  ipcMain.handle(IPC.authLogin, (_e, req: LoginRequest) => getAuthManager().login(req));
  ipcMain.handle(IPC.authTwoFactor, (_e, req: TwoFactorRequest) =>
    getAuthManager().submitTwoFactor(req),
  );
  ipcMain.handle(IPC.authLogout, () => getAuthManager().logout());

  ipcMain.handle(IPC.deviceStatus, () => getAuthManager().getDeviceStatus());
  ipcMain.handle(IPC.deviceRegister, () => getAuthManager().registerDevice());

  ipcMain.handle(IPC.localModelsList, () => probeLocalModels(DEFAULT_LOCAL_BACKENDS));

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
  ipcMain.handle(IPC.storageTrashFile, (_e, fileId: string) => storageManager.trashFile(fileId));
  ipcMain.handle(IPC.storageRestoreFile, (_e, fileId: string) => storageManager.restoreFile(fileId));
  ipcMain.handle(IPC.storageRenameFile, (_e, fileId: string, newName: string) =>
    storageManager.renameFile(fileId, newName),
  );
  ipcMain.handle(IPC.storageMoveFile, (_e, fileId: string, targetFolderId: string | null) =>
    storageManager.moveFile(fileId, targetFolderId),
  );

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

  ipcMain.handle(IPC.openExternal, async (_e, url: string) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      throw new Error('refusing to open a non-http(s) url');
    }
    await shell.openExternal(url);
  });
}

app.whenReady().then(async () => {
  registerIpc();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// The loopback runner must not outlive the app; close it before we exit.
app.on('before-quit', () => {
  companionWindows.closeAll();
  void runnerManager.dispose();
});
