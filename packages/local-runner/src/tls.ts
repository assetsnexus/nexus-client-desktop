/**
 * Local TLS material for the desktop's BYOK edge runner (Phase 4).
 *
 * The region enforces `https` on every BYOK `endpointUrl` ("endpointUrl must use
 * https so the key is not sent in the clear"), so the loopback OpenAI-compatible
 * runner needs its own certificate. We mint a self-signed leaf for `localhost` /
 * `127.0.0.1` and hand the PEM pair to the local https server; the region talks
 * to it over the loopback interface.
 *
 * `selfsigned` is the only implementation detail worth isolating: everything
 * else here (alt names, expiry, PEM shape) is testable without it.
 */

import { X509Certificate } from 'node:crypto';
import { generate } from 'selfsigned';

export type LocalTlsMaterial = {
  /** PEM private key for the server. Kept in the OS secure store, never logged. */
  keyPem: string;
  /** PEM leaf certificate. */
  certPem: string;
  /** Subject alt names baked into the certificate. */
  altNames: string[];
  fingerprint: string;
  notAfter: string;
};

/** Alt names a loopback runner must present so `https://localhost` verifies. */
export const LOCAL_RUNNER_ALT_NAMES: readonly string[] = ['localhost', '127.0.0.1', '::1'];

export type MintOptions = {
  /** Certificate lifetime in days. Default 825 (the CA/Browser ceiling). */
  days?: number;
  altNames?: string[];
  /** Injected for deterministic tests. */
  now?: Date;
};

/**
 * Mint a self-signed certificate for the loopback runner.
 *
 * NOTE: self-signed is correct *here* only because the endpoint is loopback and
 * short-lived; a public endpoint must chain to a real CA.
 */
export async function mintLocalTls(options: MintOptions = {}): Promise<LocalTlsMaterial> {
  const days = options.days ?? 825;
  const altNames = [...(options.altNames ?? LOCAL_RUNNER_ALT_NAMES)];
  const notBeforeDate = options.now ?? new Date();
  const notAfterDate = new Date(notBeforeDate.getTime() + days * 24 * 60 * 60 * 1000);
  const attrs = [{ name: 'commonName', type: '2.5.4.3', value: 'nexus-local-runner' }];

  const pems = await generate(attrs, {
    notBeforeDate,
    notAfterDate,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        // 2 = DNS name; 7 = IP address (ip must be set for type 7).
        altNames: altNames.map((value) =>
          value === 'localhost' ? { type: 2 as const, value } : { type: 7 as const, ip: value },
        ),
      },
    ],
  });

  return {
    keyPem: pems.private,
    certPem: pems.cert,
    altNames,
    fingerprint: pems.fingerprint,
    notAfter: expiryFrom(pems.cert),
  };
}

/** Read `notAfter` from a PEM leaf (undefined-safe; falls back to ''). */
function expiryFrom(certPem: string): string {
  try {
    return new X509Certificate(certPem).validTo;
  } catch {
    return '';
  }
}
