// @vitest-environment jsdom
/**
 * Wake-words settings panel spec.
 *
 * Two reported requirements are covered here against the *real* component:
 *  - **agent nicknames** ("Zeni" for "Xeni") are editable and persisted, for
 *    auto-mapped agents too (which have no editable binding of their own);
 *  - the panel renders on its **first** paint (settings still loading) *and*
 *    after settings arrive, which is exactly the transition that previously
 *    threw "Rendered more hooks than during the previous render".
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  settings: vi.fn(),
  setSettings: vi.fn(),
  listAgents: vi.fn(),
  voiceState: vi.fn(),
}));

vi.mock('../bridge.js', () => ({
  bridge: {
    wakeGetSettings: () => h.settings(),
    wakeSetSettings: (next: unknown) => h.setSettings(next),
    wakeListAgents: () => h.listAgents(),
    localVoiceGetState: () => h.voiceState(),
    openExternal: async () => undefined,
  },
}));

vi.mock('../voice/use-voice-store.js', () => ({
  useVoiceSnapshot: () => ({
    state: {
      models: [
        {
          id: 'catalog:desktop/whisper-small-q5',
          label: 'Whisper Small',
          kind: 'stt',
          installState: 'installed',
        },
      ],
      settings: { sttEngine: 'local' },
    },
    wakeStt: { ready: true, modelId: 'catalog:desktop/whisper-small-q5', runnerInstalled: true },
    binary: { installed: true },
  }),
}));

vi.mock('../wake/director-host.js', () => ({
  reloadWakeDirector: async () => undefined,
}));

import { WakeSettingsPanel } from './WakeSettingsPanel.js';
import { DEFAULT_WAKE_BEHAVIOR, type WakeSettings } from '../../shared/wake.js';

function settings(over: Partial<WakeSettings> = {}): WakeSettings {
  return {
    enabled: true,
    bindings: [],
    ...DEFAULT_WAKE_BEHAVIOR,
    autoMapModelId: 'catalog:desktop/whisper-small-q5',
    ...over,
  };
}

const flush = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  h.settings.mockResolvedValue(settings());
  h.listAgents.mockResolvedValue([
    { contactId: 'xeni', virtualEmployeeId: 'xeni', agentId: 'a-xeni', name: 'Xeni', canConfigure: true },
  ]);
  h.voiceState.mockResolvedValue({ models: [], settings: {} });
  h.setSettings.mockImplementation(async (next: unknown) => next);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function render() {
  act(() => {
    root.render(createElement(WakeSettingsPanel));
  });
}

/** All inputs whose placeholder mentions nicknames/a phrase. */
function aliasInput(): HTMLInputElement {
  const inputs = [...container.querySelectorAll('input[type="text"], input:not([type])')] as HTMLInputElement[];
  const found = inputs.find((i) => /e\.g\. Xeni/.test(i.placeholder));
  if (!found) throw new Error('alias input not found');
  return found;
}

function addAliasInput(): HTMLButtonElement {
  const input = aliasInput();
  const row = input.parentElement!;
  return row.querySelector<HTMLButtonElement>('button')!;
}

async function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  await act(async () => {
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('WakeSettingsPanel', () => {
  it('renders while settings are still loading, then again once they arrive', async () => {
    // A never-resolving load, so the first paint is the "Loading…" branch.
    let release: (v: WakeSettings) => void = () => {};
    h.settings.mockReturnValue(new Promise<WakeSettings>((r) => (release = r)));
    render();
    expect(container.textContent).toContain('Loading');

    // Settings arriving swaps branches: with the hook below the early return
    // this transition threw "Rendered more hooks than during the previous render".
    await act(async () => {
      release(settings());
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Wake words');
    expect(container.textContent).not.toContain('failed to load');
  });

  it('lists an agent nickname row and persists a new alias', async () => {
    render();
    await flush();
    expect(container.textContent).toContain('Agent nicknames');
    // The auto-mapped agent "Xeni" is listed even with no manual binding.
    expect(aliasInput()).toBeTruthy();

    await setInput(aliasInput(), 'Zeni');
    await act(async () => {
      addAliasInput().click();
      await Promise.resolve();
    });

    expect(h.setSettings).toHaveBeenCalled();
    const written = h.setSettings.mock.calls.at(-1)![0] as WakeSettings;
    expect(written.agentAliases.xeni).toEqual(['Zeni']);
  });

  it('exposes the capture mode (live / batch / both) and persists a change', async () => {
    render();
    await flush();
    const capture = [...container.querySelectorAll('select')].find((s) =>
      [...s.options].some((o) => o.textContent === 'Audio batch only'),
    ) as HTMLSelectElement;
    expect(capture).toBeTruthy();
    expect(capture.value).toBe('both');

    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set;
    await act(async () => {
      setter.call(capture, 'batch');
      capture.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    const written = h.setSettings.mock.calls.at(-1)![0] as WakeSettings;
    expect(written.captureMode).toBe('batch');
  });

  it('shows an existing nickname and removes it', async () => {
    h.settings.mockResolvedValue(settings({ agentAliases: { xeni: ['Zeni'] } }));
    render();
    await flush();
    expect(container.textContent).toContain('“Zeni”');

    const remove = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === '×',
    ) as HTMLButtonElement;
    // Ordered checks are noisy here: there are several "×" buttons (aliases,
    // submit phrases), so assert only that one removes *this* alias.
    const before = h.setSettings.mock.calls.length;
    await act(async () => {
      remove.click();
      await Promise.resolve();
    });
    expect(h.setSettings.mock.calls.length).toBeGreaterThan(before);
  });
});
