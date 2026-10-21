/**
 * `@nexus/node-core` — headless Nexus client core.
 *
 * Shared by the Electron desktop app (main process) and the sibling `nexus`
 * CLI. Contains no Electron and no browser APIs so both hosts reuse it
 * unchanged.
 */

export {
  DEFAULT_PORTAL_URL,
  DEFAULT_REGION_URL,
  DESKTOP_APP_ID,
  DESKTOP_DEVICE_TYPE,
  isLocalHostname,
  normalizeBaseUrl,
  resolveConnectionConfig,
  type DesktopConnectionConfig,
  type ResolvedConnectionConfig,
} from './config.js';

export {
  RegionAuthError,
  login,
  sendCommand,
  twoFactorLogin,
  type AuthClientOptions,
  type AuthIdentity,
  type CommandEnvelope,
  type LoginCredentials,
  type LoginResult,
  type RegionResponse,
  type SendOptions,
  type TwoFactorChallenge,
  type TwoFactorLoginInput,
} from './auth.js';

export {
  createMemoryDeviceKeyStore,
  ensureDeviceIdentity,
  generateDeviceKeys,
  generateRecoveryCode,
  registerDevice,
  type DeviceKeyStore,
  type DeviceKeys,
  type DeviceRegistrationInput,
  type DeviceRegistrationResult,
} from './device.js';

export {
  createHttpsAgent,
  looksLikePemCertificate,
  splitPemCertificates,
  type NodeTlsOptions,
} from './tls.js';

export {
  createMemorySecureStore,
  scopedKey,
  SECURE_KEYS,
  type SecureStore,
} from './secure-store.js';

export {
  createRegionTransport,
  parseRegionRoutes,
  type ActiveRegion,
  type CommandResult,
  type CommandSender,
  type CreateRegionTransportOptions,
  type RegionRoute,
  type RegionTransportState,
} from './transport.js';
