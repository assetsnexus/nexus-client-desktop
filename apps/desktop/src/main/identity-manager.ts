/**
 * Identity / account manager (Phase 9, main process).
 *
 * Sits on top of the auth manager: records every successful login as a
 * `private` identity, exposes the org-membership switch flow, and lets the user
 * switch between local Nexus accounts (the temporary multi-account switcher).
 *
 * The persisted store keeps the account/identity index; the *token* for the
 * active identity is what the region sender must carry. `activeToken()` is the
 * single source of truth the session/sender layer reads.
 */

import { join } from 'node:path';
import { app } from 'electron';
import {
  activeIdentity,
  completeMembershipLogin,
  createIdentityPersistence,
  createIdentityStoreState,
  identityKey,
  listMemberships,
  removeAccount,
  removeIdentity,
  setActiveIdentity,
  startMembershipLogin,
  switchAccount,
  upsertIdentity,
  type IdentityStoreState,
  type MembershipSend,
  type StoredIdentity,
} from '@nexus/identity';
import type {
  AccountRow,
  IdentitySnapshot,
  MembershipLoginStart,
  MembershipRow,
} from '../shared/ipc.js';

export type IdentityManagerOptions = {
  /** Region command sender (token optional; caller supplies the token per call). */
  getSender: () => Promise<{
    send: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
  }>;
  /** Overridable for tests. */
  filePath?: string;
  /** Whether the temporary multi-account switcher is enabled. */
  accountSwitcherEnabled?: boolean;
};

export type IdentityManager = ReturnType<typeof createIdentityManager>;

export function createIdentityManager(options: IdentityManagerOptions) {
  const persistence = createIdentityPersistence({
    filePath: options.filePath ?? join(app.getPath('userData'), 'identities.json'),
  });
  let state: IdentityStoreState = persistence.load();
  if (options.accountSwitcherEnabled === false) state = { ...state, accountSwitcherEnabled: false };

  function snapshot(): IdentitySnapshot {
    const accounts: AccountRow[] = state.accounts.map((a) => ({
      userId: a.userId,
      email: a.email,
      active: a.userId === state.activeUserId,
      identities: a.identities.map((i) => ({
        key: i.key,
        kind: i.kind,
        userId: i.userId,
        orgId: i.orgId,
        role: i.role,
        label: i.label,
        expiresAt: i.expiresAt,
        active: a.userId === state.activeUserId && a.activeKey === i.key,
      })),
    }));
    return {
      accounts,
      accountSwitcherEnabled: state.accountSwitcherEnabled,
      activeUserId: state.activeUserId,
    };
  }

  function persist(next: IdentityStoreState): IdentitySnapshot {
    state = next;
    persistence.save(state);
    return snapshot();
  }

  function storeBusiness(
    businessEmail: string,
    token: string,
    orgId: string | null,
    role: string | null,
    userId: string | null,
  ): IdentitySnapshot {
    const uid = userId ?? state.activeUserId ?? '';
    if (!uid || !orgId) return snapshot();
    const identity: StoredIdentity = {
      key: identityKey({ kind: 'business', userId: uid, orgId }),
      kind: 'business',
      userId: uid,
      orgId,
      role,
      token,
      deviceId: activeIdentity(state)?.deviceId ?? null,
      label: businessEmail || orgId,
      expiresAt: null,
    };
    return persist(upsertIdentity(state, identity));
  }

  return {
    getSnapshot: snapshot,

    /** The token the region sender should carry (active identity). */
    activeToken(): string | null {
      return activeIdentity(state)?.token ?? null;
    },

    /**
     * The active session record (userId/orgId/role/deviceId) — the identity the
     * token belongs to. Consumed by the auth manager to rebuild its in-memory
     * identity after a restart, where only the persisted store survives.
     */
    activeSession(): {
      userId: string | null;
      orgId: string | null;
      role: string | null;
      deviceId: string | null;
    } | null {
      const identity = activeIdentity(state);
      if (!identity) return null;
      return {
        userId: identity.userId,
        orgId: identity.orgId,
        role: identity.role,
        deviceId: identity.deviceId,
      };
    },

    /** True when any stored session is active (a signed-in shell). */
    hasActiveSession(): boolean {
      return activeIdentity(state) !== null;
    },

    /**
     * Every stored session (token-bearing), used by the tray app provider: the
     * "installed apps" list is identity-scoped, so it queries once per session
     * (personal + each org membership) and unions the results. Read-only — it
     * never changes the active identity.
     */
    listSessions(): Array<{
      key: string;
      userId: string | null;
      orgId: string | null;
      label: string;
      token: string;
      deviceId: string | null;
    }> {
      return state.accounts.flatMap((account) =>
        account.identities.map((identity) => ({
          key: identity.key,
          userId: identity.userId,
          orgId: identity.orgId,
          label: identity.label,
          token: identity.token,
          // Every authenticated region command is device-gated, so a caller that
          // fans out across sessions must carry each session's own `deviceId`.
          deviceId: identity.deviceId,
        })),
      );
    },

    /** Record a successful auth-manager login as a private identity. */
    recordLogin(input: {
      userId: string;
      email?: string | null;
      orgId?: string | null;
      role?: string | null;
      token: string;
      deviceId?: string | null;
      label?: string;
    }): IdentitySnapshot {
      const identity: StoredIdentity = {
        key: identityKey({ kind: 'private', userId: input.userId, orgId: null }),
        kind: 'private',
        userId: input.userId,
        orgId: null,
        role: input.role ?? null,
        token: input.token,
        deviceId: input.deviceId ?? null,
        label: input.label ?? 'Personal',
        expiresAt: null,
      };
      let next = upsertIdentity(state, identity);
      if (input.email) {
        next = {
          ...next,
          accounts: next.accounts.map((a) =>
            a.userId === input.userId ? { ...a, email: input.email ?? null } : a,
          ),
        };
      }
      return persist(next);
    },

    /** Switch the active identity within the active account (org switch). */
    switchIdentity(key: string): IdentitySnapshot {
      return persist(setActiveIdentity(state, key).state);
    },

    /** Switch the active account (temporary multi-account switcher). */
    switchAccount(userId: string): IdentitySnapshot {
      return persist(switchAccount(state, userId).state);
    },

    /**
     * Log out. With a `key`, removes just that identity; without one, removes the
     * active account entirely.
     */
    logout(key?: string): IdentitySnapshot {
      if (key) {
        const identity = state.accounts.flatMap((a) => a.identities).find((i) => i.key === key);
        if (!identity?.userId) return snapshot();
        return persist(removeIdentity(state, identity.userId, key));
      }
      if (!state.activeUserId) return snapshot();
      return persist(removeAccount(state, state.activeUserId));
    },

    async listMemberships(): Promise<MembershipRow[]> {
      const sender = await options.getSender();
      return listMemberships(sender.send as MembershipSend);
    },

    /**
     * Start an org-membership login. On an immediate session, the resulting token
     * is stored as a `business` identity; on a challenge, the `loginToken` is
     * returned for `completeMembership`.
     */
    async startMembership(input: {
      membershipId: string;
      businessEmail: string;
      password?: string;
    }): Promise<MembershipLoginStart> {
      const sender = await options.getSender();
      const out = await startMembershipLogin(sender.send as MembershipSend, input);
      if (out.kind === 'authenticated') {
        storeBusiness(input.businessEmail, out.token, out.orgId, out.role, out.userId);
        return { kind: 'authenticated', orgId: out.orgId };
      }
      return {
        kind: 'two_factor_required',
        orgId: null,
        loginToken: out.loginToken,
        methods: out.methods,
        methodGroups: out.methodGroups,
        hint: out.hint,
        biometricApprovalRequired: out.biometricApprovalRequired,
        complianceWarnings: out.complianceWarnings,
      };
    },

    /** Complete a membership login challenge and store the business identity. */
    async completeMembership(input: {
      loginToken: string;
      method: string;
      code: string;
      businessEmail?: string;
    }): Promise<IdentitySnapshot> {
      const sender = await options.getSender();
      const out = await completeMembershipLogin(sender.send as MembershipSend, {
        loginToken: input.loginToken,
        method: input.method,
        code: input.code,
      });
      storeBusiness(input.businessEmail ?? '', out.token, out.orgId, out.role, out.userId);
      return snapshot();
    },

    /**
     * End the active session but keep every stored account (the switch-user
     * "keep local data" path). The account records (and their tokens) stay on
     * disk for a later switch, but nothing is active, so `activeToken()` — the
     * token authority the auth manager and every sender read — returns null and
     * the app is genuinely signed out. Without this, a `switch_user` logout only
     * cleared the auth manager's cache and the still-active identity silently
     * re-signed the user back in.
     */
    endActiveSession(): IdentitySnapshot {
      return persist({ ...state, activeUserId: null });
    },

    /** Clear the whole store (dev helper / hard reset / permanent logout). */
    reset(): IdentitySnapshot {
      return persist(createIdentityStoreState({ accountSwitcherEnabled: state.accountSwitcherEnabled }));
    },
  };
}
