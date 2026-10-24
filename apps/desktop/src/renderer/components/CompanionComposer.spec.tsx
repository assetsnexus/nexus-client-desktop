// @vitest-environment jsdom
/**
 * Companion STT composer spec.
 *
 * The companion is the wake target in dictation mode: it renders the live turn
 * mirrored by the session-owning window and relays each control back. What matters:
 *  - the live preview streams into an editable field;
 *  - Send / Cancel / Send-as-voice relay the right action;
 *  - a payload for another contact is ignored;
 *  - a user edit freezes the field and is relayed as an `edit` action.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanionSessionView } from '../../shared/companion.js';

const sessionListeners: Array<(view: CompanionSessionView) => void> = [];
const companionAction = vi.fn(async () => true);

vi.mock('../bridge.js', () => ({
  bridge: {
    onCompanionSession: (listener: (view: CompanionSessionView) => void) => {
      sessionListeners.push(listener);
      return () => {
        const i = sessionListeners.indexOf(listener);
        if (i >= 0) sessionListeners.splice(i, 1);
      };
    },
    companionAction: (...args: unknown[]) => companionAction(...(args as [])),
  },
}));

import { CompanionComposer } from './CompanionComposer.js';

function view(over: Partial<CompanionSessionView> = {}): CompanionSessionView {
  return {
    contactId: 've-1',
    status: 'listening',
    preview: '',
    buffer: '',
    cloudTranscription: false,
    batchDurationMs: 0,
    batchAvailable: false,
    sendingAudio: false,
    message: null,
    engineLabel: null,
    agentName: 'Aria',
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  companionAction.mockClear();
  sessionListeners.length = 0;
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render() {
  act(() => {
    root.render(createElement(CompanionComposer, { contactId: 've-1' }));
  });
}

function emit(next: CompanionSessionView) {
  act(() => {
    for (const listener of [...sessionListeners]) listener(next);
  });
}

function field(): HTMLTextAreaElement {
  return container.querySelector('[data-nexus-surface="companion-field"]') as HTMLTextAreaElement;
}

function button(label: string): HTMLButtonElement {
  return [...container.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').startsWith(label),
  ) as HTMLButtonElement;
}

describe('CompanionComposer', () => {
  it('renders nothing until a session view arrives', () => {
    render();
    expect(container.querySelector('[data-nexus-surface="companion-composer"]')).toBeNull();
  });

  it('streams the live preview into an editable field', () => {
    render();
    emit(view({ preview: 'open the door', buffer: 'open the', status: 'transcribing' }));
    expect(field().tagName).toBe('TEXTAREA');
    expect(field().value).toBe('open the door');
  });

  it('relays Send / Cancel / Send-as-voice', () => {
    render();
    emit(view({ buffer: 'send me', preview: 'send me', batchAvailable: true, batchDurationMs: 2300 }));
    act(() => button('Send').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(companionAction).toHaveBeenCalledWith({ contactId: 've-1', action: 'submit' });
    act(() => button('Cancel').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(companionAction).toHaveBeenCalledWith({ contactId: 've-1', action: 'cancel' });
    act(() => button('Send voice').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(companionAction).toHaveBeenCalledWith({ contactId: 've-1', action: 'sendAudio' });
  });

  it('ignores a view addressed to another contact', () => {
    render();
    emit(view({ contactId: 'other', preview: 'nope' }));
    expect(container.querySelector('[data-nexus-surface="companion-composer"]')).toBeNull();
  });

  it('freezes a user edit and relays it as an edit action', () => {
    render();
    emit(view({ buffer: 'spoken words', preview: 'spoken words' }));
    const box = field();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(box, 'edited words');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(companionAction).toHaveBeenCalledWith({
      contactId: 've-1',
      action: 'edit',
      text: 'edited words',
    });
    expect(field().value).toBe('edited words');
  });

  it('submits on Enter when there is text', () => {
    render();
    emit(view({ buffer: 'send me', preview: 'send me' }));
    act(() => {
      field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(companionAction).toHaveBeenCalledWith({ contactId: 've-1', action: 'submit' });
  });

  it('hides Send-as-voice when no audio batch exists', () => {
    render();
    emit(view({ buffer: 'text only', preview: 'text only' }));
    expect(button('Send voice')).toBeUndefined();
  });
});
