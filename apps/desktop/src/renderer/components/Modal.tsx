/**
 * Centered, viewport-clamped modal dialog.
 *
 * Extracted from the pattern already used by `LogoutDialog` / `CertTrustPrompt`
 * (fixed backdrop + centered card) with two fixes those hand-rolled versions
 * lack:
 *
 *  - the card is **clamped to the viewport** on both axes via `fitDialog`, so it
 *    can never extend off-screen in a small window (the shell hides body
 *    overflow, so anything past the edge would be unreachable);
 *  - focus **moves into the dialog** on open and the dialog is `aria-modal`, so
 *    a 2FA prompt is announced and reachable by keyboard instead of being an
 *    easy-to-miss inline field at the bottom of a long panel.
 *
 * Not a new UI framework — it reuses the exact inline-style conventions of the
 * existing dialogs.
 */
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { fitDialog } from '../../shared/dialog-layout.js';

const backdrop: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1000,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(6, 9, 12, 0.72)',
};

const card: CSSProperties = {
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  padding: 22,
  borderRadius: 14,
  background: '#151b22',
  border: '1px solid #2a333d',
  color: '#e8eef4',
  fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
  boxShadow: '0 18px 48px rgba(0,0,0,0.5)',
};

export function Modal({
  title,
  onClose,
  children,
  preferredWidth = 420,
  preferredMaxHeight = 560,
  edge,
  labelledBy,
}: {
  /** Visible dialog title; also the default accessible label. */
  title: ReactNode;
  /** Called on backdrop click or Escape (unless `dismissable` is false). */
  onClose: () => void;
  children: ReactNode;
  preferredWidth?: number;
  preferredMaxHeight?: number;
  edge?: number;
  /** Optional id of a node that labels the dialog (overrides `title` text). */
  labelledBy?: string;
}) {
  const cardRef = useRef<HTMLDivElement>(null);

  const viewport =
    typeof window !== 'undefined'
      ? { width: window.innerWidth, height: window.innerHeight }
      : { width: 0, height: 0 };
  const fit = fitDialog({
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    preferredWidth,
    preferredMaxHeight,
    edge,
  });

  // Move focus into the dialog on open so it is keyboard-reachable and the 2FA
  // field is not something the user has to hunt for. `preventScroll` avoids the
  // panel jumping behind it.
  useEffect(() => {
    const node = cardRef.current?.querySelector<HTMLElement>(
      'input, textarea, select, button:not([data-modal-dismiss])',
    );
    node?.focus({ preventScroll: true });
  }, []);

  // Escape closes. Handled on the card so a nested field's own Escape handlers
  // win first; the backdrop click also closes.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      style={backdrop}
      onMouseDown={(event) => {
        // Only a click on the backdrop itself (not the card) dismisses.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy ? undefined : typeof title === 'string' ? title : undefined}
        aria-labelledby={labelledBy}
        style={{
          ...card,
          width: fit.width,
          maxWidth: '100%',
          maxHeight: fit.maxHeight,
          overflowY: fit.needsScroll ? 'auto' : 'visible',
        }}
      >
        {children}
      </div>
    </div>
  );
}
