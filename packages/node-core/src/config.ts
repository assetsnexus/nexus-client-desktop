/**
 * Connection configuration for the Nexus desktop client.
 *
 * The desktop is a *client*: region node + inference are cloud-hosted per
 * region stack. All three connection points are user-overridable in settings
 * and fall back to the sandbox defaults below.
 *
 * Final Nexus architecture introduces anx-gateways as registries of region
 * nodes. Until then the gateway defaults to the region node URL, so an unset
 * gateway transparently resolves to the region.
 */

/** Canonical client app identity sent as `X-Anx-App`. */
export const DESKTOP_APP_ID = 'nexus-desktop';

/** Device type registered with `anx.device.register`. */
export const DESKTOP_DEVICE_TYPE = 'desktop';

/** Sandbox region node default. */
export const DEFAULT_REGION_URL = 'https://1.west.eu.region.sandbox.assetsnexus.org';

/** Sandbox portal default (fallback; the region may advertise its own). */
export const DEFAULT_PORTAL_URL = 'https://portal.sandbox.assetsnexus.org';

export type DesktopConnectionConfig = {
  /**
   * Gateway registry URL. Defaults to the resolved region URL when unset
   * (gateways are not deployed yet).
   */
  gatewayUrl?: string | null;
  /** Region node base URL. */
  regionUrl: string;
  /** Optional portal URL for redirects; falls back to {@link DEFAULT_PORTAL_URL}. */
  portalUrl?: string | null;
  /** Custom CA bundle contents (PEM) for local/self-signed region nodes. */
  customCaPem?: string | null;
  /** App identity header value. */
  appId?: string;
  /** Device type reported at registration. */
  deviceType?: string;
};

export type ResolvedConnectionConfig = {
  gatewayUrl: string;
  regionUrl: string;
  portalUrl: string;
  customCaPem: string | null;
  appId: string;
  deviceType: string;
};

/** Normalize a base URL: require http(s) and strip trailing slashes. */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) throw new Error('base url is empty');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`invalid base url: ${trimmed}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`unsupported protocol: ${url.protocol}`);
  }
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}${url.search}`;
}

/** True for loopback hosts, where plain `http:` is acceptable for local dev. */
export function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/**
 * Resolve raw (possibly partial) config into a complete, validated config.
 * Gateway defaults to the region; portal falls back to the sandbox default.
 */
export function resolveConnectionConfig(
  input: Partial<DesktopConnectionConfig> = {},
): ResolvedConnectionConfig {
  const regionUrl = normalizeBaseUrl(input.regionUrl?.trim() || DEFAULT_REGION_URL);
  const gatewayUrl = normalizeBaseUrl(input.gatewayUrl?.trim() || regionUrl);
  const portalUrl = normalizeBaseUrl(input.portalUrl?.trim() || DEFAULT_PORTAL_URL);
  return {
    gatewayUrl,
    regionUrl,
    portalUrl,
    customCaPem: input.customCaPem?.trim() ? input.customCaPem : null,
    appId: input.appId?.trim() || DESKTOP_APP_ID,
    deviceType: input.deviceType?.trim() || DESKTOP_DEVICE_TYPE,
  };
}
