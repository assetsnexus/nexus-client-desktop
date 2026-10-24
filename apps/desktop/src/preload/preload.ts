/**
 * Preload bridge.
 *
 * Runs with contextIsolation and exposes a single, explicit `window.nexus`
 * surface backed by `ipcRenderer.invoke`. No Node APIs leak to the renderer.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC, type CertificatePromptInfo, type CompanionCursorCoords, type DesktopNotificationPayload, type NexusBridge, type StorageTransferProgress } from '../shared/ipc.js';

const bridge: NexusBridge = {
  getVersion: () => ipcRenderer.invoke(IPC.version),
  getConnectionConfig: () => ipcRenderer.invoke(IPC.configGet),
  setConnectionConfig: (patch) => ipcRenderer.invoke(IPC.configSet, patch),
  getUiSettings: () => ipcRenderer.invoke(IPC.uiSettingsGet),
  setUiSettings: (patch) => ipcRenderer.invoke(IPC.uiSettingsSet, patch),
  certTrustList: () => ipcRenderer.invoke(IPC.certTrustList),
  certTrustRevoke: (host, fingerprint) => ipcRenderer.invoke(IPC.certTrustRevoke, host, fingerprint),
  certTrustRespond: (decision) => ipcRenderer.invoke(IPC.certTrustRespond, decision),
  onCertTrustPrompt: (listener) => {
    const handler = (_e: unknown, info: CertificatePromptInfo) => listener(info);
    ipcRenderer.on(IPC.certTrustPrompt, handler);
    return () => ipcRenderer.removeListener(IPC.certTrustPrompt, handler);
  },
  notifyIncoming: (payload, opts) => ipcRenderer.invoke(IPC.notifyIncoming, payload, opts),
  onNotificationActivated: (listener) => {
    const handler = (_e: unknown, payload: DesktopNotificationPayload) => listener(payload);
    ipcRenderer.on(IPC.notifyActivated, handler);
    return () => ipcRenderer.removeListener(IPC.notifyActivated, handler);
  },
  wakeGetSettings: () => ipcRenderer.invoke(IPC.wakeGetSettings),
  wakeSetSettings: (next) => ipcRenderer.invoke(IPC.wakeSetSettings, next),
  wakeListAgents: () => ipcRenderer.invoke(IPC.wakeListAgents),
  wakeResolveBinding: (binding) => ipcRenderer.invoke(IPC.wakeResolveBinding, binding),
  wakeReportState: (state) => ipcRenderer.invoke(IPC.wakeReportState, state),
  wakeActivated: (payload) => ipcRenderer.invoke(IPC.wakeActivated, payload),
  onWakeActivated: (listener) => {
    const handler = (_e: unknown, payload: { phrase: string; agentId: string | null }) =>
      listener(payload);
    ipcRenderer.on(IPC.wakeActivated, handler);
    return () => ipcRenderer.removeListener(IPC.wakeActivated, handler);
  },
  wakeGetQueue: () => ipcRenderer.invoke(IPC.wakeGetQueue),
  wakeSetQueue: (queue) => ipcRenderer.invoke(IPC.wakeSetQueue, queue),
  wakeSttStatus: () => ipcRenderer.invoke(IPC.wakeSttStatus),
  wakeTranscribeLocal: (input) => ipcRenderer.invoke(IPC.wakeTranscribeLocal, input),
  getAuthState: () => ipcRenderer.invoke(IPC.authState),
  login: (req) => ipcRenderer.invoke(IPC.authLogin, req),
  submitTwoFactor: (req) => ipcRenderer.invoke(IPC.authTwoFactor, req),
  authSwitchTwoFactor: (method) => ipcRenderer.invoke(IPC.authSwitchTwoFactor, method),
  authListCountries: () => ipcRenderer.invoke(IPC.authListCountries),
  authListRegions: () => ipcRenderer.invoke(IPC.authListRegions),
  authRegionEnvironment: () => ipcRenderer.invoke(IPC.authRegionEnvironment),
  authStartPasswordless: (input) => ipcRenderer.invoke(IPC.authPasswordlessStart, input),
  authVerifyPasswordless: (input) => ipcRenderer.invoke(IPC.authPasswordlessVerify, input),
  authResendPasswordless: (input) => ipcRenderer.invoke(IPC.authPasswordlessResend, input),
  authCancelChallenge: () => ipcRenderer.invoke(IPC.authCancelChallenge),
  authDeviceLinkStart: () => ipcRenderer.invoke(IPC.authDeviceLinkStart),
  authDeviceLinkPoll: () => ipcRenderer.invoke(IPC.authDeviceLinkPoll),
  logout: () => ipcRenderer.invoke(IPC.authLogout),
  hydrateSession: () => ipcRenderer.invoke(IPC.authHydrate),
  appLockGetState: () => ipcRenderer.invoke(IPC.appLockGetState),
  appLockSetPin: (pin) => ipcRenderer.invoke(IPC.appLockSetPin, pin),
  appLockClearPin: () => ipcRenderer.invoke(IPC.appLockClearPin),
  appLockUpdateSettings: (patch) => ipcRenderer.invoke(IPC.appLockUpdateSettings, patch),
  appLockNoteActivity: () => ipcRenderer.invoke(IPC.appLockNoteActivity),
  appLockEvaluate: () => ipcRenderer.invoke(IPC.appLockEvaluate),
  appLockUnlock: (pin) => ipcRenderer.invoke(IPC.appLockUnlock, pin),
  appLockLock: () => ipcRenderer.invoke(IPC.appLockLock),
  logoutRun: (choice) => ipcRenderer.invoke(IPC.logoutRun, choice),
  logoutRetry: (steps, choice) => ipcRenderer.invoke(IPC.logoutRetry, steps, choice),
  getDeviceStatus: () => ipcRenderer.invoke(IPC.deviceStatus),
  registerDevice: () => ipcRenderer.invoke(IPC.deviceRegister),
  listLocalModels: (refresh) => ipcRenderer.invoke(IPC.localModelsList, refresh),
  localModelsGetConfig: () => ipcRenderer.invoke(IPC.localModelsGetConfig),
  localModelsUpsert: (instance) => ipcRenderer.invoke(IPC.localModelsUpsert, instance),
  localModelsRemove: (id) => ipcRenderer.invoke(IPC.localModelsRemove, id),
  localModelsSetPolicy: (policy) => ipcRenderer.invoke(IPC.localModelsSetPolicy, policy),
  localModelsTest: (instance) => ipcRenderer.invoke(IPC.localModelsTest, instance),
  getToolsConfig: () => ipcRenderer.invoke(IPC.toolsGet),
  setWorkspaces: (workspaces) => ipcRenderer.invoke(IPC.toolsSetWorkspaces, workspaces),
  setLocalCommands: (commands) => ipcRenderer.invoke(IPC.toolsSetLocalCommands, commands),
  runTool: (req) => ipcRenderer.invoke(IPC.toolsRun, req),
  // Read-only audit trail + the configurable retention setting. No mutation
  // channel exists (see `shared/ipc.ts`); the store is main-process only.
  auditSnapshot: (filter) => ipcRenderer.invoke(IPC.auditSnapshot, filter),
  auditSetRetention: (retention) => ipcRenderer.invoke(IPC.auditSetRetention, retention),
  storageWorkspaces: () => ipcRenderer.invoke(IPC.storageWorkspaces),
  storageFolderList: (workspaceId, parentFolderId) =>
    ipcRenderer.invoke(IPC.storageFolderList, workspaceId, parentFolderId),
  storageListFiles: (input) => ipcRenderer.invoke(IPC.storageListFiles, input),
  storageCapabilities: (kind) => ipcRenderer.invoke(IPC.storageCapabilities, kind),
  storageUpload: (req) => ipcRenderer.invoke(IPC.storageUpload, req),
  storageDownloadUrl: (fileId) => ipcRenderer.invoke(IPC.storageDownloadUrl, fileId),
  storageListRevisions: (fileId, limit) => ipcRenderer.invoke(IPC.storageListRevisions, fileId, limit),
  storageRevertRevision: (fileId, revisionNo) => ipcRenderer.invoke(IPC.storageRevertRevision, fileId, revisionNo),
  storageTrashFile: (fileId) => ipcRenderer.invoke(IPC.storageTrashFile, fileId),
  storageRestoreFile: (fileId) => ipcRenderer.invoke(IPC.storageRestoreFile, fileId),
  storageRenameFile: (fileId, newName) => ipcRenderer.invoke(IPC.storageRenameFile, fileId, newName),
  storageMoveFile: (fileId, targetFolderId) =>
    ipcRenderer.invoke(IPC.storageMoveFile, fileId, targetFolderId),
  // Drag-and-drop transfer. `onStorageTransferProgress` pairs with main's
  // `IPC.storageTransferProgress` push so the renderer sees real byte counts.
  storageExpandDrop: (paths) => ipcRenderer.invoke(IPC.storageExpandDrop, paths),
  storageUploadOne: (req) => ipcRenderer.invoke(IPC.storageUploadOne, req),
  storageTransferCancel: (transferId) => ipcRenderer.invoke(IPC.storageTransferCancel, transferId),
  onStorageTransferProgress: (listener) => {
    const handler = (_e: unknown, progress: StorageTransferProgress) => listener(progress);
    ipcRenderer.on(IPC.storageTransferProgress, handler);
    return () => ipcRenderer.removeListener(IPC.storageTransferProgress, handler);
  },
  storageDownloadLink: (fileId) => ipcRenderer.invoke(IPC.storageDownloadLink, fileId),
  storageSaveFile: (fileId, suggestedName) => ipcRenderer.invoke(IPC.storageSaveFile, fileId, suggestedName),
  storageSaveFilesToDir: (files) => ipcRenderer.invoke(IPC.storageSaveFilesToDir, files),
  storagePrepareDrag: (fileId, name) => ipcRenderer.invoke(IPC.storagePrepareDrag, fileId, name),
  storageStartDrag: (fileId, name) => ipcRenderer.invoke(IPC.storageStartDrag, fileId, name),
  storageReleaseDrag: (fileId) => ipcRenderer.invoke(IPC.storageReleaseDrag, fileId),
  storagePreviewBytes: (fileId) => ipcRenderer.invoke(IPC.storagePreviewBytes, fileId),
  // Electron 32+ removed the `File.path` augmentation; `webUtils.getPathForFile`
  // is the supported replacement and only exists in the (preload) renderer
  // process, so it is exposed here rather than read directly by the sandboxed
  // renderer. This is the pattern from Electron's own 32.x migration guide.
  getPathForFile: (file) => webUtils.getPathForFile(file),
  syncGetState: () => ipcRenderer.invoke(IPC.syncGetState),
  syncListRemoteFolders: (workspaceId) => ipcRenderer.invoke(IPC.syncListRemoteFolders, workspaceId),
  syncAddBinding: (input) => ipcRenderer.invoke(IPC.syncAddBinding, input),
  syncUpdateBinding: (id, patch) => ipcRenderer.invoke(IPC.syncUpdateBinding, id, patch),
  syncRemoveBinding: (id) => ipcRenderer.invoke(IPC.syncRemoveBinding, id),
  syncRunNow: (id) => ipcRenderer.invoke(IPC.syncRunNow, id),
  syncRunAll: () => ipcRenderer.invoke(IPC.syncRunAll),
  syncChooseLocalDir: () => ipcRenderer.invoke(IPC.syncChooseLocalDir),
  onSessionLost: (listener) => {
    const handler = (_e: unknown, loss: { reason: string; deviceRevoked: boolean; message: string }) => listener(loss);
    ipcRenderer.on(IPC.authSessionLost, handler);
    return () => ipcRenderer.removeListener(IPC.authSessionLost, handler);
  },
  mountSnapshot: () => ipcRenderer.invoke(IPC.mountSnapshot),
  mountAddSession: (input) => ipcRenderer.invoke(IPC.mountAddSession, input),
  mountRemoveSession: (id) => ipcRenderer.invoke(IPC.mountRemoveSession, id),
  mountStartSession: (id) => ipcRenderer.invoke(IPC.mountStartSession, id),
  mountStopSession: (id) => ipcRenderer.invoke(IPC.mountStopSession, id),
  mountChooseMountpoint: () => ipcRenderer.invoke(IPC.mountChooseMountpoint),
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
  trayListApps: () => ipcRenderer.invoke(IPC.trayAppsList),
  trayResolvedApps: () => ipcRenderer.invoke(IPC.trayAppsResolved),
  companionOpen: (launch) => ipcRenderer.invoke(IPC.companionOpen, launch),
  companionClose: (contactId) => ipcRenderer.invoke(IPC.companionClose, contactId),
  companionList: () => ipcRenderer.invoke(IPC.companionList),
  companionSetAlwaysOnTop: (contactId, onTop) =>
    ipcRenderer.invoke(IPC.companionSetAlwaysOnTop, contactId, onTop),
  companionIsAlwaysOnTop: (contactId) =>
    ipcRenderer.invoke(IPC.companionIsAlwaysOnTop, contactId),
  /**
   * Main samples the OS-global cursor while a companion is open and pushes a
   * normalized sample per frame-ish tick. Renderer-only subscription; the
   * unsubscribe removes the IPC listener and asks main to stop the sampler.
   */
  onCompanionGlobalCursor: (listener) => {
    const handler = (_e: unknown, coords: CompanionCursorCoords) => listener(coords);
    ipcRenderer.on(IPC.companionGlobalCursor, handler);
    return () => ipcRenderer.removeListener(IPC.companionGlobalCursor, handler);
  },
  calendarListEvents: (input) => ipcRenderer.invoke(IPC.calendarListEvents, input),
  calendarUpcoming: () => ipcRenderer.invoke(IPC.calendarUpcoming),
  calendarCreateEvent: (input) => ipcRenderer.invoke(IPC.calendarCreateEvent, input),
  calendarCancelEvent: (eventId) => ipcRenderer.invoke(IPC.calendarCancelEvent, eventId),
  calendarRespond: (eventId, status) => ipcRenderer.invoke(IPC.calendarRespond, eventId, status),
  calendarOpenJoin: (eventId) => ipcRenderer.invoke(IPC.calendarOpenJoin, eventId),
  meetingsGetRoom: (roomId) => ipcRenderer.invoke(IPC.meetingsGetRoom, roomId),
  meetingsVoiceCapabilities: () => ipcRenderer.invoke(IPC.meetingsVoiceCapabilities),
  localVoiceGetState: () => ipcRenderer.invoke(IPC.localVoiceState),
  localVoiceSetSettings: (patch) => ipcRenderer.invoke(IPC.localVoiceSetSettings, patch),
  localVoiceRefreshCatalog: () => ipcRenderer.invoke(IPC.localVoiceRefreshCatalog),
  localVoiceInstall: (modelId) => ipcRenderer.invoke(IPC.localVoiceInstall, modelId),
  localVoiceCancelInstall: (modelId) => ipcRenderer.invoke(IPC.localVoiceCancelInstall, modelId),
  localVoiceRemove: (modelId) => ipcRenderer.invoke(IPC.localVoiceRemove, modelId),
  localVoiceProbeResources: () => ipcRenderer.invoke(IPC.localVoiceProbeResources),
  voiceBinaryStatus: () => ipcRenderer.invoke(IPC.voiceBinaryStatus),
  voiceBinaryInstall: () => ipcRenderer.invoke(IPC.voiceBinaryInstall),
  voiceBinaryCancelInstall: () => ipcRenderer.invoke(IPC.voiceBinaryCancelInstall),
  voiceBinaryRemove: () => ipcRenderer.invoke(IPC.voiceBinaryRemove),
  gpuSttStatus: () => ipcRenderer.invoke(IPC.gpuSttStatus),
  gpuSttInstall: () => ipcRenderer.invoke(IPC.gpuSttInstall),
  gpuSttCancelInstall: () => ipcRenderer.invoke(IPC.gpuSttCancelInstall),
  gpuSttRemove: () => ipcRenderer.invoke(IPC.gpuSttRemove),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
};

contextBridge.exposeInMainWorld('nexus', bridge);
