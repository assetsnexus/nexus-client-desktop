/**
 * TLS / custom CA helpers.
 *
 * A local or self-signed region node must be trusted by the Node side (main
 * process). The renderer needs the same trust separately, which the desktop
 * main process handles through Electron's session certificate handling.
 *
 * Dependency-free on purpose: only Node built-ins are used so this package
 * stays portable between the desktop app and the CLI.
 */

import { Agent as HttpsAgent } from 'node:https';

export type NodeTlsOptions = {
  /** PEM contents of a custom CA bundle. */
  caPem?: string | null;
  /** Disable verification (local dev only; never ship a UI toggle for this). */
  allowInsecure?: boolean;
};

/**
 * Build a Node `https.Agent` that trusts {@link NodeTlsOptions.caPem}.
 * Returns `undefined` when no custom trust is required, so callers can pass it
 * straight to request libraries that accept an agent.
 */
export function createHttpsAgent(options: NodeTlsOptions): HttpsAgent | undefined {
  const ca = options.caPem?.trim();
  if (!ca && !options.allowInsecure) return undefined;
  return new HttpsAgent({
    ...(ca ? { ca } : {}),
    rejectUnauthorized: options.allowInsecure ? false : true,
    keepAlive: true,
  });
}

/** True when a PEM string looks like one or more certificates. */
export function looksLikePemCertificate(pem: string | null | undefined): boolean {
  if (!pem || typeof pem !== 'string') return false;
  return /-----BEGIN CERTIFICATE-----/.test(pem) && /-----END CERTIFICATE-----/.test(pem);
}

/**
 * Split a PEM bundle into individual DER-free PEM blocks. Used to install each
 * certificate into Electron's session for renderer trust.
 */
export function splitPemCertificates(pem: string | null | undefined): string[] {
  if (!pem || typeof pem !== 'string') return [];
  const matches = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  return matches ? matches.map((m) => m.trim()) : [];
}
