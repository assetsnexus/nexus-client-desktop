/**
 * User-approved TLS certificate pins ("trust this certificate").
 *
 * A connection to the region (or an asset **gateway**) can fail *only* because
 * its certificate is not in the OS trust store (a self-signed / private CA). The
 * app must never weaken verification globally, so instead of a blanket bypass we
 * ask the user to explicitly trust **one** certificate: we pin its fingerprint
 * **scoped to the exact host**, persist the decision, and thereafter accept only
 * that fingerprint for that host.
 *
 * The decision core here is pure — given a certificate-verify failure and the
 * set of prior decisions it returns `allow` / `deny` / `prompt` — so the
 * trust-on-first-use policy is unit-testable without Electron. The store and the
 * (injected) confirm dialog stay small and dependency-light.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import { describeCertificate, normalizeFingerprint, type CertificateDetails } from '@nexus/node-core';

/** Why a certificate-verify failure should offer the trust prompt. */
export type CertFailureReason =
  | 'authority-invalid'
  | 'self-signed'
  | 'name-mismatch'
  | 'expired'
  | 'unknown';

/** One persisted user trust decision: a fingerprint pinned to a host. */
export type CertTrustEntry = {
  /** Lowercased host (no port) the pin applies to. */
  host: string;
  /** Normalized (bare uppercase hex) SHA-256 fingerprint of the pinned cert. */
  fingerprint: string;
  subject: string;
  issuer: string;
  validFrom: string | null;
  validTo: string | null;
  /** Epoch ms the user approved it. */
  trustedAt: number;
};

/** A certificate we can actually reason about (host + fingerprint + details). */
export type CertRef = {
  host: string;
  fingerprint: string;
  details: CertificateDetails | null;
};

/** Payload handed to the UI when a prompt must be shown. */
export type CertPromptInfo = {
  host: string;
  fingerprint: string;
  subject: string;
  issuer: string;
  validFrom: string | null;
  validTo: string | null;
  /** Chromium's verdict string, e.g. `CERT_AUTHORITY_INVALID`. */
  verificationResult: string;
  reason: CertFailureReason;
};

/** The pure outcome of the trust decision for one verify request. */
export type CertVerifyDecision =
  | { decision: 'allow' }
  | { decision: 'deny' }
  | { decision: 'prompt'; info: CertPromptInfo };

/** The subset of Electron's `Certificate` the decision core reads. */
export type CertLike = {
  /** PEM data. */
  data?: string | null;
  /** Electron's own fingerprint (may be a different digest). */
  fingerprint?: string | null;
};

/** Input to the decision core — a trimmed `CertificateVerifyProcRequest`. */
export type CertVerifyInput = {
  hostname?: string | null;
  certificate?: CertLike | null;
  /** Chromium's verdict string (`OK` when it already validated the chain). */
  verificationResult?: string | null;
};

const MAX_ENTRIES = 100;

/** Normalize a host for scoping: lowercase, strip IPv6 brackets and any port. */
export function normalizeHost(raw: string | null | undefined): string {
  let host = String(raw ?? '').trim().toLowerCase();
  if (!host) return '';
  if (host.startsWith('[')) {
    // Bracketed IPv6, optionally with a port: `[::1]:3005`.
    const close = host.indexOf(']');
    if (close !== -1) host = host.slice(0, close + 1);
  } else if (host.split(':').length === 2 && !host.includes('::')) {
    // A single colon with no `::` is a `host:port`, not a bare IPv6 literal.
    host = host.slice(0, host.indexOf(':'));
  }
  return host.replace(/^\[|\]$/g, '');
}

/** Stable key for a (host, fingerprint) pin. */
export function pinKey(host: string, fingerprint: string): string {
  return `${normalizeHost(host)}|${normalizeFingerprint(fingerprint)}`;
}

/**
 * Resolve a presented certificate into a scopeable {@link CertRef}, or null when
 * it cannot be pinned (no host, or no fingerprint we can trust). The fingerprint
 * is computed from the PEM `data` (a real SHA-256); Electron's own `fingerprint`
 * is only a fallback. Both are normalized before comparison.
 */
export function resolveCertRef(input: CertVerifyInput): CertRef | null {
  const host = normalizeHost(input.hostname);
  if (!host) return null;

  const data = typeof input.certificate?.data === 'string' ? input.certificate.data : '';
  const details = data.trim() ? describeCertificate(data) : null;
  const fingerprint = normalizeFingerprint(details?.fingerprint ?? input.certificate?.fingerprint ?? '');
  if (!fingerprint) return null;
  return { host, fingerprint, details };
}

/** Classify a Chromium verdict string into a user-facing failure reason. */
export function classifyCertFailure(verificationResult: string | null | undefined): CertFailureReason {
  const r = String(verificationResult ?? '').toUpperCase();
  if (r.includes('AUTHORITY_INVALID') || r.includes('UNABLE_TO_GET_ISSUER')) return 'authority-invalid';
  if (r.includes('SELF_SIGNED')) return 'self-signed';
  if (r.includes('COMMON_NAME_INVALID') || r.includes('NAME_MISMATCH') || r.includes('NAME_CONSTRAINT')) {
    return 'name-mismatch';
  }
  if (r.includes('EXPIRED') || r.includes('DATE_INVALID')) return 'expired';
  return 'unknown';
}

/** Build the UI payload for a prompt from a resolvable certificate. */
export function buildPromptInfo(ref: CertRef, verificationResult: string | null | undefined): CertPromptInfo {
  return {
    host: ref.host,
    fingerprint: ref.fingerprint,
    subject: ref.details?.subject ?? '',
    issuer: ref.details?.issuer ?? '',
    validFrom: ref.details?.validFrom ?? null,
    validTo: ref.details?.validTo ?? null,
    verificationResult: String(verificationResult ?? ''),
    reason: classifyCertFailure(verificationResult),
  };
}

/** Read-only view of the trust store used by the decision core. */
export type CertTrustLookup = {
  isTrusted(host: string, fingerprint: string): boolean;
};

/**
 * The pure decision core. `OK` passes through; a resolvable certificate that is
 * already pinned is allowed; any other resolvable failure prompts; anything we
 * cannot scope (no host / no fingerprint) is denied. There is deliberately no
 * path to `allow` without either Chromium's own `OK` or an exact pin.
 */
export function decideCertificateTrust(store: CertTrustLookup, input: CertVerifyInput): CertVerifyDecision {
  if (String(input.verificationResult ?? '') === 'OK') return { decision: 'allow' };
  const ref = resolveCertRef(input);
  if (!ref) return { decision: 'deny' };
  if (store.isTrusted(ref.host, ref.fingerprint)) return { decision: 'allow' };
  return { decision: 'prompt', info: buildPromptInfo(ref, input.verificationResult) };
}

export type CertTrustStore = CertTrustLookup & {
  list(): CertTrustEntry[];
  trust(entry: Omit<CertTrustEntry, 'trustedAt'> & { trustedAt?: number }): CertTrustEntry;
  revoke(host: string, fingerprint?: string): void;
  clear(): void;
  filePath(): string;
};

type PersistedTrust = { version: 1; entries: CertTrustEntry[] };

function coerceEntry(raw: unknown): CertTrustEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const host = normalizeHost(typeof value.host === 'string' ? value.host : '');
  const fingerprint = normalizeFingerprint(typeof value.fingerprint === 'string' ? value.fingerprint : '');
  if (!host || !fingerprint) return null;
  const iso = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
  return {
    host,
    fingerprint,
    subject: typeof value.subject === 'string' ? value.subject : '',
    issuer: typeof value.issuer === 'string' ? value.issuer : '',
    validFrom: iso(value.validFrom),
    validTo: iso(value.validTo),
    trustedAt: typeof value.trustedAt === 'number' && Number.isFinite(value.trustedAt) ? value.trustedAt : 0,
  };
}

/**
 * File-backed trust store. Stored as plain JSON in `userData` (fingerprints and
 * public certificate metadata only — never private key material). Re-validated
 * on every read so a hand-edited file cannot smuggle in a malformed pin.
 */
export function createCertTrustStore(filePath?: string): CertTrustStore {
  const path = filePath ?? join(app.getPath('userData'), 'trusted-certs.json');

  const read = (): CertTrustEntry[] => {
    if (!existsSync(path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PersistedTrust>;
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
      return entries.map(coerceEntry).filter((e): e is CertTrustEntry => e !== null);
    } catch {
      return [];
    }
  };

  const write = (entries: CertTrustEntry[]): void => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const payload: PersistedTrust = { version: 1, entries };
      writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8');
    } catch {
      // Best-effort persistence: a read-only userData must not crash the app.
    }
  };

  return {
    filePath: () => path,
    list() {
      return read().sort((a, b) => b.trustedAt - a.trustedAt);
    },
    isTrusted(host, fingerprint) {
      const h = normalizeHost(host);
      const fp = normalizeFingerprint(fingerprint);
      if (!h || !fp) return false;
      return read().some((e) => e.host === h && e.fingerprint === fp);
    },
    trust(input) {
      const host = normalizeHost(input.host);
      const fingerprint = normalizeFingerprint(input.fingerprint);
      if (!host || !fingerprint) {
        throw new Error('a trust pin requires a host and a fingerprint');
      }
      const entry: CertTrustEntry = {
        host,
        fingerprint,
        subject: input.subject ?? '',
        issuer: input.issuer ?? '',
        validFrom: input.validFrom ?? null,
        validTo: input.validTo ?? null,
        trustedAt: Number.isFinite(input.trustedAt) ? (input.trustedAt as number) : Date.now(),
      };
      const rest = read().filter((e) => !(e.host === host && e.fingerprint === fingerprint));
      const next = [entry, ...rest].sort((a, b) => b.trustedAt - a.trustedAt).slice(0, MAX_ENTRIES);
      write(next);
      return entry;
    },
    revoke(host, fingerprint) {
      const h = normalizeHost(host);
      if (!h) return;
      const fp = fingerprint ? normalizeFingerprint(fingerprint) : null;
      write(read().filter((e) => !(e.host === h && (fp === null || e.fingerprint === fp))));
    },
    clear() {
      write([]);
    },
  };
}

/** Show the trust prompt; resolves true only on explicit user approval. */
export type CertConfirm = (info: CertPromptInfo) => Promise<boolean>;

export type CertPromptBridge = {
  /**
   * Request trust for a presented certificate. Safe to call on every failing
   * handshake: a fingerprint already prompting, or any prompt already open, is
   * ignored so a burst of fetches never stacks dialogs or loops.
   */
  requestTrust(info: CertPromptInfo): void;
  /** Number of prompts currently in flight (test/inspection aid). */
  pendingCount(): number;
};

/**
 * Coalesce trust prompts: at most one dialog open at a time, at most one pending
 * decision per (host, fingerprint). On approval the pin is persisted and
 * `onChanged` fires so the caller can re-pin the session (invalidating
 * Chromium's cached verify result) and let the connection retry.
 */
export function createCertPromptBridge(options: {
  store: CertTrustStore;
  confirm: CertConfirm;
  onChanged?: (entry: CertTrustEntry) => void;
}): CertPromptBridge {
  const pending = new Set<string>();
  let dialogOpen = false;

  return {
    pendingCount: () => pending.size,
    requestTrust(info) {
      const key = pinKey(info.host, info.fingerprint);
      if (pending.has(key) || dialogOpen) return;
      pending.add(key);
      dialogOpen = true;
      void options
        .confirm(info)
        .then((approved) => {
          if (!approved) return;
          const entry = options.store.trust({
            host: info.host,
            fingerprint: info.fingerprint,
            subject: info.subject,
            issuer: info.issuer,
            validFrom: info.validFrom,
            validTo: info.validTo,
          });
          options.onChanged?.(entry);
        })
        .catch(() => {
          // A failed dialog must not wedge the queue: fall through to cleanup.
        })
        .finally(() => {
          dialogOpen = false;
          pending.delete(key);
        });
    },
  };
}
