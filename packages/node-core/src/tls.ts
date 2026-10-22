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
import { createHash, X509Certificate } from 'node:crypto';

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

/** Normalize a certificate fingerprint to bare uppercase hex (no colons/spaces). */
export function normalizeFingerprint(value: string | null | undefined): string {
  return String(value ?? '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toUpperCase();
}

/**
 * The set of SHA-256 fingerprints for the certificates in a PEM bundle. Used to
 * pin a custom CA: the renderer's certificate-verify proc only accepts a leaf
 * whose chain fingerprint we were explicitly told to trust.
 */
export function certificateFingerprints(pem: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const block of splitPemCertificates(pem)) {
    try {
      const der = new X509Certificate(block).raw;
      out.add(createHash('sha256').update(der).digest('hex').toUpperCase());
    } catch {
      // Skip anything that does not parse as an X.509 certificate.
    }
  }
  return out;
}

/**
 * Parse a PEM bundle into `X509Certificate` objects, skipping anything malformed.
 * Exposed so callers (e.g. Electron's certificate-verify proc) can validate a
 * *presented leaf* against the CA bundle the user configured — see
 * {@link verifyLeafIssuedByCa}.
 */
export function parseCertificates(pem: string | null | undefined): X509Certificate[] {
  const out: X509Certificate[] = [];
  for (const block of splitPemCertificates(pem)) {
    try {
      out.push(new X509Certificate(block));
    } catch {
      // Skip anything that does not parse as an X.509 certificate.
    }
  }
  return out;
}

/** SHA-256 fingerprint (uppercase hex) of a certificate's DER bytes. */
export function certificateFingerprint(cert: X509Certificate): string {
  return createHash('sha256').update(cert.raw).digest('hex').toUpperCase();
}

/** Why a presented leaf was not accepted against a custom CA bundle. */
export type LeafVerificationReason =
  | 'no-ca'
  | 'unparseable'
  | 'not-issued-by-ca'
  | 'expired'
  | 'not-yet-valid'
  | 'host-mismatch';

export type LeafVerification =
  | { ok: true; issuer: string; fingerprint: string }
  | { ok: false; reason: LeafVerificationReason };

/** True when `value` is an IP literal (v4 or bracketed/raw v6), not a DNS name. */
export function isIpLiteral(value: string): boolean {
  const host = value.trim().replace(/^\[|\]$/g, '');
  if (!host) return false;
  // IPv4 / IPv6 heuristic: every character is a hex digit, dot or colon and it
  // contains at least one dot or colon. DNS names may also be all-hex-digits for
  // short TLD-less labels, so require a separator to avoid misclassifying them.
  if (!/^[0-9a-fA-F.:]+$/.test(host)) return false;
  return host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * Validate that a *presented* leaf certificate is really issued by one of the
 * certificates in `caPem`, and that it matches the host we asked for.
 *
 * This is the missing half of custom-CA support in the Electron renderer:
 * Chromium only hands us the leaf in `request.certificate` (no issuer chain) for
 * a self-signed/private CA, so a fingerprint comparison against the CA bundle
 * can never match. Instead we perform the actual cryptographic check:
 *
 * 1. the leaf's issuer matches a CA subject **and** the leaf's signature
 *    verifies against that CA's public key;
 * 2. the leaf and the issuing CA are within their validity windows;
 * 3. the leaf's SANs cover the requested hostname / IP.
 *
 * A self-signed server certificate that *is* one of the configured CAs is
 * accepted by the same path (it verifies against its own public key), preserving
 * the original explicit-trust behaviour.
 *
 * Never a blanket accept: an unconfigured CA, a different issuer, an expired
 * cert, or a host mismatch all fail closed.
 */
export function verifyLeafIssuedByCa(input: {
  leaf: X509Certificate;
  caPem: string | null | undefined;
  /** Hostname or IP the connection targeted (`request.hostname`). */
  hostname?: string | null;
  /** Injectable clock for tests. */
  now?: Date;
}): LeafVerification {
  const { leaf } = input;
  const cas = parseCertificates(input.caPem);
  if (cas.length === 0) return { ok: false, reason: 'no-ca' };

  const now = input.now ?? new Date();
  const nowMs = now.getTime();

  const leafFrom = leaf.validFromDate.getTime();
  const leafTo = leaf.validToDate.getTime();
  if (Number.isFinite(leafFrom) && nowMs < leafFrom) return { ok: false, reason: 'not-yet-valid' };
  if (Number.isFinite(leafTo) && nowMs > leafTo) return { ok: false, reason: 'expired' };

  let matchedIssuer: X509Certificate | null = null;
  for (const ca of cas) {
    const caFrom = ca.validFromDate.getTime();
    const caTo = ca.validToDate.getTime();
    if (Number.isFinite(caFrom) && nowMs < caFrom) continue;
    if (Number.isFinite(caTo) && nowMs > caTo) continue;
    // A CA that is not marked `CA:TRUE` can still be the leaf itself (a
    // self-signed server cert); `issuer === subject` covers that case.
    if (leaf.issuer !== ca.subject) continue;
    try {
      if (!leaf.verify(ca.publicKey)) continue;
    } catch {
      continue;
    }
    matchedIssuer = ca;
    break;
  }
  if (!matchedIssuer) return { ok: false, reason: 'not-issued-by-ca' };

  const host = input.hostname?.trim();
  if (host) {
    let hostOk = false;
    try {
      hostOk = isIpLiteral(host) ? Boolean(leaf.checkIP(unbracket(host))) : Boolean(leaf.checkHost(host));
    } catch {
      hostOk = false;
    }
    if (!hostOk) return { ok: false, reason: 'host-mismatch' };
  }

  return {
    ok: true,
    issuer: matchedIssuer.subject,
    fingerprint: certificateFingerprint(leaf),
  };
}

function unbracket(value: string): string {
  return value.trim().replace(/^\[|\]$/g, '');
}
