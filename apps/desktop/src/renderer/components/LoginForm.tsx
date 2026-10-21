import { useState, type CSSProperties, type FormEvent } from 'react';
import { bridge, type AuthState } from '../bridge.js';

const wrap: CSSProperties = {
  height: '100%',
  display: 'grid',
  placeItems: 'center',
  padding: 24,
};

const card: CSSProperties = {
  width: 360,
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  padding: 24,
  borderRadius: 14,
  background: '#151b22',
  border: '1px solid #2a333d',
};

const field: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  fontSize: 12,
  color: '#9aa7b5',
};

const input: CSSProperties = {
  padding: '9px 11px',
  borderRadius: 8,
  border: '1px solid #3a4654',
  background: '#0f1419',
  color: '#e8eef4',
  fontSize: 14,
};

const button: CSSProperties = {
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid #3f6cb0',
  background: '#2f5c9e',
  color: '#fff',
  cursor: 'pointer',
  fontSize: 14,
  fontWeight: 600,
};

const errorText: CSSProperties = { color: '#f2a1a1', fontSize: 13, margin: 0 };
export function LoginForm({
  auth,
  onAuthChange,
}: {
  auth: AuthState;
  onAuthChange: () => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const twoFactor = auth.status === 'two_factor_required';

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (twoFactor) {
        await bridge.submitTwoFactor({ authRequestId: auth.authRequestId, code });
      } else {
        await bridge.login({ email, password });
      }
      onAuthChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={wrap}>
      <form style={card} onSubmit={onSubmit}>
        <h1 style={{ margin: 0, fontSize: 18 }}>Sign in to Nexus</h1>

        {twoFactor ? (
          <p style={{ margin: 0, color: '#9aa7b5', fontSize: 13 }}>
            Two-factor verification is required
            {auth.factors.length ? ` (${auth.factors.join(', ')})` : ''}.
          </p>
        ) : (
          <>
            <label style={field}>
              <span>Email</span>
              <input
                style={input}
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            <label style={field}>
              <span>Password</span>
              <input
                style={input}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
          </>
        )}

        {twoFactor ? (
          <label style={field}>
            <span>Verification code</span>
            <input
              style={input}
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
          </label>
        ) : null}

        {error ? <p style={errorText}>{error}</p> : null}

        <button style={button} type="submit" disabled={busy}>
          {busy ? 'Please wait…' : twoFactor ? 'Verify' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
