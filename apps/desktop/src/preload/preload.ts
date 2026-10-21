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
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
};

contextBridge.exposeInMainWorld('nexus', bridge);
