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
  identitySnapshot: () => ipcRenderer.invoke(IPC.identitySnapshot),
  identityListMemberships: () => ipcRenderer.invoke(IPC.identityListMemberships),
  identitySwitch: (key) => ipcRenderer.invoke(IPC.identitySwitch, key),
  identitySwitchAccount: (userId) => ipcRenderer.invoke(IPC.identitySwitchAccount, userId),
  identityLogout: (key) => ipcRenderer.invoke(IPC.identityLogout, key),
  identityStartMembership: (req) => ipcRenderer.invoke(IPC.identityStartMembership, req),
  identityCompleteMembership: (req) => ipcRenderer.invoke(IPC.identityCompleteMembership, req),
  assetAgentDiscoverySnapshot: () => ipcRenderer.invoke(IPC.assetAgentSnapshot),
  assetAgentDiscoveryScan: () => ipcRenderer.invoke(IPC.assetAgentScan),
  assetAgentSetPreferLocal: (enabled) => ipcRenderer.invoke(IPC.assetAgentSetPreferLocal, enabled),
  companionOpen: (launch) => ipcRenderer.invoke(IPC.companionOpen, launch),
  companionClose: (contactId) => ipcRenderer.invoke(IPC.companionClose, contactId),
  companionList: () => ipcRenderer.invoke(IPC.companionList),
  calendarListEvents: (input) => ipcRenderer.invoke(IPC.calendarListEvents, input),
  calendarUpcoming: () => ipcRenderer.invoke(IPC.calendarUpcoming),
  calendarCreateEvent: (input) => ipcRenderer.invoke(IPC.calendarCreateEvent, input),
  calendarCancelEvent: (eventId) => ipcRenderer.invoke(IPC.calendarCancelEvent, eventId),
  calendarRespond: (eventId, status) => ipcRenderer.invoke(IPC.calendarRespond, eventId, status),
  calendarOpenJoin: (eventId) => ipcRenderer.invoke(IPC.calendarOpenJoin, eventId),
  meetingsGetRoom: (roomId) => ipcRenderer.invoke(IPC.meetingsGetRoom, roomId),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
};

contextBridge.exposeInMainWorld('nexus', bridge);
