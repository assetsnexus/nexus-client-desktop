// @vitest-environment jsdom
/**
 * Companion composer vs an **older preload** spec.
 *
 * The renderer and the Electron preload have different lifecycles, so after an
 * in-place update the renderer can run against a preload that predates the
 * companion channels. The original regression blanked the whole window with
 * "bridge.onCompanionActionRelay is not a function". This spec mounts the real
 * component with a legacy bridge that lacks *both* new methods and asserts it
 * degrades silently instead of throwing.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A preload from before the companion STT channels existed: it exposes neither
// `onCompanionSession` nor `companionAction`. `bridge-compat` helpers are real
// (not mocked), so this exercises the guard used in production.
vi.mock('../bridge.js', async () => {
  const compat = await vi.importActual<typeof import('../bridge-compat.js')>('../bridge-compat.js');
  return { bridge: { getVersion: async () => '0.0.0-legacy' }, ...compat };
});

import { CompanionComposer } from './CompanionComposer.js';

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

describe('CompanionComposer on a legacy preload', () => {
  it('mounts without throwing and renders nothing (no crash, no surface)', () => {
    expect(() => {
      act(() => {
        root.render(createElement(CompanionComposer, { contactId: 've-1' }));
      });
    }).not.toThrow();
    expect(container.querySelector('[data-nexus-surface="companion-composer"]')).toBeNull();
  });
});
