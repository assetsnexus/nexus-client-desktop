// @vitest-environment jsdom
/**
 * Scene context menu spec.
 *
 * Covers the wiring the pure reducer spec cannot: that the card actually renders
 * a row per action (so moving Avatars/Motion/Gestures out of the top bar did not
 * drop any), that a row click reports + closes the menu, that a disabled Reset
 * pose stays inert, and that Escape / outside-click dismiss it.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SceneContextMenu, SceneMenuAnchorContext } from './SceneContextMenu.js';
import type { CompanionMenuAction } from './companion-scene-menu.js';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(props: {
  debugEnabled?: { motionFeed?: boolean; gestureTest?: boolean; statusMotions?: boolean } | null;
  open?: { galleryOpen?: boolean; motionFeedOpen?: boolean; gestureTestOpen?: boolean; statusMotionsOpen?: boolean };
  poseResetAvailable?: boolean;
  onAction?: (a: CompanionMenuAction) => void;
  onClose?: () => void;
  anchor?: { x: number; y: number } | null;
}) {
  act(() => {
    root.render(
      createElement(
        SceneMenuAnchorContext.Provider,
        { value: props.anchor ?? { x: 20, y: 20 } },
        createElement(SceneContextMenu, {
          debugEnabled: props.debugEnabled ?? null,
          open: props.open ?? {},
          poseResetAvailable: props.poseResetAvailable ?? true,
          onAction: props.onAction ?? (() => undefined),
          onClose: props.onClose ?? (() => undefined),
        }),
      ),
    );
  });
}

function row(id: string): HTMLButtonElement | null {
  return container.querySelector(`[data-testid="companion-menu-${id}"]`);
}

describe('SceneContextMenu', () => {
  it('renders Avatars and Reset pose with debug off', () => {
    render({});
    expect(row('avatars')).not.toBeNull();
    expect(row('reset-pose')).not.toBeNull();
    // Developer rows are absent until enabled, so the menu matches the old bar.
    expect(row('motion-feed')).toBeNull();
    expect(row('gestures')).toBeNull();
    expect(row('status-motions')).toBeNull();
  });

  it('renders the moved top-bar controls when debug is on', () => {
    render({ debugEnabled: { motionFeed: true, gestureTest: true, statusMotions: true } });
    expect(row('motion-feed')?.textContent).toContain('Motion feed');
    expect(row('gestures')?.textContent).toContain('Gestures');
    expect(row('status-motions')?.textContent).toContain('Status motions');
  });

  it('reports the action and closes on a row click', () => {
    const onAction = vi.fn();
    const onClose = vi.fn();
    render({ onAction, onClose });
    act(() => row('reset-pose')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onAction).toHaveBeenCalledWith('reset-pose');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not fire a disabled Reset pose', () => {
    const onAction = vi.fn();
    const onClose = vi.fn();
    render({ poseResetAvailable: false, onAction, onClose });
    const el = row('reset-pose')!;
    expect(el.disabled).toBe(true);
    act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onAction).not.toHaveBeenCalled();
    // A click that cannot act must not dismiss either.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('marks an open panel with aria-pressed', () => {
    render({ debugEnabled: { gestureTest: true }, open: { gestureTestOpen: true } });
    expect(row('gestures')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render({ onClose });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a pointerdown outside the card', () => {
    const onClose = vi.fn();
    render({ onClose });
    act(() => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('is exposed as a labelled menu', () => {
    render({});
    const menu = container.querySelector('[data-testid="companion-scene-menu"]');
    expect(menu?.getAttribute('role')).toBe('menu');
    expect(menu?.getAttribute('aria-label')).toBe('Scene actions');
  });
});
