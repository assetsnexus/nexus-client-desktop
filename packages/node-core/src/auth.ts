/**
 * Minimal region auth client for the desktop main process.
 *
 * Uses plain `fetch` with an optional custom CA agent so local/self-signed
 * region nodes work. 2FA is mandatory for every user (see SYS_GLOBAL): login
 * either returns a token or a `requiresTwoFactor` challenge that we complete
 * through `anx.auth.twoFactorLogin`.
 */

export type LoginCredentials = {
  email: string;
  password: string;
  orgId?: string | null;
  /**
   * Home-region slug resolved from the country picker (`anx.region.list`).
   * The region uses it to bind the account to a region on first login and to
   * reject a login against the wrong region. Optional: the desktop degrades to
   * the node's own region when the user has not picked a country.
   */
  region?: string | null;
  /** Originating device id, when this machine is already registered. */
  deviceId?: string | null;
};

/**
 * The region answers a password login with a temporary `loginToken` plus the
 * 2FA methods the account can complete with. The desktop keeps the opaque
 * `loginToken` (never shown to the renderer) and shows the methods + masked
 * destination hint.
 */
export type TwoFactorChallenge = {
  /** Opaque temporary token; pass back to `twoFactorLogin` / `switchLoginTwoFactor`. */
  loginToken: string;
  /** Advertised methods, e.g. `['email', 'authenticator']`. */
  methods: string[];
  /** Masked destination copy, e.g. `{ sentTo: 'a***@example.com' }`. */
  hint?: TwoFactorChallengeHint;
  /** Legacy alias for `methods`, kept for renderer compatibility. */
  factors: string[];
  message?: string;
};

export type TwoFactorChallengeHint = {
  channelType?: string;
  sentTo?: string | null;
  methodSlug?: string;
};

export type LoginResult =
  | { kind: 'authenticated'; token: string; identity: AuthIdentity; region?: unknown }
  | { kind: 'two_factor_required'; challenge: TwoFactorChallenge };

/** What the region returns when a passwordless code is verified. */
export type PasswordlessStartResult = {
  challengeToken: string;
  channel: string;
  maskedTarget?: string | null;
};

export type PasswordlessVerifyInput = {
  challengeToken: string;
  code: string;
  deviceId?: string | null;
};

export type PasswordlessResendInput = {
  challengeToken: string;
  /** Optional channel switch, e.g. `sms` -> `voice`. */
  channel?: 'email' | 'sms' | 'voice';
};

/** Passwordless verify result: a session, a 2FA step-up, or a disabled account. */
export type PasswordlessVerifyResult =
  | { kind: 'authenticated'; token: string; identity: AuthIdentity }
  | { kind: 'two_factor_required'; challenge: TwoFactorChallenge }
  | { kind: 'account_disabled'; message: string };

export type PasswordlessChannel = 'email' | 'sms' | 'voice';

/** How the user wants to sign in on the desktop login screen. */
export type LoginMethod = 'password' | 'email_code' | 'phone_code';

export type AuthIdentity = {
  userId: string | null;
  orgId: string | null;
  role: string | null;
  deviceId: string | null;
  email?: string | null;
};

export type AuthError = {
  responseCode: number;
  message: string;
};

export class RegionAuthError extends Error {
  readonly responseCode: number;
  constructor(message: string, responseCode = 0) {
    super(message);
    this.name = 'RegionAuthError';
    this.responseCode = responseCode;
  }
}

/** Command envelope shape accepted by the region `/command` endpoint. */
export type CommandEnvelope = {
  command: string;
  requestId: string;
  payload: Record<string, unknown>;
  identity?: Record<string, unknown>;
  responseExpected: boolean;
  timestamp: string;
};

export type RegionResponse = {
  responseCode: number;
  responseObject: unknown;
  message?: string;
  /**
   * Machine-readable failure code (e.g. `UNAUTHORIZED`, `FORBIDDEN`,
   * `DEVICE_REVOKED`). The dispatcher puts it in `errorObjects[0].code`, so the
   * caller must unwrap it: session-loss detection needs it to tell a revoked
   * device from a plain permission denial.
   */
  code?: string;
  authorizationRequired?: boolean;
  authRequestId?: string;
};

export type SendOptions = {
  identity?: Record<string, unknown> | null;
  token?: string | null;
  signal?: AbortSignal;
};

export type AuthClientOptions = {
  baseUrl: string;
  /** Extra headers, e.g. `X-Anx-App: nexus-desktop`. */
  headers?: Record<string, string>;
  fetchFn?: typeof fetch;
};

function generateRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/**
 * Send one command envelope to `POST {baseUrl}/command` and normalize the
 * response. Never throws on non-2xx HTTP; only on transport failure.
 */
export async function sendCommand(
  opts: AuthClientOptions,
  command: string,
  payload: Record<string, unknown> = {},
  send: SendOptions = {},
): Promise<RegionResponse> {
  const fetchFn = opts.fetchFn ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const identity: Record<string, unknown> = { ...(send.identity ?? {}) };
  if (send.token) identity.token = send.token;

  const envelope: CommandEnvelope = {
    command,
    requestId: generateRequestId(),
    payload: payload ?? {},
    identity: Object.keys(identity).length ? identity : undefined,
    responseExpected: true,
    timestamp: new Date().toISOString(),
  };

  let res: Response;
  try {
    res = await fetchFn(`${base}/command`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(send.token ? { authorization: `Bearer ${send.token}` } : {}),
        ...(opts.headers ?? {}),
      },
      body: JSON.stringify(envelope),
      signal: send.signal,
    });
  } catch (err) {
    throw new RegionAuthError(
      err instanceof Error ? err.message : 'network error contacting region',
      0,
    );
  }

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const responseCode = Number(json.responseCode ?? json.status ?? res.status ?? 0);
  // Errors arrive as `errorObjects: [{ code, message }]` (see the region
  // dispatcher). Flatten the first entry so callers can classify the failure:
  // a bare `responseCode` alone cannot distinguish a revoked device from a
  // missing permission, and misreading that difference signs the user out.
  const firstError = Array.isArray(json.errorObjects)
    ? (json.errorObjects[0] as Record<string, unknown> | undefined)
    : undefined;
  const message =
    typeof json.message === 'string'
      ? json.message
      : typeof firstError?.message === 'string'
        ? (firstError.message as string)
        : undefined;
  return {
    responseCode,
    responseObject: json.responseObject ?? json.data ?? json,
    message,
    code: typeof firstError?.code === 'string' ? (firstError.code as string) : undefined,
    authorizationRequired: Boolean(json.authorizationRequired),
    authRequestId: typeof json.authRequestId === 'string' ? json.authRequestId : undefined,
  };
}

export function readIdentity(source: Record<string, unknown>): AuthIdentity {
  const user = (source.user as Record<string, unknown>) ?? {};
  const device = (source.device as Record<string, unknown>) ?? {};
  // The region embeds the identity claims in the nested `AuthToken` object
  // (`responseObject.token.userId` / `.orgId` / `.role`), so fold it in before
  // reading: otherwise a successful login loses the userId and the sender
  // identifies itself as an anonymous session.
  const authToken = readAuthToken(source) ?? {};
  const pick = (...vals: unknown[]): string | null => {
    for (const v of vals) if (typeof v === 'string' && v.trim()) return v;
    return null;
  };
  return {
    userId: pick(source.userId, authToken.userId, user.id, user.userId),
    orgId: pick(source.orgId, source.activeOrgId, authToken.orgId),
    role: pick(source.role, authToken.role, user.role),
    deviceId: pick(source.deviceId, device.id, device.deviceId),
    email: pick(source.email, user.email),
  };
}

function readFactors(source: Record<string, unknown>): string[] {
  const raw =
    source.twoFactorMethods ??
    source.factors ??
    source.twoFactorFactors ??
    source.availableFactors;
  if (!Array.isArray(raw)) return [];
  return raw.filter((f): f is string => typeof f === 'string' && f.trim() !== '');
}

function readToken(source: Record<string, unknown>): string | null {
  const t = source.token ?? source.accessToken ?? source.jwt;
  if (typeof t === 'string' && t.trim()) return t;
  // The region's `LoginResponse.token` is an `AuthToken` object
  // (`{ token, expiresAt, userId, orgId, role, sid }`), not a bare JWT string.
  // Unwrap it so a successful 2FA completion is not misread as a failure.
  if (t && typeof t === 'object') {
    const inner = (t as Record<string, unknown>).token;
    if (typeof inner === 'string' && inner.trim()) return inner;
  }
  return null;
}

/** Region `LoginResponse.token` as an `AuthToken` object. */
function readAuthToken(source: Record<string, unknown>): Record<string, unknown> | null {
  const t = source.token;
  return t && typeof t === 'object' ? (t as Record<string, unknown>) : null;
}

function readLoginToken(source: Record<string, unknown>): string | null {
  const t = source.loginToken;
  return typeof t === 'string' && t.trim() ? t : null;
}

function readChallengeHint(source: Record<string, unknown>): TwoFactorChallengeHint | undefined {
  const raw = source.twoFactorChallengeHint ?? source.challengeHint;
  if (!raw || typeof raw !== 'object') return undefined;
  const hint = raw as Record<string, unknown>;
  return {
    channelType: typeof hint.channelType === 'string' ? hint.channelType : undefined,
    sentTo: typeof hint.sentTo === 'string' ? hint.sentTo : null,
    methodSlug: typeof hint.methodSlug === 'string' ? hint.methodSlug : undefined,
  };
}

/**
 * `anx.auth.login`. Returns an authenticated session or a 2FA challenge.
 */
export async function login(
  opts: AuthClientOptions,
  creds: LoginCredentials,
): Promise<LoginResult> {
  const payload: Record<string, unknown> = { email: creds.email, password: creds.password };
  if (creds.orgId) payload.orgId = creds.orgId;
  // Bound to the country picker (same contract as the portal). A wrong region
  // is rejected by the region, so this is a correctness input, not a hint.
  if (creds.region) payload.region = creds.region;
  if (creds.deviceId) payload.deviceId = creds.deviceId;

  const res = await sendCommand(opts, 'anx.auth.login', payload);
  const body = (res.responseObject ?? {}) as Record<string, unknown>;

  const requiresTwoFactor =
    Boolean(body.requiresTwoFactor) ||
    Boolean(body.twoFactorRequired) ||
    res.authorizationRequired === true ||
    body.status === 'two_factor_required';

  const token = readToken(body);
  if (!requiresTwoFactor && token) {
    return { kind: 'authenticated', token, identity: readIdentity(body), region: body.region };
  }

  const loginToken = readLoginToken(body) ?? res.authRequestId ?? null;
  if (requiresTwoFactor || loginToken) {
    if (!loginToken) {
      throw new RegionAuthError(
        res.message ?? 'region requested two-factor auth without a loginToken',
        res.responseCode,
      );
    }
    const factors = readFactors(body);
    return {
      kind: 'two_factor_required',
      challenge: {
        loginToken,
        methods: factors,
        factors,
        hint: readChallengeHint(body),
        message: res.message,
      },
    };
  }

  throw new RegionAuthError(res.message ?? 'login failed', res.responseCode);
}

export type TwoFactorLoginInput = {
  /** Temporary token from the initial login (region field: `loginToken`). */
  loginToken: string;
  /** Verification code when the method is email / sms / phone_call / authenticator. */
  code: string;
  /** Method id, e.g. `email`, `sms`, `phone_call`, `authenticator`. */
  method: string;
  /** Device id being verified. */
  deviceId?: string | null;
};

/**
 * `anx.auth.twoFactorLogin`. Completes a login/membership challenge and returns
 * the session token. The region expects `{ loginToken, method, code }`.
 */
export async function twoFactorLogin(
  opts: AuthClientOptions,
  input: TwoFactorLoginInput,
): Promise<{ token: string; identity: AuthIdentity }> {
  const payload: Record<string, unknown> = {
    loginToken: input.loginToken,
    method: input.method,
    code: input.code,
  };
  if (input.deviceId) payload.deviceId = input.deviceId;

  const res = await sendCommand(opts, 'anx.auth.twoFactorLogin', payload);
  const body = (res.responseObject ?? {}) as Record<string, unknown>;
  const token = readToken(body);
  if (token) return { token, identity: readIdentity(body) };
  throw new RegionAuthError(
    res.message ?? (res.responseCode === 200 ? 'two-factor verification failed' : 'invalid code'),
    res.responseCode,
  );
}

/**
 * `anx.auth.switchLoginTwoFactor`. During a password challenge, re-target which
 * enrolled method is challenged (same `loginToken`).
 */
export async function switchLoginTwoFactor(
  opts: AuthClientOptions,
  input: { loginToken: string; method: string },
): Promise<{ methods: string[]; hint?: TwoFactorChallengeHint }> {
  const res = await sendCommand(opts, 'anx.auth.switchLoginTwoFactor', {
    loginToken: input.loginToken,
    method: input.method,
  });
  const body = (res.responseObject ?? {}) as Record<string, unknown>;
  if (res.responseCode < 200 || res.responseCode >= 300) {
    throw new RegionAuthError(res.message ?? 'could not switch verification method', res.responseCode);
  }
  return { methods: readFactors(body), hint: readChallengeHint(body) };
}

/**
 * `anx.region.node.info` -> the first region slug this node serves, preferring
 * an active region. Passwordless start requires a `region`, but the desktop is
 * not region-aware, so we discover it from the node itself.
 */
export async function resolveManagedRegion(opts: AuthClientOptions): Promise<string | null> {
  const res = await sendCommand(opts, 'anx.region.node.info', {});
  const body = (res.responseObject ?? {}) as Record<string, unknown>;
  const regions = Array.isArray(body.managedRegions) ? body.managedRegions : [];
  const slugs = regions
    .map((r) => (r && typeof r === 'object' ? (r as Record<string, unknown>) : null))
    .filter((r): r is Record<string, unknown> => Boolean(r))
    .map((r) => ({
      slug: typeof r.slug === 'string' ? r.slug : null,
      state: typeof r.state === 'string' ? r.state : null,
    }))
    .filter((r): r is { slug: string; state: string | null } => Boolean(r.slug) && r.slug !== 'global');
  if (!slugs.length) return null;
  const active = slugs.find((r) => r.state === 'active');
  return (active ?? slugs[0]).slug;
}

/**
 * `anx.auth.passwordless.start`. Starts an email/SMS/voice code sign-in or
 * registration. The response deliberately does not reveal whether the
 * identifier already has an account.
 */
export async function startPasswordless(
  opts: AuthClientOptions,
  input: { channel: PasswordlessChannel; identifier: string; region: string; deviceId?: string | null },
): Promise<PasswordlessStartResult> {
  const payload: Record<string, unknown> = {
    channel: input.channel,
    identifier: input.identifier,
    region: input.region,
  };
  if (input.deviceId) payload.deviceId = input.deviceId;

  const res = await sendCommand(opts, 'anx.auth.passwordless.start', payload);
  const body = (res.responseObject ?? {}) as Record<string, unknown>;
  if (res.responseCode < 200 || res.responseCode >= 300) {
    throw new RegionAuthError(res.message ?? 'could not start sign-in code', res.responseCode);
  }
  const challengeToken = typeof body.challengeToken === 'string' ? body.challengeToken : '';
  if (!challengeToken) throw new RegionAuthError('region returned no challenge token', res.responseCode);
  return {
    challengeToken,
    channel: typeof body.channel === 'string' ? body.channel : input.channel,
    maskedTarget: typeof body.maskedTarget === 'string' ? body.maskedTarget : null,
  };
}

/** `anx.auth.passwordless.resend`. Sends a new code, optionally switching channel. */
export async function resendPasswordless(
  opts: AuthClientOptions,
  input: PasswordlessResendInput,
): Promise<PasswordlessStartResult> {
  const payload: Record<string, unknown> = { challengeToken: input.challengeToken };
  if (input.channel) payload.channel = input.channel;

  const res = await sendCommand(opts, 'anx.auth.passwordless.resend', payload);
  const body = (res.responseObject ?? {}) as Record<string, unknown>;
  if (res.responseCode < 200 || res.responseCode >= 300) {
    throw new RegionAuthError(res.message ?? 'could not resend the code', res.responseCode);
  }
  return {
    challengeToken: typeof body.challengeToken === 'string' ? body.challengeToken : input.challengeToken,
    channel: typeof body.channel === 'string' ? body.channel : input.channel ?? 'email',
    maskedTarget: typeof body.maskedTarget === 'string' ? body.maskedTarget : null,
  };
}

/**
 * `anx.auth.passwordless.verify`. Proves a code. New identifiers register and
 * sign in; known identifiers sign in, or step up through a 2FA challenge when
 * another factor is enrolled on an untrusted device.
 */
export async function verifyPasswordless(
  opts: AuthClientOptions,
  input: PasswordlessVerifyInput,
): Promise<PasswordlessVerifyResult> {
  const payload: Record<string, unknown> = {
    challengeToken: input.challengeToken,
    code: input.code,
  };
  if (input.deviceId) payload.deviceId = input.deviceId;

  const res = await sendCommand(opts, 'anx.auth.passwordless.verify', payload);
  const body = (res.responseObject ?? {}) as Record<string, unknown>;
  if (res.responseCode < 200 || res.responseCode >= 300) {
    throw new RegionAuthError(res.message ?? 'invalid or expired code', res.responseCode);
  }
  if (body.accountEnabled === false) {
    return {
      kind: 'account_disabled',
      message:
        typeof body.message === 'string'
          ? body.message
          : 'Your account is not active yet. Contact support@assetsnexus.org for assistance.',
    };
  }
  const token = readToken(body);
  if (token) return { kind: 'authenticated', token, identity: readIdentity(body) };

  const loginToken = readLoginToken(body);
  if (Boolean(body.requiresTwoFactor) && loginToken) {
    const factors = readFactors(body);
    return {
      kind: 'two_factor_required',
      challenge: {
        loginToken,
        methods: factors,
        factors,
        hint: readChallengeHint(body),
        message: res.message,
      },
    };
  }
  throw new RegionAuthError(res.message ?? 'passwordless verification failed', res.responseCode);
}

/** One row of `anx.country.list` (public; drives the login country picker). */
export type CountryRow = {
  code: string;
  name: string;
  region: string | null;
  flagIconUrl?: string | null;
  flagImageUrl?: string | null;
  state: string;
};

/** One row of `anx.region.list` (public; resolves a country to its region). */
export type RegionRow = {
  slug: string;
  name: string;
  state: string;
  countryCodes: string[];
  flagIconUrl?: string | null;
};

/**
 * `anx.country.list`. Public command: the login screen needs it before the user
 * has a session. Mirrors the portal filter — active/preview countries only,
 * sorted by name.
 */
export async function listCountries(
  opts: AuthClientOptions,
  input: { state?: string } = {},
): Promise<CountryRow[]> {
  const res = await sendCommand(opts, 'anx.country.list', {
    state: input.state ?? 'active',
  });
  const body = (res.responseObject ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(body.countries) ? body.countries : [];
  return raw
    .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object')
    .map((c) => ({
      code: typeof c.code === 'string' ? c.code : '',
      name: typeof c.name === 'string' ? c.name : '',
      region: typeof c.region === 'string' && c.region.trim() ? c.region : null,
      flagIconUrl: typeof c.flagIconUrl === 'string' ? c.flagIconUrl : null,
      flagImageUrl: typeof c.flagImageUrl === 'string' ? c.flagImageUrl : null,
      state: typeof c.state === 'string' ? c.state : '',
    }))
    .filter((c) => c.code && c.name && (c.state === 'active' || c.state === 'preview'))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * `anx.region.list`. Public command. Mirrors the portal: every non-global
 * region, including inactive ones, so the picker can explain why a country is
 * unavailable instead of silently resolving to nothing.
 */
export async function listRegions(
  opts: AuthClientOptions,
  input: { includeInactive?: boolean } = {},
): Promise<RegionRow[]> {
  const res = await sendCommand(opts, 'anx.region.list', {
    includeInactive: input.includeInactive ?? true,
  });
  const body = (res.responseObject ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(body.regions) ? body.regions : [];
  return raw
    .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object')
    .map((r) => ({
      slug: typeof r.slug === 'string' ? r.slug : '',
      name: typeof r.name === 'string' ? r.name : '',
      state: typeof r.state === 'string' ? r.state : '',
      countryCodes: Array.isArray(r.countryCodes)
        ? r.countryCodes.filter((c): c is string => typeof c === 'string')
        : [],
      flagIconUrl: typeof r.flagIconUrl === 'string' ? r.flagIconUrl : null,
    }))
    .filter((r) => r.slug && r.slug !== 'global');
}
