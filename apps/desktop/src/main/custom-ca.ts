/**
 * Renderer-side custom-CA trust for a self-signed / private region node.
 *
 * Electron's `setCertificateVerifyProc` is the only way to teach the *renderer's*
 * network stack about a CA that is not in the OS trust store. The trap (and the
 * root cause of the "Failed to fetch" bug) is that Chromium only hands the proc
 * the **leaf** certificate for a private CA — `request.certificate.issuerCert`
 * is absent — so comparing the presented chain's fingerprints against the CA
 * bundle's fingerprints can never match. The connection is then rejected and
 * every renderer `fetch` to the region fails with "Failed to fetch".
 *
 * The correct decision is cryptographic: accept the leaf only when its signature
 * verifies against a CA we were explicitly configured to trust, the validity
 * windows hold, and the leaf actually covers the host we asked for. This module
 * is pure and exportable so that decision is unit-testable without Electron.
 */

import { X509Certificate } from 'node:crypto';
import { certificateFingerprint, verifyLeafIssuedByCa } from '@nexus/node-core';

/** The subset of Electron's `CertificateVerifyProcRequest` we rely on. */
export type VerifyRequest = {
  /** The hostname/IP the connection targeted. */
  hostname?: string;
  /**
   * Chromium's own verdict for the chain. `OK` means it already verified (a
   * public CA); anything else is a negative `net::` error code.
   */
  verificationResult?: string;
  /** Negative `net::` error code to propagate when we cannot accept. */
  errorCode?: number;
  /** The presented certificate (PEM in `data`). */
  certificate?: { data?: string; fingerprint?: string } | null;
};

/** `0` accepts; any negative value rejects (per Electron's contract). */
export const ACCEPT = 0;

/**
 * Build the decision function backing `session.setCertificateVerifyProc`.
 *
 * `caPem` is the configured bundle; `trustedFingerprints` is the fingerprint set
 * for the same bundle (passed in so the caller computes it once per CA change).
 */
export function createCustomCaVerifier(caPem: string, trustedFingerprints: Set<string>) {
  return function verify(request: VerifyRequest): number {
    const leaf = parseLeaf(request.certificate?.data);
    if (leaf) {
      // Fast path: Chromium may already have built a full chain and we were told
      // to trust one of its certificates by fingerprint.
      if (trustedFingerprints.has(certificateFingerprint(leaf))) {
        return ACCEPT;
      }
      // The real check: the leaf is signed by one of our configured CAs.
      const verdict = verifyLeafIssuedByCa({
        leaf,
        caPem,
        hostname: request.hostname ?? null,
      });
      if (verdict.ok) return ACCEPT;
    }
    // Fall back to Chromium's verdict: accept a chain it already validated
    // (public CAs), otherwise propagate the original error. There is no "use
    // default" sentinel — only 0 or a negative code.
    if (request.verificationResult === 'OK') return ACCEPT;
    return typeof request.errorCode === 'number' ? request.errorCode : -2;
  };
}

function parseLeaf(pem: string | undefined): X509Certificate | null {
  if (!pem || !pem.trim()) return null;
  try {
    return new X509Certificate(pem);
  } catch {
    return null;
  }
}
