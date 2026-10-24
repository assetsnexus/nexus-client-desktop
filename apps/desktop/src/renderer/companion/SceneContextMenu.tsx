/**
 * Right-click scene menu for the immersive companion window.
 *
 * The 3D scene is the natural home for avatar controls, so right-clicking it
 * opens this menu instead of the browser's default one. It carries the controls
 * the top bar used to hold (Avatars / Motion / Gestures / Status) plus the
 * "Reset pose" escape hatch, which frees the header for the agent's name.
 *
 * Positioning is measured on open (the card mounts hidden, is measured, then
 * placed) so the menu never overflows the viewport. All geometry lives in the
 * pure {@link ./companion-scene-menu.js} helpers.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  buildCompanionMenuItems,
  clampMenuPosition,
  CLOSED_COMPANION_MENU,
  groupCompanionMenuItems,
  type CompanionMenuAction,
  type CompanionMenuDebugSettings,
  type CompanionMenuOpenState,
} from './companion-scene-menu.js';

/** Cursor anchor an open menu positions itself from. */
export type SceneMenuAnchor = { x: number; y: number } | null;

/**
 * Anchor value for the currently open menu. The parent view owns open/close, so
 * it provides the anchor here and the card stays a leaf that only positions
 * itself — no prop drilling of window geometry through the scene subtree.
 */
export const SceneMenuAnchorContext = createContext<SceneMenuAnchor>(null);

export type SceneContextMenuProps = {
  debugEnabled: CompanionMenuDebugSettings | null;
  open: CompanionMenuOpenState;
  /** False when no 3D stage is bound, so Reset pose is shown disabled. */
  poseResetAvailable: boolean;
  onAction: (action: CompanionMenuAction) => void;
  onClose: () => void;
};

const card: CSSProperties = {
  position: 'fixed',
  zIndex: 60,
  minWidth: 208,
  padding: 6,
  borderRadius: 10,
  border: '1px solid #2a333d',
  background: 'rgba(15,20,26,0.98)',
  boxShadow: '0 12px 34px rgba(0,0,0,0.5)',
  color: '#e8eef4',
  fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
};

const sectionTitle: CSSProperties = {
  padding: '6px 8px 3px',
  fontSize: 10,
  letterSpacing: 0.4,
  textTransform: 'uppercase',
  color: '#77828f',
};

const rowBase: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '6px 8px',
  borderRadius: 7,
  border: '1px solid transparent',
  background: 'transparent',
  color: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
  fontSize: 12,
};

const rowActive: CSSProperties = {
  ...rowBase,
  border: '1px solid #3f6cb0',
  background: '#22314a',
};

const rowDisabled: CSSProperties = {
  ...rowBase,
  color: '#5f6b78',
  cursor: 'default',
};

const footerHint: CSSProperties = {
  padding: '6px 8px 2px',
  fontSize: 10,
  color: '#8b97a4',
};

/**
 * The menu card. Rendered only while open (the parent owns open/close so a click
 * anywhere else can dismiss it). Measures itself once mounted to clamp into view.
 */
export function SceneContextMenu({
  debugEnabled,
  open,
  poseResetAvailable,
  onAction,
  onClose,
}: SceneContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  // The parent captures the cursor anchor before mounting; read it from context.
  const anchor = useContext(SceneMenuAnchorContext);
  const groups = groupCompanionMenuItems(
    buildCompanionMenuItems({ debugEnabled, open, poseResetAvailable }),
  );

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const rect = el.getBoundingClientRect();
    setPos(
      clampMenuPosition(
        anchor.x,
        anchor.y,
        { width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [anchor]);

  // Dismiss on Escape, scroll, resize/blur, or a click outside the card.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onDismiss = () => onClose();
    window.addEventListener('keydown', onKey);
    // `capture` so the click that opens another surface closes this menu first.
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', onDismiss);
    window.addEventListener('blur', onDismiss);
    document.addEventListener('scroll', onDismiss, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', onDismiss);
      window.removeEventListener('blur', onDismiss);
      document.removeEventListener('scroll', onDismiss, true);
    };
  }, [onClose]);

  const pick = useCallback(
    (action: CompanionMenuAction, disabled?: boolean) => {
      if (disabled) return;
      onAction(action);
      onClose();
    },
    [onAction, onClose],
  );

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Scene actions"
      data-testid="companion-scene-menu"
      style={{
        ...card,
        // Hidden for the first frame until measured + clamped.
        visibility: pos ? 'visible' : 'hidden',
        left: pos?.x ?? -9999,
        top: pos?.y ?? -9999,
      }}
    >
      {groups.map((group) => (
        <div key={group.section} role="group" aria-label={group.section}>
          <div style={sectionTitle}>{group.section}</div>
          {group.items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              data-testid={`companion-menu-${item.id}`}
              disabled={item.disabled}
              aria-pressed={item.active === undefined ? undefined : item.active}
              style={item.disabled ? rowDisabled : item.active ? rowActive : rowBase}
              onClick={() => pick(item.id, item.disabled)}
              title={item.hint}
            >
              <span style={{ flex: 1 }}>{item.label}</span>
              {item.active ? <span aria-hidden>✓</span> : null}
            </button>
          ))}
        </div>
      ))}
      <div style={footerHint}>Right-click the scene any time.</div>
    </div>
  );
}

/** Re-exported so a consumer can seed the reducer without a second import. */
export const closedMenu = CLOSED_COMPANION_MENU;
