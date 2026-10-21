/**
 * `@nexus/identity` — multi-identity / multi-account store for the desktop + CLI.
 *
 * Phase 9: keep a private session plus one per org membership, switch org
 * memberships through the shipped `anx.membership.login` flow, and (temporarily)
 * switch between different local Nexus users. Framework-free and region-call
 * boundaries are plain `send` functions, so the whole module is unit-testable.
 */

export {
  activeAccount,
  activeIdentity,
  createIdentityStoreState,
  findAccount,
  identityKey,
  isExpired,
  pruneExpired,
  removeAccount,
  removeIdentity,
  setActiveIdentity,
  switchAccount,
  upsertIdentity,
  type AccountRecord,
  type IdentityKind,
  type IdentityStoreState,
  type StoredIdentity,
} from './store.js';

export {
  MembershipSwitchError,
  completeMembershipLogin,
  listMemberships,
  startMembershipLogin,
  switchLoginTwoFactor,
  type MembershipLoginResult,
  type MembershipRow,
  type MembershipSend,
} from './membership.js';

export {
  createIdentityPersistence,
  type IdentityPersistence,
  type IdentityPersistenceOptions,
} from './persistence.js';
