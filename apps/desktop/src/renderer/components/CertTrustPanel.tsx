/**
 * Settings → Trusted certificates.
 *
 * A read/revoke surface for user-approved TLS certificate pins ("trust this
 * certificate"). Trusting happens through the prompt at connection time; this
 * panel is where the user reviews what has been pinned and can revoke any of it
 * (revocation re-pins the session, so the next connection re-verifies).
 */

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { bridge, type CertificateTrustEntry } from '../bridge.js';

const section: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: 16,
  border: '1px solid #2a333d',
  borderRadius: 12,
  background: '#12171c',
};

const button: CSSProperties = {
  padding: '5px 10px',
  borderRadius: 8,
  border: '1px solid #3a4654',
  background: '#1c2430',
  color: '#e8eef4',
  cursor: 'pointer',
  fontSize: 12,
};

export function CertTrustPanel() {
  const [entries, setEntries] = useState<CertificateTrustEntry[] | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setEntries(await bridge.certTrustList());
    } catch {
      setEntries([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const revoke = useCallback(
    async (host: string, fingerprint: string) => {
      setBusy(true);
      try {
        setEntries(await bridge.certTrustRevoke(host, fingerprint));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  return (
    <section style={section}>
      <h2 style={{ margin: 0, fontSize: 16 }}>Trusted certificates</h2>
      <p style={{ margin: 0, color: '#6b7784', fontSize: 12 }}>
        Certificates you explicitly trusted for a host (region node or asset gateway). Trust is
        pinned to the exact certificate fingerprint and host. Revoking takes effect on the next
        connection.
      </p>

      {entries === null ? (
        <p style={{ margin: 0, color: '#6b7784', fontSize: 12 }}>Loading…</p>
      ) : entries.length === 0 ? (
        <p style={{ margin: 0, color: '#6b7784', fontSize: 12 }}>No trusted certificates.</p>
      ) : (
        entries.map((entry) => (
          <div
            key={`${entry.host}|${entry.fingerprint}`}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              padding: 10,
              border: '1px solid #2a333d',
              borderRadius: 8,
              background: '#0f1419',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <strong style={{ fontSize: 13 }}>{entry.host}</strong>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                style={button}
                disabled={busy}
                onClick={() => void revoke(entry.host, entry.fingerprint)}
              >
                Revoke
              </button>
            </div>
            <span style={{ color: '#6b7784', fontSize: 11, wordBreak: 'break-all' }}>
              {entry.subject || '—'}
            </span>
            <span style={{ color: '#6b7784', fontSize: 11, wordBreak: 'break-all' }}>
              issued by {entry.issuer || '—'}
              {entry.validTo ? ` · valid to ${entry.validTo}` : ''}
            </span>
            <span style={{ color: '#6b7784', fontSize: 11, fontFamily: 'monospace', wordBreak: 'break-all' }}>
              SHA-256 {entry.fingerprint}
            </span>
          </div>
        ))
      )}
    </section>
  );
}
