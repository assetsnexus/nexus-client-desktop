/**
 * Model picker column regression test.
 *
 * Renders the real `ModelPicker` with the column data the desktop feeds it
 * (mapped from `anx.inference.models.available` + `anx.inference.models.list`)
 * and asserts the four things the portal shows:
 *
 *   1. model name + provider
 *   2. intelligence index
 *   3. hosting-type badges (public / managed / private / edge)
 *   4. a pricing badge whose tooltip lists in / out / cached token prices
 *
 * The import goes straight at the chat-react source so a stale `dist/` cannot
 * make this test pass while the renderer shows the old picker.
 */
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModelPickerRow } from '../../../../../../anx-npm-modules/packages/chat-react/src/components/ModelPicker';
import { mergePickerModels } from '../../../../../../anx-npm-modules/packages/chat-react/src/models/picker-map';
import type { PickerModel } from '../../../../../../anx-npm-modules/packages/chat-react/src/models/picker-types';

/** One `models.available` row (real shape, trimmed to the fields under test). */
function availableRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'd2285bf8-c00d-4e85-82d9-6b7c331b9629',
    externalModelId: 'anthropic/claude-fable-5.1',
    displayName: 'Anthropic: Claude Fable 5.1',
    category: 'chat',
    capabilities: ['chat_agent', 'text_gen', 'tool_calling'],
    availableHostingTypes: ['public_cloud'],
    preferredHostingType: 'public_cloud',
    chatPriceCreditsPerMillion: 13000,
    providerId: 'openrouter',
    intelligenceIndex: 41.2,
    ...over,
  };
}

function model(over: Partial<PickerModel> = {}): PickerModel {
  const rows = mergePickerModels([availableRow(over as Record<string, unknown>)], []);
  return { ...rows[0], ...over };
}

/** The dropdown row itself, which carries the four columns under test. */
function renderRows(models: PickerModel[]): string {
  return models
    .map((m) =>
      renderToStaticMarkup(
        createElement(ModelPickerRow, { model: m, active: false, onSelect: () => {} }),
      ),
    )
    .join('\n');
}

describe('desktop model picker columns', () => {
  it('renders name, intelligence index, hosting badges and a price badge', () => {
    const m = model();
    const html = renderRows([m]);
    // name + provider mark
    expect(html).toContain('Claude Fable 5.1');
    // intelligence index column
    expect(html).toContain('nexus-chat-model-col-intel');
    expect(html).toContain('41.2');
    // hosting column with the public pill
    expect(html).toContain('nexus-chat-model-col-hosting');
    expect(html).toContain('hosting-public');
    expect(html).toContain('>public<');
    // pricing column
    expect(html).toContain('nexus-chat-model-col-price');
  });

  it('shows one badge per hosting type the model supports', () => {
    const m = model({
      availableHostingTypes: ['private_cloud', 'edge_processing'],
      preferredHostingType: 'private_cloud' as PickerModel['preferredHostingType'],
    });
    const html = renderRows([m]);
    expect(html).toContain('hosting-private');
    expect(html).toContain('hosting-edge');
    expect(html).toContain('>private<');
    expect(html).toContain('>edge<');
    expect(html).toContain('Private cloud (preferred)');
  });

  it('covers every hosting class: public, managed, private, edge', () => {
    const rows = [
      model({ id: 'a', label: 'Public', availableHostingTypes: ['public_cloud'] }),
      model({ id: 'b', label: 'Managed', availableHostingTypes: ['managed_cloud'] }),
      model({ id: 'c', label: 'Private', availableHostingTypes: ['private_cloud'] }),
      model({ id: 'd', label: 'Edge', availableHostingTypes: ['edge_processing'] }),
    ];
    const html = renderRows(rows);
    for (const cls of ['hosting-public', 'hosting-managed', 'hosting-private', 'hosting-edge']) {
      expect(html).toContain(cls);
    }
    for (const word of ['>public<', '>managed<', '>private<', '>edge<']) {
      expect(html).toContain(word);
    }
  });

  it('renders no hosting badge when the model has no hosting metadata', () => {
    const m = model({ availableHostingTypes: [], preferredHostingType: undefined });
    const html = renderRows([m]);
    expect(html).toContain('nexus-chat-model-col-hosting');
    expect(html).not.toContain('hosting-public');
    expect(html).not.toContain('nexus-chat-model-hosting-pill');
  });

  it('renders no intelligence score when the model has none', () => {
    const m = model({ intelligenceIndex: null });
    const html = renderRows([m]);
    expect(html).toContain('nexus-chat-model-col-intel');
    expect(html).toContain('No intelligence score');
  });

  it('puts in / out / cached token prices in the pricing badge tooltip', () => {
    const m = model({
      inputPerM: 3,
      outputPerM: 15,
      cachedPerM: 0.3,
      cachedPerMSource: 'derived',
      costCurrency: 'USD',
    });
    const html = renderRows([m]);
    expect(html).toContain('In: $3.00/M tokens');
    expect(html).toContain('Out: $15.00/M tokens');
    expect(html).toContain('Cached: $0.300/M tokens (est. 10% of input)');
  });

  it('falls back to the platform credit rate when only credits are priced', () => {
    const m = model({
      inputPerM: null,
      outputPerM: null,
      cachedPerM: null,
      cachedPerMSource: null,
      chatPriceCreditsPerMillion: 5,
    });
    expect(renderRows([m])).toContain('Billing: 5.0 cr/M');
  });

  it('does not invent a tooltip when the model has no price at all', () => {
    const m = model({
      inputPerM: null,
      outputPerM: null,
      cachedPerM: null,
      cachedPerMSource: null,
      chatPriceCreditsPerMillion: null,
    });
    const html = renderRows([m]);
    expect(html).not.toContain('In: $');
    expect(html).not.toContain('/M tokens');
  });

  it('maps the region short hosting aliases models.list returns', () => {
    const rows = mergePickerModels([], [
      {
        id: '33333333-3333-4333-8333-333333333333',
        displayName: 'Managed Model',
        category: 'chat',
        capabilities: ['chat_agent', 'text_gen'],
        hostingType: 'managed',
      },
    ]);
    expect(rows[0].availableHostingTypes).toEqual(['managed_cloud']);
    expect(renderRows(rows)).toContain('hosting-managed');
  });
});

describe('row presentation fixes', () => {
  it('titles the row with the model name + region identifier, never the UUID', () => {
    const m = model();
    const html = renderRows([m]);
    // Line 1 = full human display name, line 2 = provider/model:tag identifier.
    const title = html.match(/title="([^"]+)"/)?.[1] ?? '';
    expect(title).toBe('Anthropic: Claude Fable 5.1\nanthropic/claude-fable-5.1');
    // aria-label stays consistent with the title.
    const aria = html.match(/aria-label="([^"]+)"/)?.[1] ?? '';
    expect(aria).toBe(title);
    expect(html).not.toContain('d2285bf8-c00d-4e85-82d9-6b7c331b9629"');
  });

  it('shows the display name without the synthesized provider prefix', () => {
    const html = renderRows([model()]);
    // The provider icon already conveys "Anthropic"; the column must not repeat it.
    expect(html).toContain('<strong>Claude Fable 5.1</strong>');
    expect(html).not.toContain('<strong>Anthropic: Claude Fable 5.1</strong>');
  });

  it('badges the OUT token price while the tooltip keeps every line', () => {
    const m = model({
      inputPerM: 3,
      outputPerM: 15,
      cachedPerM: 0.3,
      cachedPerMSource: 'derived',
      costCurrency: 'USD',
    });
    const html = renderRows([m]);
    // Badge value = out ($15.0/M compact), not in ($3.00/M).
    expect(html).toContain('>$15.0/M<');
    expect(html).not.toContain('>$3.00/M<');
    // Tooltip still lists in / out / cached.
    expect(html).toContain('In: $3.00/M tokens');
    expect(html).toContain('Out: $15.00/M tokens');
  });

  it('drops the estimate suffix once the region prices an explicit cache_read row', () => {
    const rows = mergePickerModels(
      [
        availableRow({
          costPricing: [
            { unit: 'token_in', unitPriceMillicents: 0.3, currency: 'USD' },
            { unit: 'token_out', unitPriceMillicents: 1.5, currency: 'USD' },
            { unit: 'cache_read', unitPriceMillicents: 0.03, currency: 'USD' },
          ],
        }),
      ],
      [],
    );
    expect(rows[0].cachedPerMSource).toBe('catalog');
    const html = renderRows(rows);
    expect(html).toContain('Cached: $0.300/M tokens');
    expect(html).not.toContain('est. 10% of input');
  });
});
