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
  connectionFromEnv,
  connectionPatchFromEnv,
  loadDotenvFile,
  parseDotenv,
  resolveEnvFilePath,
  type ConnectionEnv,
  type ConnectionEnvPatch,
  type DotenvMap,
} from './dotenv.js';

export {
  RegionAuthError,
  login,
  listCountries,
  listRegions,
  readIdentity,
  resendPasswordless,
  resolveManagedRegion,
  sendCommand,
  startPasswordless,
  switchLoginTwoFactor,
  twoFactorLogin,
  verifyPasswordless,
  type AuthClientOptions,
  type AuthIdentity,
  type CommandEnvelope,
  type CountryRow,
  type LoginCredentials,
  type LoginMethod,
  type LoginResult,
  type PasswordlessChannel,
  type PasswordlessResendInput,
  type PasswordlessStartResult,
  type PasswordlessVerifyInput,
  type PasswordlessVerifyResult,
  type RegionResponse,
  type RegionRow,
  type SendOptions,
  type TwoFactorChallenge,
  type TwoFactorChallengeHint,
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
  normalizeFingerprint,
  certificateFingerprints,
  parseCertificates,
  certificateFingerprint,
  verifyLeafIssuedByCa,
  isIpLiteral,
  type LeafVerification,
  type LeafVerificationReason,
  type NodeTlsOptions,
} from './tls.js';

export {
  createNodeFetch,
  type MinimalResponse,
  type NodeFetchOptions,
} from './node-fetch.js';

export {
  pollDeviceLink,
  startDeviceLink,
  type DeviceLinkPollResult,
  type DeviceLinkStartInput,
  type DeviceLinkStarted,
} from './device-link.js';

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

export {
  createNodeCommandClient,
  type NodeCommandClient,
  type NodeCommandClientOptions,
} from './command-client.js';

export {
  classifySessionFailure,
  sessionLostFromResult,
  type SessionLoss,
  type SessionLossReason,
  type SessionOk,
} from './session-guard.js';
