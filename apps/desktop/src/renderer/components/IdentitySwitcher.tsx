import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import {
  bridge,
  type IdentitySnapshot,
  type MembershipRow,
  type MembershipLoginStart,
} from '../bridge.js';

const panelStyle: CSSProperties = {
  position: 'absolute',
  top: 52,
  right: 12,
  width: 360,
  maxHeight: 'calc(100vh - 80px)',
  overflowY: 'auto',
  background: '#151b22',
  border: '1px solid #2a333d',
  borderRadius: 12,
  padding: 14,
  zIndex: 20,
  boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid #2a333d',
  background: '#0f1419',
};

const btnStyle: CSSProperties = {
  padding: '5px 10px',
  borderRadius: 8,
  border: '1px solid #3a4654',
  background: '#1c2430',
  color: '#e8eef4',
  cursor: 'pointer',
  fontSize: 12,
};

const inputStyle: CSSProperties = {
  padding: '7px 10px',
  borderRadius: 8,
  border: '1px solid #3a4654',
  background: '#0b1015',
  color: '#e8eef4',
  fontSize: 12,
  width: '100%',
};

/**
 * Identity + account switcher (Phase 9).
 *
 * Mirrors the app/portal: the private identity plus one per org membership, with
 * an org-membership switch flow (membership list -> login -> optional 2FA). The
 * multi-account switcher (different Nexus users) is temporary and only rendered
 * when the main process reports it enabled.
 */
export function IdentitySwitcher({ onClose }: { onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<IdentitySnapshot | null>(null);
  const [memberships, setMemberships] = useState<MembershipRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState<MembershipLoginStart | null>(null);
  const [code, setCode] = useState('');
  const [pendingEmail, setPendingEmail] = useState('');

  const refresh = useCallback(async () => {
    setSnapshot(await bridge.identitySnapshot());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadMemberships = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setMemberships(await bridge.identityListMemberships());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to list memberships');
    } finally {
      setBusy(false);
    }
  }, []);

  const startOrgSwitch = useCallback(async (m: MembershipRow) => {
    if (!m.businessEmail) {
      setError('this membership has no business email on file');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const out = await bridge.identityStartMembership({
        membershipId: m.membershipId,
        businessEmail: m.businessEmail,
      });
      if (out.kind === 'two_factor_required') {
        setChallenge(out);
        setPendingEmail(m.businessEmail);
      } else {
        setChallenge(null);
        await refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'membership login failed');
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const completeOrgSwitch = useCallback(async () => {
    if (!challenge?.loginToken) return;
    setBusy(true);
    setError(null);
    try {
      const method = challenge.hint?.methodSlug ?? challenge.methods?.[0] ?? 'email';
      await bridge.identityCompleteMembership({
        loginToken: challenge.loginToken,
        method,
        code,
        businessEmail: pendingEmail,
      });
      setChallenge(null);
      setCode('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'verification failed');
    } finally {
      setBusy(false);
    }
  }, [challenge, code, pendingEmail, refresh]);

  return (
    <div style={panelStyle}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <strong style={{ fontSize: 14 }}>Identities</strong>
        <span style={{ flex: 1 }} />
        <button type="button" style={btnStyle} onClick={onClose}>
          Close
        </button>
      </div>
      <p style={{ margin: 0, color: '#6b7784', fontSize: 11 }}>
        One private identity plus one per org membership; switch the active identity the way the app
        and portal do.
      </p>

      {error ? <p style={{ margin: 0, color: '#f2a1a1', fontSize: 12 }}>{error}</p> : null}

      {!snapshot ? (
        <p style={{ color: '#6b7784', fontSize: 12 }}>Loading…</p>
      ) : (
        snapshot.accounts.map((account) => (
          <div key={account.userId} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong style={{ fontSize: 12 }}>{account.email ?? account.userId}</strong>
              <span style={{ flex: 1 }} />
              {account.active ? (
                <span style={{ fontSize: 10, color: '#4ade80' }}>ACTIVE</span>
              ) : snapshot.accountSwitcherEnabled ? (
                <button
                  type="button"
                  style={btnStyle}
                  onClick={async () => {
                    setSnapshot(await bridge.identitySwitchAccount(account.userId));
                  }}
                >
                  Switch
                </button>
              ) : null}
            </div>
            {account.identities.map((identity) => (
              <div key={identity.key} style={rowStyle}>
                <span style={{ fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {identity.kind === 'private' ? 'Personal' : identity.label}
                </span>
                <span style={{ fontSize: 10, color: '#6b7784' }}>{identity.role ?? ''}</span>
                {identity.active ? (
                  <span style={{ fontSize: 10, color: '#4ade80' }}>●</span>
                ) : (
                  <button
                    type="button"
                    style={btnStyle}
                    onClick={async () => {
                      setSnapshot(await bridge.identitySwitch(identity.key));
                    }}
                  >
                    Use
                  </button>
                )}
                {identity.kind === 'business' ? (
                  <button
                    type="button"
                    style={btnStyle}
                    onClick={async () => {
                      setSnapshot(await bridge.identityLogout(identity.key));
                    }}
                  >
                    Sign out
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ))
      )}

      <div style={{ borderTop: '1px solid #2a333d', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <strong style={{ fontSize: 12 }}>Org memberships</strong>
          <span style={{ flex: 1 }} />
          <button type="button" style={btnStyle} disabled={busy} onClick={loadMemberships}>
            {memberships ? 'Reload' : 'Load'}
          </button>
        </div>

        {memberships?.map((m) => (
          <div key={m.membershipId} style={rowStyle}>
            <span style={{ fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {m.orgName ?? m.orgId ?? m.membershipId}
            </span>
            <span style={{ fontSize: 10, color: '#6b7784' }}>{m.role ?? ''}</span>
            <button type="button" style={btnStyle} disabled={busy} onClick={() => void startOrgSwitch(m)}>
              Log in
            </button>
          </div>
        ))}
        {memberships && memberships.length === 0 ? (
          <p style={{ margin: 0, color: '#6b7784', fontSize: 11 }}>No org memberships.</p>
        ) : null}

        {challenge ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
            <span style={{ fontSize: 11, color: '#fbbf24' }}>
              2FA required{challenge.hint?.sentTo ? ` — sent to ${challenge.hint.sentTo}` : ''}
            </span>
            <input
              style={inputStyle}
              value={code}
              placeholder="verification code"
              onChange={(e) => setCode(e.target.value)}
            />
            <button type="button" style={btnStyle} disabled={busy || !code} onClick={completeOrgSwitch}>
              Verify
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
