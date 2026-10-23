/**
 * Inactivity PIN lock screen (Deliverable 3).
 *
 * A full-screen overlay raised by the shell when the main process reports the UI
 * is locked. It is a **UI gate only**: it hides whatever is behind it and asks
 * for the PIN; main-process commands, region calls and 2FA flows are unaffected.
 *
 * A user is never permanently locked out: the "Switch user" and "Sign out"
 * actions here run the normal logout flow, which clears the PIN.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { bridge } from '../bridge.js';

const overlay: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1000,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(9,12,16,0.94)',
  backdropFilter: 'blur(6px)',
};

const card: CSSProperties = {
  width: 320,
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  padding: 28,
  borderRadius: 16,
  background: '#151b22',
  border: '1px solid #2a333d',
  color: '#e8eef4',
  textAlign: 'center',
};

export function AppLockGate({
  onUnlocked,
  onRecover,
}: {
  /** Called once the PIN is accepted (the shell can refresh state). */
  onUnlocked: () => void;
  /** Called when the user chooses the recovery path (sign out / switch user). */
  onRecover: () => void;
}) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = useCallback(async () => {
    if (!pin) return;
    setBusy(true);
    setError(null);
    try {
      const ok = await bridge.appLockUnlock(pin);
      if (ok) {
        setPin('');
        onUnlocked();
      } else {
        setError('Incorrect PIN. Try again.');
        setPin('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not unlock');
    } finally {
      setBusy(false);
    }
  }, [pin, onUnlocked]);

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label="App locked">
      <div style={card}>
        <strong style={{ fontSize: 16 }}>App locked</strong>
        <p style={{ margin: 0, color: '#8b95a1', fontSize: 12 }}>
          Enter your PIN to continue. You can also switch user or sign out below if you have
          forgotten it — that clears the PIN.
        </p>
        <input
          ref={inputRef}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          placeholder="PIN"
          disabled={busy}
          aria-label="PIN"
          onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, ''))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          style={{
            padding: '12px 14px',
            borderRadius: 10,
            border: '1px solid #3a4654',
            background: '#0f1419',
            color: '#e8eef4',
            fontSize: 20,
            letterSpacing: 6,
            textAlign: 'center',
          }}
        />
        {error ? <span style={{ color: '#f2a1a1', fontSize: 12 }}>{error}</span> : null}
        <button
          type="button"
          disabled={busy || pin.length === 0}
          onClick={() => void submit()}
          style={{
            padding: '10px 14px',
            borderRadius: 10,
            border: '1px solid #3f6cb0',
            background: '#2f5c9e',
            color: '#fff',
            cursor: pin.length ? 'pointer' : 'not-allowed',
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          Unlock
        </button>
        <button
          type="button"
          onClick={onRecover}
          style={{
            background: 'none',
            border: 'none',
            color: '#8b95a1',
            cursor: 'pointer',
            fontSize: 12,
            textDecoration: 'underline',
          }}
        >
          Forgot the PIN? Sign out / switch user
        </button>
      </div>
    </div>
  );
}
