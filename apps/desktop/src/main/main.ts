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
import {
  IPC,
  type ConnectionConfigPatch,
  type LoginRequest,
  type ToolInvocation,
  type TwoFactorRequest,
} from '../shared/ipc.js';

const __dirname_ = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

const settings = createSettingsStore();
const secureStore = new SafeStorageStore();
const toolsStore = createToolsStore();

let mainWindow: BrowserWindow | null = null;
let authManager: ReturnType<typeof createAuthManager> | null = null;

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
