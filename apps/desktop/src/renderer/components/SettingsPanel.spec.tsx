// @vitest-environment jsdom
/**
 * Settings shell spec.
 *
 * The C1 restructure turned `SettingsPanel` into a left-nav shell that decides
 * which section renders. That decision — plus the responsive `<select>` fallback
 * and the per-section error isolation — is the shell's own logic, so it is tested
 * here against the real component with the *section* modules stubbed: each stub
 * records the id it was rendered with, which is how the assertions observe which
 * pane is mounted (only the active section should ever render).
 */

import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// One shared marker per render; the stubs below write into it. `vi.hoisted` so
// the mock factories (hoisted above imports) can close over the same object.
const h = vi.hoisted(() => ({
  current: '' as string,
  rendered: [] as string[],
  ui: { locale: 'en' as string | null },
  setUiSettings: vi.fn(async (_patch: unknown) => ({ locale: 'en' })),
}));

vi.mock('../bridge.js', () => ({
  bridge: {
    getUiSettings: async () => ({ locale: h.ui.locale }),
    setUiSettings: (patch: unknown) => h.setUiSettings(patch as never),
  },
}));

// `vi.mock` is hoisted above imports, so each factory must be self-contained and
// may only close over the hoisted `h` (a top-level helper like `stub()` is not
// initialised yet when the factory runs).
vi.mock('./settings/GeneralSection.js', () => ({
  GeneralSection: () => {
    h.current = 'GeneralSection';
    h.rendered.push('GeneralSection');
    return null;
  },
}));
vi.mock('./settings/NotificationsSection.js', () => ({
  NotificationsSection: () => {
    h.current = 'NotificationsSection';
    h.rendered.push('NotificationsSection');
    return null;
  },
}));
vi.mock('./settings/CompanionSection.js', () => ({
  CompanionSection: () => {
    h.current = 'CompanionSection';
    h.rendered.push('CompanionSection');
    return null;
  },
}));
vi.mock('./settings/AgentsSection.js', () => ({
  AgentsSection: () => {
    h.current = 'AgentsSection';
    h.rendered.push('AgentsSection');
    return null;
  },
}));
vi.mock('./settings/LocalAiSection.js', () => ({
  LocalAiSection: () => {
    h.current = 'LocalAiSection';
    h.rendered.push('LocalAiSection');
    return null;
  },
}));
vi.mock('./settings/IntegrationsSection.js', () => ({
  IntegrationsSection: () => {
    h.current = 'IntegrationsSection';
    h.rendered.push('IntegrationsSection');
    return null;
  },
}));
vi.mock('./settings/SecuritySection.js', () => ({
  SecuritySection: () => {
    h.current = 'SecuritySection';
    h.rendered.push('SecuritySection');
    return null;
  },
}));
vi.mock('./settings/ConnectionSection.js', () => ({
  ConnectionSection: () => {
    h.current = 'ConnectionSection';
    h.rendered.push('ConnectionSection');
    return null;
  },
}));
vi.mock('./settings/DeveloperSection.js', () => ({
  DeveloperSection: () => {
    h.current = 'DeveloperSection';
    h.rendered.push('DeveloperSection');
    return null;
  },
}));
vi.mock('./WakeSettingsPanel.js', () => ({
  WakeSettingsPanel: () => {
    h.current = 'WakeSettingsPanel';
    h.rendered.push('WakeSettingsPanel');
    return null;
  },
}));

import { SettingsPanel } from './SettingsPanel.js';
import { I18nProvider } from '../i18n/index.js';
import { DEFAULT_SETTINGS_SECTION, SETTINGS_NAV } from './settings/sections.js';
import { EN_MESSAGES } from '../i18n/locales.js';

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

const connection = {
  regionUrl: 'https://127.0.0.1:3005',
  gatewayUrl: 'https://127.0.0.1:3005',
  portalUrl: 'https://127.0.0.1:3002',
} as unknown as Parameters<typeof SettingsPanel>[0]['connection'];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.current = '';
  h.rendered.length = 0;
  h.ui.locale = 'en';
  h.setUiSettings.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function render() {
  act(() => {
    root.render(
      createElement(
        I18nProvider,
        null,
        createElement(SettingsPanel, {
          connection,
          onConnectionChange: () => undefined,
          onClose: () => undefined,
        }),
      ),
    );
  });
  await flush();
}

/** A rail button whose text contains the given label. */
function navButton(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(
    (b) => b.querySelector('nav') === null && b.textContent?.includes(label),
  );
}

describe('SettingsPanel shell', () => {
  it('renders a nav entry and a label for every settings section', async () => {
    await render();
    for (const entry of SETTINGS_NAV) {
      const label = EN_MESSAGES[entry.labelKey];
      expect(navButton(label), `missing nav entry for ${entry.id}`).toBeTruthy();
    }
    // One rail button per section, plus the header Done button.
    expect(container.querySelectorAll('button').length).toBe(SETTINGS_NAV.length + 1);
  });

  it('opens on the default section and switches the mounted pane on nav click', async () => {
    await render();
    expect(h.current).toBe('GeneralSection');

    await act(async () => {
      navButton(EN_MESSAGES['settings.nav.agents'])!.click();
      await Promise.resolve();
    });
    expect(h.current).toBe('AgentsSection');

    await act(async () => {
      navButton(EN_MESSAGES['settings.nav.wake'])!.click();
      await Promise.resolve();
    });
    expect(h.current).toBe('WakeSettingsPanel');
  });

  it('mirrors the nav in the responsive select and switches from it', async () => {
    await render();
    const select = container.querySelector('select') as HTMLSelectElement;
    expect(select).toBeTruthy();
    // The select is the narrow-window fallback: it must list every section.
    expect([...select.options].map((o) => o.value)).toEqual(SETTINGS_NAV.map((e) => e.id));

    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!
      .set as (this: HTMLSelectElement, value: string) => void;
    await act(async () => {
      setter.call(select, 'companion');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(h.current).toBe('CompanionSection');
  });

  it('renders exactly one pane at a time (no section stacking)', async () => {
    await render();
    // The initial mount renders exactly the default section once.
    expect(h.rendered).toEqual(['GeneralSection']);

    // Each stub appends its id on every render; clearing before each switch and
    // asserting a single entry proves the shell mounts exactly one pane. The
    // default section is skipped because clicking the already-active entry is a
    // no-op (React bails out), which is correct behaviour, not a stacked pane.
    for (const entry of SETTINGS_NAV) {
      if (entry.id === DEFAULT_SETTINGS_SECTION) continue;
      h.rendered.length = 0;
      await act(async () => {
        navButton(EN_MESSAGES[entry.labelKey])!.click();
        await Promise.resolve();
      });
      expect(h.rendered, `pane count after switching to ${entry.id}`).toHaveLength(1);
    }
  });

  it('survives a strict-mode double render without losing the active section', async () => {
    act(() => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(
            I18nProvider,
            null,
            createElement(SettingsPanel, {
              connection,
              onConnectionChange: () => undefined,
              onClose: () => undefined,
            }),
          ),
        ),
      );
    });
    await flush();
    await act(async () => {
      navButton(EN_MESSAGES['settings.nav.security'])!.click();
      await Promise.resolve();
    });
    expect(h.current).toBe('SecuritySection');
  });
});
