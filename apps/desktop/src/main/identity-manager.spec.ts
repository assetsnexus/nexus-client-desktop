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
});
