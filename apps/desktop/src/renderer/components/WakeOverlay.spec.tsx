// @vitest-environment jsdom
/**
 * Wake listening widget spec.
 *
 * The widget is where a wake's dictation lands. Three behaviours matter and were
 * the reported bugs:
 *  - the live STT streams into an *editable field* (not a read-only caption), so
 *    the user can submit what they see mid-utterance;
 *  - Send is enabled as soon as the field has text (including a still-streaming
 *    partial), and edits are reported back so Submit sends the visible text;
 *  - the "open in companion + voice mode" link is present, reflects the setting,
 *    and can toggle it or open the current agent now.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionState } from '../wake/session.js';

vi.mock('../wake/director-host.js', () => ({
  useWakeState: () => ({
    enabled: true,
    listening: true,
    activePhrases: ['Xeni'],
    level: 0.4,
    transcript: null,
    lastDetection: null,
    message: null,
  }),
}));

import { WakeOverlay } from './WakeOverlay.js';

function session(over: Partial<SessionState> = {}): SessionState {
  const buffer = over.buffer ?? '';
  const partial = over.partial ?? '';
  // Mirror the real session: `preview` is committed buffer + live partial.
  const preview = [buffer, partial].filter(Boolean).join(' ');
  return {
    status: 'listening',
    buffer,
    partial,
    target: { agentId: 'a1', agentName: 'Xeni', phrase: 'Xeni' },
    message: null,
    cloudTranscription: false,
    ...over,
    preview,
  };
}

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

function render(props: Partial<Parameters<typeof WakeOverlay>[0]> = {}) {
  act(() => {
    root.render(
      createElement(WakeOverlay, {
        session: session(),
        mode: 'widget',
        agent: { name: 'Xeni', avatarUrl: null },
        onSubmit: () => {},
        onCancel: () => {},
        ...props,
      }),
    );
  });
}

function field(): HTMLTextAreaElement {
  return container.querySelector('[data-nexus-surface="wake-field"]') as HTMLTextAreaElement;
}

function sendButton(): HTMLButtonElement {
  return [...container.querySelectorAll('button')].find((b) => b.textContent === 'Send') as HTMLButtonElement;
}

describe('WakeOverlay widget', () => {
  it('streams the live partial into an editable field', () => {
    render({ session: session({ buffer: 'open the', partial: 'door' }) });
    expect(field().tagName).toBe('TEXTAREA');
    expect(field().value).toBe('open the door');
  });

  it('enables Send from a still-streaming partial (buffer is empty)', () => {
    render({ session: session({ buffer: '', partial: 'hello there' }) });
    expect(sendButton().disabled).toBe(false);
  });

  it('disables Send when there is nothing to send', () => {
    render({ session: session({ buffer: '', partial: '' }) });
    expect(sendButton().disabled).toBe(true);
  });

  it('reports user edits back to the session so Submit sends what is visible', () => {
    const onEdit = vi.fn();
    render({ session: session({ buffer: 'spoken words' }), onEdit });
    const box = field();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(box, 'edited words');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onEdit).toHaveBeenCalledWith('edited words');
    expect(field().value).toBe('edited words');
  });

  it('submits on Enter when there is text', () => {
    const onSubmit = vi.fn();
    render({ session: session({ buffer: 'send me' }), onSubmit });
    act(() => {
      field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('drops a frozen edit when a new activation starts (token bump)', () => {
    render({ session: session({ buffer: 'first wake' }), sessionToken: 1 });
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(field(), 'my edit');
      field().dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(field().value).toBe('my edit');
    // A second wake re-renders with a new token and a fresh transcript.
    render({ session: session({ buffer: 'second wake' }), sessionToken: 2 });
    expect(field().value).toBe('second wake');
  });

  it('shows and toggles the companion + voice link', () => {
    const onToggleCompanion = vi.fn();
    render({ companionOnWake: false, onToggleCompanion });
    const box = container.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    expect(box.checked).toBe(false);
    act(() => box.click());
    expect(onToggleCompanion).toHaveBeenCalledWith(true);
  });

  it('offers an "open companion + voice now" action for the current agent', () => {
    const onOpenCompanion = vi.fn();
    render({ onOpenCompanion });
    const open = [...container.querySelectorAll('button')].find((b) =>
      /Open companion \+ voice now/.test(b.textContent ?? ''),
    ) as HTMLButtonElement;
    expect(open).toBeTruthy();
    act(() => open.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onOpenCompanion).toHaveBeenCalledTimes(1);
  });
});
