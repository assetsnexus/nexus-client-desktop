/**
 * Renderer-side certificate trust for a self-signed / private region node.
 *
 * Electron's `setCertificateVerifyProc` is the only way to teach the *renderer's*
 * network stack about a CA that is not in the OS trust store. The trap (and the
 * root cause of the "Failed to fetch" bug) is that Chromium only hands the proc
 * the **leaf** certificate for a private CA — `request.certificate.issuerCert`
 * is absent — so comparing the presented chain's fingerprints against the CA
 * bundle's fingerprints can never match. Instead the decision is cryptographic:
 * accept the leaf only when its signature verifies against a CA we were
 * explicitly configured to trust, the validity windows hold, and the leaf
 * actually covers the host we asked for.
 *
 * Two guards make this safe to run as a verify proc:
 *
 * 1. The decision is delegated to the pure `verifyLeafIssuedByCa` /
 *    `decideCertificateTrust` cores, which never throw (a malformed CA bundle or
 *    a runtime without the Node-22 validity accessors fails closed).
 * 2. The proc itself is wrapped so **nothing** can escape as an unhandled
 *    main-process exception — a throw inside `setCertificateVerifyProc` both
 *    crashes the app and rejects the connection.
 */

import { certificateFingerprint, verifyLeafIssuedByCa } from '@nexus/node-core';
import { X509Certificate } from 'node:crypto';
import {
  buildPromptInfo,
  resolveCertRef,
  type CertPromptInfo,
  type CertTrustLookup,
} from './trusted-certs.js';

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

/** A request Electron's verify proc could not accept on its own. */
const DENY_DEFAULT = -2;

/** The `net::` code to propagate when the proc denies, defaulting to `-2`. */
function denyCode(request: VerifyRequest): number {
  return typeof request.errorCode === 'number' ? request.errorCode : DENY_DEFAULT;
}

/**
 * Build the custom-CA decision function (no user prompts).
 *
 * `caPem` is the configured bundle; `trustedFingerprints` is the fingerprint set
 * for the same bundle (passed in so the caller computes it once per CA change).
 * Never throws: any parse/verification failure falls back to Chromium's verdict.
 */
export function createCustomCaVerifier(caPem: string, trustedFingerprints: Set<string>) {
  return function verify(request: VerifyRequest): number {
    try {
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
      return denyCode(request);
    } catch {
      // A verify proc must never throw (it would crash the main process and
      // reject the connection). Fail closed on the original Chromium error.
      if (request.verificationResult === 'OK') return ACCEPT;
      return denyCode(request);
    }
  };
}

export type CertificateVerifyProcOptions = {
  /** Configured custom CA bundle, or null when none is set. */
  caPem: string | null;
  /** SHA-256 fingerprints of {@link caPem} (computed once per CA change). */
  trustedFingerprints: Set<string>;
  /** User-approved certificate pins (from the trust store), if any. */
  trustStore?: CertTrustLookup | null;
  /**
   * Called when an unpinned certificate failure should be offered to the user.
   * The proc still denies this request — trust only applies on the *next*
   * handshake, once the user has approved and the pin is persisted.
   */
  requestTrust?: ((info: CertPromptInfo) => void) | null;
};

/**
 * The full renderer verify proc: configured-CA pin, then user trust pins, then a
 * coalesced "trust this certificate?" prompt, otherwise deny.
 */
export function createCertificateVerifyProc(
  options: CertificateVerifyProcOptions,
): (request: VerifyRequest) => number {
  const caPem = typeof options.caPem === 'string' ? options.caPem : '';
  const caOnly = createCustomCaVerifier(caPem, options.trustedFingerprints);

  return function verify(request: VerifyRequest): number {
    try {
      // (1) The configured CA is the primary source of trust.
      if (request.verificationResult === 'OK') return ACCEPT;
      if (caOnly(request) === ACCEPT) return ACCEPT;

      // (2) A previously user-approved pin for exactly this host + fingerprint.
      const ref = resolveCertRef(request);
      if (ref && options.trustStore?.isTrusted(ref.host, ref.fingerprint)) return ACCEPT;

      // (3) Offer to trust it — but do not accept now. The prompt coalesces, so a
      // burst of failing fetches cannot stack dialogs or loop.
      if (ref && options.requestTrust) {
        options.requestTrust(buildPromptInfo(ref, request.verificationResult));
      }
      return denyCode(request);
    } catch {
      // See above: never throw out of a verify proc.
      return request.verificationResult === 'OK' ? ACCEPT : denyCode(request);
    }
  };
}

function parseLeaf(pem: string | undefined | null): X509Certificate | null {
  if (!pem || !pem.trim()) return null;
  try {
    return new X509Certificate(pem);
  } catch {
    return null;
  }
}
