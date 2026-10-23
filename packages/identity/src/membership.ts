/**
 * Org-membership identity switch (Phase 9).
 *
 * Shipped region flow (mirrors the app/portal): list memberships, start
 * `anx.membership.login` (which returns a `loginToken` when 2FA is needed),
 * optionally `anx.auth.switchLoginTwoFactor`, then complete with
 * `anx.auth.twoFactorLogin`. The completion **does not replace** the active
 * personal session in the app; on the desktop we store the resulting token as a
 * `business` identity in the store.
 *
 * The flow is expressed as pure step builders + parsers so it can be unit-tested
 * against a mock `send` with no region.
 */

export type MembershipRow = {
  membershipId: string;
  orgId: string | null;
  role: string | null;
  businessEmail: string | null;
  orgName: string | null;
  /**
   * Organisation logo as returned by `anx.organization.membership.list`
   * (`orgLogo`, denormalised from `Org.logo`; also carried on the nested `org`).
   * May be an absolute URL, an inline `data:image/...` URL, or a root-relative
   * region path — the renderer resolves it via `resolveOrgLogoUrl`.
   */
  orgLogo: string | null;
};

export type MembershipLoginResult =
  | { kind: 'authenticated'; token: string; orgId: string | null; role: string | null; userId: string | null }
  | {
      kind: 'two_factor_required';
      loginToken: string;
      methods: string[];
      methodGroups: { user: string[]; membership: string[] };
      hint?: TwoFactorHint;
      biometricApprovalRequired: boolean;
      complianceWarnings: Array<{ code: string; message: string }>;
    };

export class MembershipSwitchError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'MembershipSwitchError';
    this.code = code;
  }
}

/** Region error envelope shape (tolerates the several spellings we see). */
type Envelope = {
  responseCode?: number;
  responseObject?: unknown;
  errorObjects?: Array<{ code?: string; message?: string }>;
  message?: string;
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function envelope(raw: unknown): Envelope {
  return asRecord(raw) as Envelope;
}

function bodyOf(raw: unknown): Record<string, unknown> {
  const e = envelope(raw);
  return asRecord(e.responseObject ?? raw);
}

type TwoFactorHint = { channelType?: string; sentTo?: string | null; methodSlug?: string };

function parseHint(raw: unknown): TwoFactorHint | undefined {
  const r = asRecord(raw);
  if (!Object.keys(r).length) return undefined;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const hint: TwoFactorHint = {};
  if (typeof r.channelType === 'string') hint.channelType = r.channelType;
  if (typeof r.sentTo === 'string' || r.sentTo === null) hint.sentTo = str(r.sentTo);
  if (typeof r.methodSlug === 'string') hint.methodSlug = r.methodSlug;
  return hint;
}

function failed(raw: unknown): { failed: boolean; code?: string; message?: string } {
  const e = envelope(raw);
  const code = typeof e.responseCode === 'number' ? e.responseCode : null;
  if (code != null && (code < 200 || code >= 300)) {
    const first = asRecord(e.errorObjects?.[0]);
    return {
      failed: true,
      code: typeof first.code === 'string' ? first.code : String(code),
      message: typeof first.message === 'string' ? first.message : e.message,
    };
  }
  return { failed: false };
}

/** List the caller's org memberships (`anx.organization.membership.list`). */
export async function listMemberships(send: MembershipSend): Promise<MembershipRow[]> {
  const raw = await send('anx.organization.membership.list', {});
  const fail = failed(raw);
  if (fail.failed) throw new MembershipSwitchError(fail.message ?? 'failed to list memberships', fail.code);
  const body = bodyOf(raw);
  const rows = Array.isArray(body.memberships) ? body.memberships : [];
  return rows.map((m) => {
    const r = asRecord(m);
    const org = asRecord(r.org);
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
    return {
      membershipId: str(r.membershipId ?? r._id ?? r.id) ?? '',
      orgId: str(r.orgId),
      role: str(r.role),
      businessEmail: str(r.businessEmail),
      orgName: str(r.orgName ?? r.organizationName ?? org.name),
      // `orgLogo` is the denormalised field; the nested `org.logo` is the fallback
      // for a payload that only carried the org slice.
      orgLogo: str(r.orgLogo ?? org.logo),
    };
  });
}

export type MembershipSend = (
  command: string,
  payload?: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Start a membership login. Returns either a session or a 2FA challenge carrying
 * the `loginToken` that the completion step needs.
 */
export async function startMembershipLogin(
  send: MembershipSend,
  input: { membershipId: string; businessEmail: string; password?: string },
): Promise<MembershipLoginResult> {
  const payload: Record<string, unknown> = {
    membershipId: input.membershipId,
    businessEmail: input.businessEmail,
  };
  if (input.password) payload.password = input.password;

  const raw = await send('anx.membership.login', payload);
  const fail = failed(raw);
  if (fail.failed) throw new MembershipSwitchError(fail.message ?? 'membership login failed', fail.code);
  const body = bodyOf(raw);

  if (body.requiresTwoFactor === true && typeof body.loginToken === 'string') {
    const groups = asRecord(body.twoFactorMethodGroups);
    return {
      kind: 'two_factor_required',
      loginToken: body.loginToken,
      methods: Array.isArray(body.twoFactorMethods) ? body.twoFactorMethods.map(String) : [],
      methodGroups: {
        user: Array.isArray(groups.user) ? groups.user.map(String) : [],
        membership: Array.isArray(groups.membership) ? groups.membership.map(String) : [],
      },
      hint: parseHint(body.twoFactorChallengeHint),
      biometricApprovalRequired: body.biometricApprovalRequired === true,
      complianceWarnings: Array.isArray(body.complianceWarnings)
        ? body.complianceWarnings.map((w) => {
            const r = asRecord(w);
            return { code: String(r.code ?? ''), message: String(r.message ?? '') };
          })
        : [],
    };
  }

  const tokenObj = asRecord(body.token);
  const token =
    typeof body.token === 'string' ? body.token : typeof tokenObj.token === 'string' ? tokenObj.token : null;
  if (!token) throw new MembershipSwitchError('membership login returned no token');
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  return {
    kind: 'authenticated',
    token,
    orgId: str(tokenObj.orgId ?? body.orgId),
    role: str(tokenObj.role ?? body.role),
    userId: str(tokenObj.userId ?? body.userId),
  };
}

/** Pick a different 2FA method for an in-flight membership login. */
export async function switchLoginTwoFactor(
  send: MembershipSend,
  input: { loginToken: string; method: string },
): Promise<{ method: string; methods: string[] }> {
  const raw = await send('anx.auth.switchLoginTwoFactor', {
    loginToken: input.loginToken,
    method: input.method,
  });
  const fail = failed(raw);
  if (fail.failed) throw new MembershipSwitchError(fail.message ?? 'could not switch method', fail.code);
  const body = bodyOf(raw);
  return {
    method: typeof body.method === 'string' ? body.method : input.method,
    methods: Array.isArray(body.twoFactorMethods) ? body.twoFactorMethods.map(String) : [],
  };
}

/** Complete an in-flight membership login with a 2FA code. */
export async function completeMembershipLogin(
  send: MembershipSend,
  input: { loginToken: string; method: string; code: string },
): Promise<{ token: string; orgId: string | null; role: string | null; userId: string | null }> {
  const raw = await send('anx.auth.twoFactorLogin', {
    loginToken: input.loginToken,
    method: input.method,
    code: input.code,
  });
  const fail = failed(raw);
  if (fail.failed) throw new MembershipSwitchError(fail.message ?? 'two-factor verification failed', fail.code);
  const body = bodyOf(raw);
  const tokenObj = asRecord(body.token);
  const token =
    typeof body.token === 'string' ? body.token : typeof tokenObj.token === 'string' ? tokenObj.token : null;
  if (!token) throw new MembershipSwitchError('verification returned no token');
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  return {
    token,
    orgId: str(tokenObj.orgId ?? body.orgId),
    role: str(tokenObj.role ?? body.role),
    userId: str(tokenObj.userId ?? body.userId),
  };
}
