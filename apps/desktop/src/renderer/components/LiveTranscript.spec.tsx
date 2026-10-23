// @vitest-environment jsdom
/**
 * Live wake-word caption spec.
 *
 * The bottom bar must stream the words the on-device wake engine actually
 * transcribed and highlight any armed wake word inside them — that is what makes
 * a near-miss ("hey jenner" vs "hey jarvis") legible. These tests render the REAL
 * component against a stubbed wake-state hook and assert on observable DOM:
 *
 *  - the caption is hidden unless wake listening is enabled,
 *  - with no transcript yet it shows the idle "…" placeholder,
 *  - a transcript renders word-by-word, preserving original casing/punctuation,
 *  - words inside an armed phrase get the highlight style and set `data-has-wake`.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WakeListenState } from '../../shared/ipc.js';

const h = vi.hoisted(() => ({
  state: null as unknown,
}));

vi.mock('../wake/director-host.js', () => ({
  useWakeState: () => h.state,
}));

import { LiveTranscript } from './LiveTranscript.js';

function baseState(over: Partial<WakeListenState> = {}): WakeListenState {
  return {
    enabled: true,
    listening: true,
    activePhrases: [],
    level: 0,
    transcript: null,
    lastDetection: null,
    message: null,
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.state = baseState();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(state: WakeListenState): void {
  h.state = state;
  act(() => root.render(createElement(LiveTranscript)));
}

function surface(): HTMLElement | null {
  return container.querySelector('[data-nexus-surface="live-transcript"]');
}

describe('LiveTranscript', () => {
  it('renders nothing while wake listening is disabled', () => {
    render(baseState({ enabled: false, transcript: 'hello' }));
    expect(surface()).toBeNull();
  });

  it('shows an idle placeholder before the first transcript', () => {
    render(baseState({ transcript: null }));
    expect(surface()?.textContent).toContain('heard');
    expect(surface()?.textContent).toContain('…');
  });

  it('streams the transcript word-by-word, keeping casing and punctuation', () => {
    render(baseState({ transcript: 'Hey Bob, do this', activePhrases: ['hey bob'] }));
    const words = Array.from(surface()!.querySelectorAll('span'))
      .map((s) => s.textContent)
      .filter((t) => t && t !== 'heard');
    expect(words).toEqual(['Hey', 'Bob,', 'do', 'this']);
  });

  it('highlights every word of an armed wake phrase and flags the surface', () => {
    render(baseState({ transcript: 'Hey Bob, do this', activePhrases: ['hey bob'] }));
    const highlighted = Array.from(surface()!.querySelectorAll('span')).filter(
      (s) => (s as HTMLElement).style.background,
    );
    expect(highlighted.map((s) => s.textContent)).toEqual(['Hey', 'Bob,']);
    expect(surface()?.getAttribute('data-has-wake')).toBe('true');
  });

  it('does not highlight when the transcript has no armed phrase', () => {
    render(baseState({ transcript: 'good morning everyone', activePhrases: ['hey jarvis'] }));
    const highlighted = Array.from(surface()!.querySelectorAll('span')).filter(
      (s) => (s as HTMLElement).style.background,
    );
    expect(highlighted).toEqual([]);
    expect(surface()?.getAttribute('data-has-wake')).toBe('false');
  });

  it('never highlights a substring buried in a longer word', () => {
    render(baseState({ transcript: 'a bobcat appeared', activePhrases: ['bob'] }));
    expect(surface()?.getAttribute('data-has-wake')).toBe('false');
  });
});
