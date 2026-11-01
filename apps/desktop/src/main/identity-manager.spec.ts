import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));

const { createIdentityManager } = await import('./identity-manager.js');

const dirs: string[] = [];
function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-identity-mgr-'));
  dirs.push(dir);
  return join(dir, 'identities.json');
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function manager(sender = vi.fn(async () => ({ responseCode: 200, responseObject: {} }))) {
  return createIdentityManager({ getSender: async () => ({ send: sender }), filePath: tempFile() });
}

describe('identity manager', () => {
  it('records a private login and exposes it as the active token', () => {
    const m = manager();
    m.recordLogin({ userId: 'u1', email: 'a@b.c', role: 'owner', token: 't1' });
    expect(m.activeToken()).toBe('t1');
    const snap = m.getSnapshot();
    expect(snap.activeUserId).toBe('u1');
    expect(snap.accounts[0]).toMatchObject({ userId: 'u1', email: 'a@b.c', active: true });
    expect(snap.accounts[0].identities[0].active).toBe(true);
  });

  it('switches between two local accounts (the temporary switcher)', () => {
    const m = manager();
    m.recordLogin({ userId: 'u1', token: 't1' });
    m.recordLogin({ userId: 'u2', token: 't2' });
    expect(m.activeToken()).toBe('t2');
    m.switchAccount('u1');
    expect(m.activeToken()).toBe('t1');
    expect(m.getSnapshot().activeUserId).toBe('u1');
  });

  it('is inert when the switcher is disabled', () => {
    const m = createIdentityManager({
      getSender: async () => ({ send: vi.fn() }),
      filePath: tempFile(),
      accountSwitcherEnabled: false,
    });
    m.recordLogin({ userId: 'u1', token: 't1' });
    m.recordLogin({ userId: 'u2', token: 't2' });
    m.switchAccount('u1');
    expect(m.activeToken()).toBe('t2');
  });

  it('switches the active identity within an account (org switch)', () => {
    const m = manager();
    m.recordLogin({ userId: 'u1', token: 't1' });
    m.recordLogin({ userId: 'u1', token: 't1' });
    // Simulate a business identity via completeMembership's sender.
    const m2 = createIdentityManager({
      getSender: async () => ({
        send: vi.fn(async () => ({
          responseCode: 200,
          responseObject: { token: { token: 'biz', orgId: 'o1', role: 'member', userId: 'u1' } },
        })),
      }),
      filePath: tempFile(),
    });
    m2.recordLogin({ userId: 'u1', token: 't1' });
    return m2
      .completeMembership({ loginToken: 'lt', method: 'email', code: '1', businessEmail: 'a@b.c' })
      .then((snap) => {
        expect(snap.accounts[0].identities).toHaveLength(2);
        const biz = snap.accounts[0].identities.find((i) => i.kind === 'business');
        expect(biz?.orgId).toBe('o1');
        m2.switchIdentity(biz!.key);
        expect(m2.activeToken()).toBe('biz');
      });
  });

  it('stores a business identity directly from an immediate membership login', async () => {
    const sender = vi.fn(async () => ({
      responseCode: 200,
      responseObject: { token: { token: 'biz', orgId: 'o1', role: 'admin', userId: 'u1' } },
    }));
    const m = manager(sender);
    m.recordLogin({ userId: 'u1', token: 't1' });
    const out = await m.startMembership({ membershipId: 'm1', businessEmail: 'a@b.c' });
    expect(out).toEqual({ kind: 'authenticated', orgId: 'o1' });
    expect(m.getSnapshot().accounts[0].identities.map((i) => i.kind)).toEqual(['private', 'business']);
  });

  it('listSessions carries each session deviceId (device-gated fan-out)', async () => {
    const sender = vi.fn(async () => ({
      responseCode: 200,
      responseObject: { token: { token: 'biz', orgId: 'o1', role: 'admin', userId: 'u1' } },
    }));
    const m = manager(sender);
    m.recordLogin({ userId: 'u1', token: 't1', deviceId: 'dev-personal' });
    await m.startMembership({ membershipId: 'm1', businessEmail: 'a@b.c' });
    const sessions = m.listSessions();
    expect(sessions.map((s) => s.token).sort()).toEqual(['biz', 't1']);
    // The business identity inherits the active session's device, and the
    // personal one carries the device recorded at login.
    for (const session of sessions) {
      expect(session).toHaveProperty('deviceId');
      expect(session.deviceId).toBeTruthy();
    }
  });

  it('chatIdentitySessions presents every identity of the active account', async () => {
    const sender = vi.fn(async () => ({
      responseCode: 200,
      responseObject: { token: { token: 'biz', orgId: 'o1', role: 'admin', userId: 'u1' } },
    }));
    const m = manager(sender);
    m.recordLogin({ userId: 'u1', token: 't1', deviceId: 'dev-personal' });
    await m.startMembership({ membershipId: 'm1', businessEmail: 'a@b.c' });
    const rows = m.chatIdentitySessions();
    expect(rows.map((r) => r.token).sort()).toEqual(['biz', 't1']);
    expect(rows.find((r) => !r.orgId)).toMatchObject({
      label: 'Personal',
      userId: 'u1',
      orgId: null,
      deviceId: 'dev-personal',
    });
    // A business label is the business email, never the raw org id.
    expect(rows.find((r) => r.orgId === 'o1')?.label).toBe('a@b.c');
  });

  it('chatIdentitySessions never leaks another signed-in account', () => {
    const m = manager();
    m.recordLogin({ userId: 'u1', token: 't1' });
    m.recordLogin({ userId: 'u2', token: 't2' });
    const rows = m.chatIdentitySessions();
    expect(rows.map((r) => r.token)).toEqual(['t2']);
  });

  it('chatIdentitySessions drops identities with no token', () => {
    const m = manager();
    m.recordLogin({ userId: 'u1', token: '' });
    expect(m.chatIdentitySessions()).toEqual([]);
  });

  it('returns the 2FA challenge fields for a gated membership login', async () => {
    const sender = vi.fn(async () => ({
      responseCode: 200,
      responseObject: {
        requiresTwoFactor: true,
        loginToken: 'lt',
        twoFactorMethods: ['email'],
        twoFactorMethodGroups: { user: [], membership: ['email'] },
      },
    }));
    const m = manager(sender);
    const out = await m.startMembership({ membershipId: 'm1', businessEmail: 'a@b.c' });
    expect(out.kind).toBe('two_factor_required');
    expect(out.loginToken).toBe('lt');
    expect(out.methodGroups?.membership).toEqual(['email']);
  });

  it('logs out the active account, then falls back to another', () => {
    const m = manager();
    m.recordLogin({ userId: 'u1', token: 't1' });
    m.recordLogin({ userId: 'u2', token: 't2' });
    const after = m.logout();
    expect(after.activeUserId).toBe('u1');
    expect(m.activeToken()).toBe('t1');
  });

  it('persists across instances, so the active identity survives a restart', () => {
    const file = tempFile();
    const m = createIdentityManager({ getSender: async () => ({ send: vi.fn() }), filePath: file });
    m.recordLogin({ userId: 'u1', token: 't1' });
    const m2 = createIdentityManager({ getSender: async () => ({ send: vi.fn() }), filePath: file });
    expect(m2.activeToken()).toBe('t1');
  });

  it('endActiveSession signs out but keeps every stored account (switch user)', () => {
    // Regression: a switch-user logout must actually end the session. The
    // identity store is the token authority, so it has to stop exposing the
    // active token while keeping the accounts for a later switch.
    const file = tempFile();
    const m = createIdentityManager({ getSender: async () => ({ send: vi.fn() }), filePath: file });
    m.recordLogin({ userId: 'u1', token: 't1' });

    const after = m.endActiveSession();
    expect(m.activeToken()).toBeNull();
    expect(after.activeUserId).toBeNull();
    // The account survives on disk for the next sign-in.
    expect(after.accounts).toHaveLength(1);

    const reloaded = createIdentityManager({ getSender: async () => ({ send: vi.fn() }), filePath: file });
    expect(reloaded.activeToken()).toBeNull();
    // Switching back restores the token, proving it was kept, not dropped.
    reloaded.switchAccount('u1');
    expect(reloaded.activeToken()).toBe('t1');
  });

  describe('storageIdentities (storage fan-out)', () => {
    function orgManager(sender: (command: string, payload?: unknown) => Promise<unknown>) {
      return createIdentityManager({
        getSender: async () => ({ send: sender as never }),
        filePath: tempFile(),
      });
    }

    it('returns the personal context plus one per stored org, even when the region membership list fails', async () => {
      // A membership login stores a business identity carrying the orgId, so the
      // fan-out must be able to list every org's storage from local state alone.
      const sender = vi.fn(async (command: string) => {
        if (command === 'anx.membership.login') {
          return {
            responseCode: 200,
            responseObject: { token: { token: 'biz', orgId: 'o9', role: 'owner', userId: 'u1' } },
          };
        }
        // The membership list is throttled/unavailable under load.
        return {
          responseCode: 429,
          errorObjects: [{ code: 'lane_throttled', message: "Lane 'read' throttled" }],
        };
      });
      const m = orgManager(sender);
      m.recordLogin({ userId: 'u1', token: 't-session', deviceId: 'dev-1' });
      await m.startMembership({ membershipId: 'm1', businessEmail: 'a@b.c' });

      const contexts = await m.storageIdentities();
      expect(contexts.map((c) => c.key)).toContain('org:o9');
    });

    it('uses the private (user-session) token and device for every context', async () => {
      const sender = vi.fn(async (command: string) => {
        if (command === 'anx.membership.login') {
          return {
            responseCode: 200,
            responseObject: { token: { token: 'biz', orgId: 'o1', role: 'owner', userId: 'u1' } },
          };
        }
        return { responseCode: 200, responseObject: { memberships: [] } };
      });
      const m = orgManager(sender);
      m.recordLogin({ userId: 'u1', token: 't-session', deviceId: 'dev-1' });
      await m.startMembership({ membershipId: 'm1', businessEmail: 'a@b.c' });

      const contexts = await m.storageIdentities();
      expect(contexts.length).toBeGreaterThanOrEqual(2);
      for (const c of contexts) {
        // The stale per-org business token must never be used as the authority.
        expect(c.token).toBe('t-session');
        expect(c.deviceId).toBe('dev-1');
      }
    });

    it('enriches locally stored orgs with the region name/logo when available', async () => {
      const sender = vi.fn(async (command: string) => {
        if (command === 'anx.membership.login') {
          return {
            responseCode: 200,
            responseObject: { token: { token: 'biz', orgId: 'o1', role: 'owner', userId: 'u1' } },
          };
        }
        return {
          responseCode: 200,
          responseObject: {
            memberships: [
              { membershipId: 'm1', orgId: 'o1', orgName: 'Acme Inc', orgLogo: 'https://cdn/a.png' },
            ],
          },
        };
      });
      const m = orgManager(sender);
      m.recordLogin({ userId: 'u1', token: 't1', deviceId: 'd1' });
      await m.startMembership({ membershipId: 'm1', businessEmail: 'a@b.c' });

      const contexts = await m.storageIdentities();
      const org = contexts.find((c) => c.key === 'org:o1');
      expect(org).toBeTruthy();
      expect(org?.orgName).toBe('Acme Inc');
      expect(org?.orgLogo).toBe('https://cdn/a.png');
    });
  });
});
