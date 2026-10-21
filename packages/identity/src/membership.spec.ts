import { describe, expect, it, vi } from 'vitest';
import {
  MembershipSwitchError,
  completeMembershipLogin,
  listMemberships,
  startMembershipLogin,
  switchLoginTwoFactor,
} from './membership.js';

describe('listMemberships', () => {
  it('parses membership rows with tolerant field names', async () => {
    const send = vi.fn(async () => ({
      responseCode: 200,
      responseObject: {
        memberships: [
          { membershipId: 'm1', orgId: 'o1', role: 'admin', businessEmail: 'a@b.c', orgName: 'Acme' },
          { _id: 'm2', orgId: 'o2' },
        ],
      },
    }));
    const rows = await listMemberships(send as never);
    expect(rows[0]).toMatchObject({ membershipId: 'm1', orgId: 'o1', role: 'admin', orgName: 'Acme' });
    expect(rows[1]).toMatchObject({ membershipId: 'm2', orgId: 'o2', role: null });
  });

  it('throws a typed error on failure', async () => {
    const send = vi.fn(async () => ({
      responseCode: 403,
      errorObjects: [{ code: 'FORBIDDEN', message: 'no' }],
    }));
    await expect(listMemberships(send as never)).rejects.toBeInstanceOf(MembershipSwitchError);
  });
});

describe('startMembershipLogin', () => {
  it('returns a session when no 2FA is required', async () => {
    const send = vi.fn(async () => ({
      responseCode: 200,
      responseObject: { token: { token: 'jwt', orgId: 'o1', role: 'member', userId: 'u1' } },
    }));
    const out = await startMembershipLogin(send as never, { membershipId: 'm1', businessEmail: 'a@b.c' });
    expect(out).toEqual({ kind: 'authenticated', token: 'jwt', orgId: 'o1', role: 'member', userId: 'u1' });
  });

  it('returns a 2FA challenge carrying the loginToken and method groups', async () => {
    const send = vi.fn(async () => ({
      responseCode: 200,
      responseObject: {
        requiresTwoFactor: true,
        loginToken: 'lt-1',
        twoFactorMethods: ['email', 'sms'],
        twoFactorMethodGroups: { user: ['sms'], membership: ['email'] },
        twoFactorChallengeHint: { channelType: 'email', sentTo: 'a***@b.c', methodSlug: 'email' },
        biometricApprovalRequired: true,
        complianceWarnings: [{ code: 'W', message: 'note' }],
      },
    }));
    const out = await startMembershipLogin(send as never, { membershipId: 'm1', businessEmail: 'a@b.c' });
    expect(out).toMatchObject({
      kind: 'two_factor_required',
      loginToken: 'lt-1',
      methods: ['email', 'sms'],
      methodGroups: { user: ['sms'], membership: ['email'] },
      biometricApprovalRequired: true,
    });
    if (out.kind === 'two_factor_required') {
      expect(out.hint?.methodSlug).toBe('email');
      expect(out.complianceWarnings).toEqual([{ code: 'W', message: 'note' }]);
    }
  });

  it('passes an optional membership password', async () => {
    const send = vi.fn(async () => ({ responseCode: 200, responseObject: { token: 'jwt' } }));
    await startMembershipLogin(send as never, { membershipId: 'm1', businessEmail: 'a@b.c', password: 'pw' });
    expect(send).toHaveBeenCalledWith('anx.membership.login', {
      membershipId: 'm1',
      businessEmail: 'a@b.c',
      password: 'pw',
    });
  });

  it('throws when the region returns no token and no challenge', async () => {
    const send = vi.fn(async () => ({ responseCode: 200, responseObject: {} }));
    await expect(
      startMembershipLogin(send as never, { membershipId: 'm1', businessEmail: 'a@b.c' }),
    ).rejects.toThrow(/no token/);
  });
});

describe('switchLoginTwoFactor', () => {
  it('returns the selected method', async () => {
    const send = vi.fn(async () => ({
      responseCode: 200,
      responseObject: { method: 'sms', twoFactorMethods: ['email', 'sms'] },
    }));
    const out = await switchLoginTwoFactor(send as never, { loginToken: 'lt', method: 'sms' });
    expect(out).toEqual({ method: 'sms', methods: ['email', 'sms'] });
    expect(send).toHaveBeenCalledWith('anx.auth.switchLoginTwoFactor', { loginToken: 'lt', method: 'sms' });
  });
});

describe('completeMembershipLogin', () => {
  it('sends the code via anx.auth.twoFactorLogin and returns the token', async () => {
    const send = vi.fn(async () => ({
      responseCode: 200,
      responseObject: { token: { token: 'jwt', orgId: 'o1', role: 'member' } },
    }));
    const out = await completeMembershipLogin(send as never, { loginToken: 'lt', method: 'email', code: '1234' });
    expect(out).toMatchObject({ token: 'jwt', orgId: 'o1' });
    expect(send).toHaveBeenCalledWith('anx.auth.twoFactorLogin', {
      loginToken: 'lt',
      method: 'email',
      code: '1234',
    });
  });

  it('surfaces the region error message', async () => {
    const send = vi.fn(async () => ({
      responseCode: 400,
      errorObjects: [{ code: 'BAD_CODE', message: 'wrong code' }],
    }));
    await expect(
      completeMembershipLogin(send as never, { loginToken: 'lt', method: 'email', code: 'x' }),
    ).rejects.toThrow(/wrong code/);
  });
});
