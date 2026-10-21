/**
 * Preload bridge.
 *
 * Runs with contextIsolation and exposes a single, explicit `window.nexus`
 * surface backed by `ipcRenderer.invoke`. No Node APIs leak to the renderer.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type NexusBridge } from '../shared/ipc.js';

const bridge: NexusBridge = {
  getVersion: () => ipcRenderer.invoke(IPC.version),
  getConnectionConfig: () => ipcRenderer.invoke(IPC.configGet),
  setConnectionConfig: (patch) => ipcRenderer.invoke(IPC.configSet, patch),
  getAuthState: () => ipcRenderer.invoke(IPC.authState),
  login: (req) => ipcRenderer.invoke(IPC.authLogin, req),
  submitTwoFactor: (req) => ipcRenderer.invoke(IPC.authTwoFactor, req),
  logout: () => ipcRenderer.invoke(IPC.authLogout),
  getDeviceStatus: () => ipcRenderer.invoke(IPC.deviceStatus),
  registerDevice: () => ipcRenderer.invoke(IPC.deviceRegister),
  listLocalModels: (refresh) => ipcRenderer.invoke(IPC.localModelsList, refresh),
  getToolsConfig: () => ipcRenderer.invoke(IPC.toolsGet),
  setWorkspaces: (workspaces) => ipcRenderer.invoke(IPC.toolsSetWorkspaces, workspaces),
  setLocalCommands: (commands) => ipcRenderer.invoke(IPC.toolsSetLocalCommands, commands),
  runTool: (req) => ipcRenderer.invoke(IPC.toolsRun, req),
  storageWorkspaces: () => ipcRenderer.invoke(IPC.storageWorkspaces),
  storageFolderList: (workspaceId, parentFolderId) =>
    ipcRenderer.invoke(IPC.storageFolderList, workspaceId, parentFolderId),
  storageListFiles: (input) => ipcRenderer.invoke(IPC.storageListFiles, input),
  storageCapabilities: (kind) => ipcRenderer.invoke(IPC.storageCapabilities, kind),
  storageUpload: (req) => ipcRenderer.invoke(IPC.storageUpload, req),
  storageDownloadUrl: (fileId) => ipcRenderer.invoke(IPC.storageDownloadUrl, fileId),
  storageTrashFile: (fileId) => ipcRenderer.invoke(IPC.storageTrashFile, fileId),
  storageRestoreFile: (fileId) => ipcRenderer.invoke(IPC.storageRestoreFile, fileId),
  storageRenameFile: (fileId, newName) => ipcRenderer.invoke(IPC.storageRenameFile, fileId, newName),
  storageMoveFile: (fileId, targetFolderId) =>
    ipcRenderer.invoke(IPC.storageMoveFile, fileId, targetFolderId),
  runnerGetState: () => ipcRenderer.invoke(IPC.runnerGetState),
  runnerSetSettings: (patch) => ipcRenderer.invoke(IPC.runnerSetSettings, patch),
  runnerStart: () => ipcRenderer.invoke(IPC.runnerStart),
  runnerStop: () => ipcRenderer.invoke(IPC.runnerStop),
  runnerRegister: () => ipcRenderer.invoke(IPC.runnerRegister),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
};

contextBridge.exposeInMainWorld('nexus', bridge);
