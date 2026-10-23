import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  bridge,
  type IdentitySnapshot,
  type MembershipRow,
  type MembershipLoginStart,
} from '../bridge.js';
import { orgInitials, resolveOrgLogoUrl } from '../../shared/org-logo.js';
import { humanLabel } from '../../shared/identity-labels.js';
import {
  applySwitchResult,
  beginSwitch,
  cancelSwitch,
  initialSwitchUiState,
  type SwitchUiState,
} from '../../shared/identity-switch-state.js';
import { Modal } from './Modal.js';

/**
 * The panel is anchored inside `<main>` (which already sits below the header), so
 * it pins to `main`'s top/bottom rather than to `100vh`. Using `top` + `bottom`
 * with `overflowY:auto` guarantees the panel (and its long membership list) can
 * never extend past the workspace, at any window size — the previous
 * `top:52 + maxHeight: calc(100vh - 80px)` overflowed the bottom because the
 * offset was measured from `main`, not the viewport.
 */
const panelStyle: CSSProperties = {
  position: 'absolute',
  top: 8,
  bottom: 8,
  right: 12,
  width: 360,
  maxWidth: 'calc(100% - 24px)',
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
  boxSizing: 'border-box',
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
  boxSizing: 'border-box',
};

const labelStyle: CSSProperties = {
  fontSize: 12,
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

/** Inline spinner shown while a row's action is in flight. */
function Spinner({ size = 12 }: { size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        display: 'inline-block',
        borderRadius: '50%',
        border: '2px solid #3a4654',
        borderTopColor: '#7aa2e0',
        animation: 'nexus-spin 0.7s linear infinite',
      }}
    />
  );
}

const SPIN_KEYFRAMES = '@keyframes nexus-spin{to{transform:rotate(360deg)}}';

/**
 * Org logo with an initials fallback, matching the portal's `orgLogo` handling
 * (`IdentitySwitchModal.vue` / `Memberships.vue` render `orgLogo` in a rounded
 * circle and fall back to a placeholder). The desktop's dark theme uses a
 * monogram instead of the portal's briefcase icon.
 */
function OrgAvatar({
  name,
  logoUrl,
  size = 28,
  round = false,
}: {
  name: string | null;
  logoUrl: string | null;
  size?: number;
  round?: boolean;
}) {
  // A logo URL can still 404 (deleted file, wrong base). Fall back to initials
  // rather than showing a broken-image glyph.
  const [failed, setFailed] = useState(false);
  const widget: CSSProperties = {
    width: size,
    height: size,
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderRadius: round ? '50%' : 6,
    border: '1px solid #2a333d',
    background: '#243244',
    color: '#9aa7b5',
    fontSize: size <= 24 ? 10 : 11,
    fontWeight: 600,
    letterSpacing: 0.3,
  };
  if (logoUrl && !failed) {
    return (
      <span style={widget}>
        <img
          src={logoUrl}
          alt=""
          onError={() => setFailed(true)}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      </span>
    );
  }
  return (
    <span style={widget} aria-hidden>
      {orgInitials(name)}
    </span>
  );
}

/**
 * Identity + account switcher (Phase 9).
 *
 * Mirrors the app/portal: the private identity plus one per org membership, with
 * an org-membership switch flow (membership list -> login -> optional 2FA). The
 * multi-account switcher (different Nexus users) is temporary and only rendered
 * when the main process reports it enabled.
 *
 * Every action shows a pending state on the first click (`beginSwitch`) so the
 * UI reacts immediately instead of waiting on the IPC/region round-trip, and the
 * 2FA step is presented in a centered modal rather than an inline field at the
 * bottom of the panel.
 */
export function IdentitySwitcher({
  onClose,
  baseUrl = null,
}: {
  onClose: () => void;
  /** Region/gateway origin used to absolutise a relative `orgLogo` path. */
  baseUrl?: string | null;
}) {
  const [snapshot, setSnapshot] = useState<IdentitySnapshot | null>(null);
  const [memberships, setMemberships] = useState<MembershipRow[] | null>(null);
  const [loadingMemberships, setLoadingMemberships] = useState(false);
  const [ui, setUi] = useState<SwitchUiState>(initialSwitchUiState);
  const [challenge, setChallenge] = useState<MembershipLoginStart | null>(null);
  const [code, setCode] = useState('');
  const [pendingEmail, setPendingEmail] = useState('');
  const [challengeError, setChallengeError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  // Mirror the latest switch state so an async action can compute the next
  // `seq` synchronously without a stale closure.
  const uiRef = useRef(ui);
  uiRef.current = ui;

  const refresh = useCallback(async () => {
    setSnapshot(await bridge.identitySnapshot());
  }, []);

  const loadMemberships = useCallback(async () => {
    setLoadingMemberships(true);
    setUi((prev) => ({ ...prev, error: null }));
    try {
      setMemberships(await bridge.identityListMemberships());
    } catch (err) {
      setUi((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : 'failed to list memberships',
      }));
    } finally {
      setLoadingMemberships(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Load memberships eagerly so the list is present without a second click —
  // one less round-trip standing between the user and a switch.
  useEffect(() => {
    void loadMemberships();
  }, [loadMemberships]);

  /**
   * Run a switch with immediate pending feedback. `target` names the row so only
   * that row shows a spinner; the result is applied only if it is still the
   * latest request (see `applySwitchResult`).
   */
  const runSwitch = useCallback(
    async (target: { key: string; label: string }, action: () => Promise<unknown>) => {
      const started = beginSwitch(uiRef.current, target);
      uiRef.current = started.state;
      setUi(started.state);
      try {
        await action();
        const settled = applySwitchResult(uiRef.current, started.seq, { ok: true });
        uiRef.current = settled.state;
        setUi(settled.state);
      } catch (err) {
        const settled = applySwitchResult(uiRef.current, started.seq, {
          ok: false,
          message: err instanceof Error ? err.message : 'switch failed',
        });
        uiRef.current = settled.state;
        setUi(settled.state);
      }
    },
    [],
  );

  const cancelSwitchUi = useCallback(() => {
    setUi((prev) => {
      const next = cancelSwitch(prev);
      uiRef.current = next;
      return next;
    });
  }, []);

  const startOrgSwitch = useCallback(
    async (m: MembershipRow) => {
      const label = humanLabel(m.orgName, 'this organisation');
      if (!m.businessEmail) {
        setUi((prev) => ({ ...prev, error: 'this membership has no business email on file' }));
        return;
      }
      await runSwitch({ key: `membership:${m.membershipId}`, label }, async () => {
        const out = await bridge.identityStartMembership({
          membershipId: m.membershipId,
          businessEmail: m.businessEmail as string,
        });
        if (out.kind === 'two_factor_required') {
          // Present the 2FA step as a focused modal instead of an inline field.
          setChallengeError(null);
          setCode('');
          setPendingEmail(m.businessEmail as string);
          setChallenge(out);
          // The switch itself is not finished until verification; release the
          // row spinner so the modal owns the pending feedback.
          cancelSwitchUi();
        } else {
          setChallenge(null);
          await refresh();
        }
      });
    },
    [runSwitch, refresh, cancelSwitchUi],
  );

  const completeOrgSwitch = useCallback(async () => {
    if (!challenge?.loginToken) return;
    setVerifying(true);
    setChallengeError(null);
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
      setChallengeError(err instanceof Error ? err.message : 'verification failed');
    } finally {
      setVerifying(false);
    }
  }, [challenge, code, pendingEmail, refresh]);

  const dismissChallenge = useCallback(() => {
    if (verifying) return;
    setChallenge(null);
    setChallengeError(null);
    setCode('');
  }, [verifying]);

  // Org id -> display fields from the loaded memberships, so a business identity
  // row can show the org's logo/name even though the identity snapshot itself
  // only carries the orgId.
  const orgById = new Map<string, MembershipRow>();
  for (const m of memberships ?? []) {
    if (m.orgId) orgById.set(m.orgId, m);
  }

  return (
    <div style={panelStyle}>
      <style>{SPIN_KEYFRAMES}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
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

      {ui.error ? (
        <p style={{ margin: 0, color: '#f2a1a1', fontSize: 12, flexShrink: 0 }}>{ui.error}</p>
      ) : null}

      {ui.pendingKey ? (
        <p
          style={{ margin: 0, color: '#fbbf24', fontSize: 12, display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}
        >
          <Spinner />
          Switching to {ui.pendingLabel ?? 'identity'}…
        </p>
      ) : null}

      {!snapshot ? (
        <p style={{ color: '#6b7784', fontSize: 12 }}>Loading…</p>
      ) : (
        snapshot.accounts.map((account) => (
          <div key={account.userId} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong style={{ fontSize: 12 }}>
                {humanLabel(account.email, 'Signed-in account')}
              </strong>
              <span style={{ flex: 1 }} />
              {account.active ? (
                <span style={{ fontSize: 10, color: '#4ade80' }}>ACTIVE</span>
              ) : snapshot.accountSwitcherEnabled ? (
                <button
                  type="button"
                  style={{ ...btnStyle, display: 'inline-flex', gap: 6, alignItems: 'center' }}
                  disabled={ui.pendingKey === `account:${account.userId}`}
                  onClick={() =>
                    void runSwitch(
                      { key: `account:${account.userId}`, label: humanLabel(account.email, 'this account') },
                      async () => setSnapshot(await bridge.identitySwitchAccount(account.userId)),
                    )
                  }
                >
                  {ui.pendingKey === `account:${account.userId}` ? <Spinner /> : null}
                  Switch
                </button>
              ) : null}
            </div>
            {account.identities.map((identity) => {
              const org = identity.orgId ? orgById.get(identity.orgId) : undefined;
              const name =
                identity.kind === 'private'
                  ? 'Personal'
                  : humanLabel(org?.orgName ?? identity.label, 'Organisation');
              const logoUrl = resolveOrgLogoUrl(org?.orgLogo, baseUrl);
              const rowKey = `identity:${identity.key}`;
              const pending = ui.pendingKey === rowKey;
              return (
                <div key={identity.key} style={rowStyle}>
                  <OrgAvatar name={name} logoUrl={logoUrl} round={identity.kind === 'private'} />
                  <span style={labelStyle}>{name}</span>
                  <span style={{ fontSize: 10, color: '#6b7784' }}>{identity.role ?? ''}</span>
                  {identity.active ? (
                    <span style={{ fontSize: 10, color: '#4ade80' }}>●</span>
                  ) : (
                    <button
                      type="button"
                      style={{ ...btnStyle, display: 'inline-flex', gap: 6, alignItems: 'center' }}
                      disabled={pending}
                      onClick={() =>
                        void runSwitch({ key: rowKey, label: name }, async () =>
                          setSnapshot(await bridge.identitySwitch(identity.key)),
                        )
                      }
                    >
                      {pending ? <Spinner /> : null}
                      Use
                    </button>
                  )}
                  {identity.kind === 'business' ? (
                    <button
                      type="button"
                      style={{ ...btnStyle, display: 'inline-flex', gap: 6, alignItems: 'center' }}
                      disabled={ui.pendingKey === `logout:${identity.key}`}
                      onClick={() =>
                        void runSwitch(
                          { key: `logout:${identity.key}`, label: name },
                          async () => setSnapshot(await bridge.identityLogout(identity.key)),
                        )
                      }
                    >
                      {ui.pendingKey === `logout:${identity.key}` ? <Spinner /> : null}
                      Sign out
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))
      )}

      <div
        style={{
          borderTop: '1px solid #2a333d',
          paddingTop: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <strong style={{ fontSize: 12 }}>Org memberships</strong>
          <span style={{ flex: 1 }} />
          <button type="button" style={btnStyle} disabled={loadingMemberships} onClick={loadMemberships}>
            {loadingMemberships ? 'Loading…' : memberships ? 'Reload' : 'Load'}
          </button>
        </div>

        {memberships?.map((m) => {
          const name = humanLabel(m.orgName, 'Unnamed organisation');
          const logoUrl = resolveOrgLogoUrl(m.orgLogo, baseUrl);
          const rowKey = `membership:${m.membershipId}`;
          const pending = ui.pendingKey === rowKey;
          return (
            <div key={m.membershipId} style={rowStyle}>
              <OrgAvatar name={name} logoUrl={logoUrl} />
              <span style={labelStyle}>{name}</span>
              <span style={{ fontSize: 10, color: '#6b7784' }}>{m.role ?? ''}</span>
              <button
                type="button"
                style={{ ...btnStyle, display: 'inline-flex', gap: 6, alignItems: 'center' }}
                disabled={pending}
                onClick={() => void startOrgSwitch(m)}
              >
                {pending ? <Spinner /> : null}
                Log in
              </button>
            </div>
          );
        })}
        {memberships && memberships.length === 0 ? (
          <p style={{ margin: 0, color: '#6b7784', fontSize: 11 }}>No org memberships.</p>
        ) : null}
        {!memberships && loadingMemberships ? (
          <p style={{ margin: 0, color: '#6b7784', fontSize: 11 }}>Loading memberships…</p>
        ) : null}
      </div>

      {challenge ? (
        <Modal
          title={`Verify your identity${challenge.hint?.sentTo ? ` — code sent to ${challenge.hint.sentTo}` : ''}`}
          onClose={dismissChallenge}
          preferredWidth={400}
          preferredMaxHeight={460}
        >
          <strong style={{ fontSize: 15 }}>Two-factor verification</strong>
          <p style={{ margin: 0, color: '#8b95a1', fontSize: 12, lineHeight: 1.5 }}>
            Finishing the switch into <strong>{pendingEmail || 'the organisation'}</strong> needs a
            2FA code.
            {challenge.hint?.sentTo ? ` We sent it to ${challenge.hint.sentTo}.` : ''}
          </p>

          {challenge.biometricApprovalRequired ? (
            <p style={{ margin: 0, color: '#fbbf24', fontSize: 12 }}>
              This organisation also requires biometric approval.
            </p>
          ) : null}

          {challenge.complianceWarnings?.length ? (
            <ul style={{ margin: 0, paddingLeft: 18, color: '#fbbf24', fontSize: 11 }}>
              {challenge.complianceWarnings.map((w) => (
                <li key={w.code}>{w.message}</li>
              ))}
            </ul>
          ) : null}

          <input
            style={inputStyle}
            value={code}
            autoFocus
            placeholder="verification code"
            aria-label="verification code"
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && code && !verifying) void completeOrgSwitch();
            }}
          />

          {challengeError ? (
            <p style={{ margin: 0, color: '#f2a1a1', fontSize: 12 }}>{challengeError}</p>
          ) : null}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button
              type="button"
              data-modal-dismiss
              style={btnStyle}
              disabled={verifying}
              onClick={dismissChallenge}
            >
              Cancel
            </button>
            <button
              type="button"
              style={{
                ...btnStyle,
                border: '1px solid #3f6cb0',
                background: '#2f5c9e',
                color: '#fff',
                fontWeight: 600,
                display: 'inline-flex',
                gap: 6,
                alignItems: 'center',
              }}
              disabled={verifying || !code}
              onClick={() => void completeOrgSwitch()}
            >
              {verifying ? <Spinner /> : null}
              Verify
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
