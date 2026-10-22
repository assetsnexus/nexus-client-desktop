/**
 * Sandbox vs production detection for the desktop app.
 *
 * Mirrors the portal's `sandbox-environment.js`: the region command
 * `anx.config.environment` is the source of truth. A build-time flag (the
 * portal's `VUE_APP_ANX_ENVIRONMENT`) is only a fallback when that command
 * cannot be read. Anything unreadable fails closed to "not sandbox" so a
 * transient region outage never falsely claims sandbox — and never blocks login.
 */

/** Which environment the connected region reports. */
export type RegionEnvironment = 'sandbox' | 'production';

/**
 * Subset of the region command envelope the decision needs. Main returns this
 * shape over IPC; the full envelope carries more, but only these two fields are
 * trusted here.
 */
export type RegionEnvironmentResponse = {
  responseCode?: number;
  responseObject?: unknown;
};

/** Badge label, matching the portal's `auth.instance.sandboxName`. */
export const SANDBOX_BADGE_LABEL = 'SANDBOX';

/**
 * Badge tooltip, matching the portal's `auth.instance.sandboxBody`
 * (SandboxHeaderBadge title).
 */
export const SANDBOX_BADGE_DESCRIPTION =
  'Test environment for portal onboarding and ANX workflows. Fake users and organizations are allowed. ' +
  'Demo wallet funds are dummy money for trying projects and asset costs. AI usage, storage, and agent ' +
  'phone-channel costs are real charges, including on the free plan. Sandbox subscription plans ' +
  '(NEXUS_TIER) are real Stripe charges. Bring your own key (BYOK) and bring your own storage (BYOS) are supported.';

/**
 * Login-time disclaimer. Verbatim from the portal's Terms page
 * (`Terms.vue`): "The sandbox is an early-access environment. Issues are
 * expected. You use it at your own risk, as-is, without warranty."
 */
export const SANDBOX_DISCLAIMER =
  'The sandbox is an early-access environment. Issues are expected. You use it at your own risk, as-is, without warranty.';

/** Portal route the disclaimer links to (matches the portal `/terms` route). */
export const SANDBOX_TERMS_PATH = '/terms';

/**
 * Link label for the disclaimer. Matches the portal's login terms link
 * (`auth.acceptTermsLink` = "terms and conditions") rather than inventing copy.
 */
export const SANDBOX_TERMS_LABEL = 'terms and conditions';

/** True only for the exact `sandbox` token (trimmed, case-insensitive). */
export function isSandboxEnvironment(value: unknown): boolean {
  return String(value == null ? '' : value).trim().toLowerCase() === 'sandbox';
}

/**
 * Read the environment out of an `anx.config.environment` response.
 * Returns null when the payload cannot be trusted (non-200, missing/blank
 * environment), so callers fall back rather than guessing.
 */
export function environmentFromConfigResponse(
  response: RegionEnvironmentResponse | null | undefined,
): RegionEnvironment | null {
  if (!response || response.responseCode !== 200) return null;
  const body =
    response.responseObject && typeof response.responseObject === 'object'
      ? (response.responseObject as Record<string, unknown>)
      : (response as Record<string, unknown>);
  const raw = body.environment != null ? body.environment : body.value;
  if (raw == null || String(raw).trim() === '') return null;
  return isSandboxEnvironment(raw) ? 'sandbox' : 'production';
}

/**
 * Decide whether the sandbox badge / disclaimer should show. The region answer
 * wins; an unreadable region falls back to the build flag, so a production
 * build stays hidden when the public command fails.
 */
export function shouldShowSandboxBadge({
  regionEnvironment,
  buildEnvironment,
}: {
  regionEnvironment?: RegionEnvironment | null;
  buildEnvironment?: unknown;
} = {}): boolean {
  if (regionEnvironment === 'sandbox') return true;
  if (regionEnvironment === 'production') return false;
  return isSandboxEnvironment(buildEnvironment);
}

/**
 * Absolute URL of the portal's terms page (the portal links the disclaimer to
 * its `/terms` route). Null when no portal URL is known, so the UI can render
 * the disclaimer without a dead link.
 */
export function sandboxTermsUrl(portalUrl: string | null | undefined): string | null {
  if (!portalUrl || !portalUrl.trim()) return null;
  return `${portalUrl.replace(/\/+$/, '')}${SANDBOX_TERMS_PATH}`;
}
