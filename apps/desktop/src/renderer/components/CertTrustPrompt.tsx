/**
 * "Trust this certificate?" prompt.
 *
 * Main's certificate-verify proc raises this when a TLS connection to the region
 * or an asset gateway fails **only** because the certificate is not trusted (a
 * self-signed / private CA). The user sees exactly what they would be trusting —
 * host, subject, issuer, validity window, SHA-256 fingerprint — and must approve
 * explicitly. Trusting pins that exact fingerprint for that exact host; nothing
 * is ever "trust everything".
 *
 * Loop-safety: main coalesces prompts (one at a time, one per host+fingerprint)
 * and Chromium caches its verify result, so a burst of failing fetches raises a
 * single dialog. This component adds a small same-key cooldown so even an
 * aggressive retry cannot re-open the dialog in a tight loop.
 */

import { useEffect, useRef, useState } from 'react';
import { bridge, type CertificatePromptInfo } from '../bridge.js';

/** Why the connection failed, in plain language. */
function reasonText(info: CertificatePromptInfo): string {
  switch (info.reason) {
    case 'authority-invalid':
      return 'The certificate is not issued by a trusted authority.';
    case 'self-signed':
      return 'The certificate is self-signed.';
    case 'name-mismatch':
      return 'The certificate does not match the host name.';
    case 'expired':
      return 'The certificate is expired or not yet valid.';
    default:
      return 'The certificate could not be verified.';
  }
}

const MS_PER_PROMPT = 2500;

export function CertTrustPrompt() {
  const [info, setInfo] = useState<CertificatePromptInfo | null>(null);
  const [busy, setBusy] = useState(false);
  // Keys the user already trusted this session — do not nag before main re-pins
  // and the page reloads.
  const handled = useRef<Set<string>>(new Set());
  const lastShownAt = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    return bridge.onCertTrustPrompt((next) => {
      const key = `${next.host}|${next.fingerprint}`;
      if (handled.current.has(key)) return;
      const last = lastShownAt.current.get(key) ?? 0;
      const now = Date.now();
      if (now - last < MS_PER_PROMPT && info) return;
      lastShownAt.current.set(key, now);
      setInfo(next);
    });
  }, [info]);

  if (!info) return null;

  const respond = async (trusted: boolean) => {
    const key = `${info.host}|${info.fingerprint}`;
    setBusy(true);
    try {
      if (trusted) handled.current.add(key);
      await bridge.certTrustRespond({ host: info.host, fingerprint: info.fingerprint, trusted });
    } finally {
      setBusy(false);
      setInfo(null);
    }
  };

  const rows: Array<[string, string]> = [
    ['Host', info.host],
    ['Subject', info.subject || '—'],
    ['Issuer', info.issuer || '—'],
    ['Valid from', info.validFrom ?? '—'],
    ['Valid to', info.validTo ?? '—'],
    ['SHA-256', info.fingerprint],
  ];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Untrusted certificate"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(6, 9, 12, 0.72)',
      }}
    >
      <div
        style={{
          width: 'min(560px, 92vw)',
          maxHeight: '86vh',
          overflow: 'auto',
          background: '#141a21',
          color: '#e8eef4',
          border: '1px solid #3a4654',
          borderRadius: 12,
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16, color: '#f2c14e' }}>⚠ Untrusted certificate</h2>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
          The app could not verify the certificate presented by <strong>{info.host}</strong>.{' '}
          {reasonText(info)}
        </p>

        <div
          style={{
            border: '1px solid #2a333d',
            borderRadius: 8,
            padding: '10px 12px',
            background: '#0f1419',
            fontFamily: 'monospace',
            fontSize: 12,
            lineHeight: 1.6,
          }}
        >
          {rows.map(([label, value]) => (
            <div key={label} style={{ display: 'flex', gap: 8 }}>
              <span style={{ color: '#6b7784', minWidth: 84 }}>{label}</span>
              <span style={{ wordBreak: 'break-all' }}>{value}</span>
            </div>
          ))}
        </div>

        <p style={{ margin: 0, fontSize: 12, color: '#f2a1a1', lineHeight: 1.5 }}>
          If you trust this certificate, the app will accept exactly this certificate for{' '}
          <strong>{info.host}</strong> from now on. If this is not your own server (or you did not
          expect a custom certificate), a third party could be intercepting your connection and read
          or change your traffic. Only continue if you recognise this certificate.
        </p>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            type="button"
            disabled={busy}
            onClick={() => void respond(false)}
            style={{
              padding: '8px 14px',
              borderRadius: 8,
              border: '1px solid #3a4654',
              background: '#1c2430',
              color: '#e8eef4',
              cursor: busy ? 'default' : 'pointer',
              fontSize: 13,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void respond(true)}
            style={{
              padding: '8px 14px',
              borderRadius: 8,
              border: '1px solid #b5791a',
              background: '#8a5a12',
              color: '#fff',
              cursor: busy ? 'default' : 'pointer',
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            Trust this certificate
          </button>
        </div>
      </div>
    </div>
  );
}
