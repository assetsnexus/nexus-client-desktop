/**
 * Evidence harness: feed the REAL region rows (captured from the running
 * seeded region with the desktop app's own signed-in identity) through the
 * picker mapping, render the dropdown rows in a real React tree, and assert the
 * three additions the request asks for — intelligence-index column, hosting
 * badges, and the in/out/cached pricing tooltip.
 *
 * The fixture is committed, so this does not need a live region to run:
 * `model-picker/__fixtures__/real-rows.json` holds
 *   - `available`    : `anx.inference.models.available`
 *   - `catalog`      : `anx.inference.models.list` (`publishedOnly: false`)
 *   - `entitlements` : `anx.ai-agents.entitlements.list`
 *
 * The import goes straight at the chat-react source so a stale `dist/` cannot
 * make this pass while the renderer shows the old picker.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ModelPickerRow } from '../../../../../../anx-npm-modules/packages/chat-react/src/components/ModelPicker';
import { mergeEntitledModelsForPicker } from '../../../../../../anx-npm-modules/packages/chat-react/src/models/mergeEntitledModels';
import {
  displayModelName,
  hostingBadges,
  modelTooltipText,
  pricingTooltipText,
} from '../../../../../../anx-npm-modules/packages/chat-react/src/models/picker-row';
import realRows from './__fixtures__/real-rows.json';

const rows = mergeEntitledModelsForPicker({
  availableRows: (realRows as any).available?.models ?? [],
  catalogRows: (realRows as any).catalog?.models ?? [],
  entitlementsPayload: (realRows as any).entitlements ?? {},
});

function renderRow(m: (typeof rows)[number]): string {
  return renderToStaticMarkup(
    createElement(ModelPickerRow, { model: m, active: false, onSelect: () => {} }),
  );
}

/** React escapes quotes/angles in an attribute but keeps the raw `\n`. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

describe('real region rows through the picker', () => {
  it('produces the entitled picker rows', () => {
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((m) => Boolean(m.availableHostingTypes?.length))).toBe(true);
  });

  it('renders the intelligence-index column on every row', () => {
    const html = renderRow(rows[0]);
    expect(html).toContain('nexus-chat-model-col-intel');
  });

  it('renders the REAL populated intelligence scores (not the placeholder)', () => {
    // The region's `anx.ai.catalog.intelligence.lookup` populated the index, so
    // the fixture carries real Artificial Analysis values for the rows it can
    // match. Pin them exactly — a regression to the placeholder must fail here.
    const scored = rows.filter((m) => typeof m.intelligenceIndex === 'number');
    expect(scored.length).toBe(10);
    const byExt = new Map(rows.map((m) => [m.externalModelId, m]));
    expect(byExt.get('anthropic/claude-fable-5.1')?.intelligenceIndex).toBeCloseTo(53.4);
    expect(byExt.get('x-ai/grok-4.6')?.intelligenceIndex).toBeCloseTo(44.3);
    expect(byExt.get('anthropic/claude-opus-5')?.intelligenceIndex).toBeCloseTo(50.8);
    // Every scored row renders the real number, never the em-dash placeholder,
    // and the score is formatted with the AA band precision (>= 10 -> 1 dp).
    for (const m of scored) {
      const rowHtml = renderRow(m);
      expect(rowHtml).toContain('title="Intelligence score"');
      expect(rowHtml).toContain(m.intelligenceIndex! >= 10 ? m.intelligenceIndex!.toFixed(1) : m.intelligenceIndex!.toFixed(2));
      expect(rowHtml).not.toContain('No intelligence score');
    }
  });

  it('uses the placeholder only for the genuinely unscored rows', () => {
    // The other rows (image / audio SKUs, floating `-latest` aliases) are
    // honestly null — the picker must never invent a number for them.
    const unscored = rows.filter((m) => m.intelligenceIndex == null);
    expect(unscored.length).toBe(rows.length - 10);
    expect(unscored.length).toBeGreaterThan(0);
    for (const m of unscored) {
      const rowHtml = renderRow(m);
      expect(rowHtml).toContain('No intelligence score');
      expect(rowHtml).toContain('nexus-chat-model-col-empty');
      expect(rowHtml).not.toContain('title="Intelligence score"');
    }
  });

  it('renders the hosting badges the region reports, preferred one marked', () => {
    const html = renderRow(rows[0]);
    expect(html).toContain('nexus-chat-model-col-hosting');
    expect(html).toContain('nexus-chat-model-hosting-pill hosting-public');
    expect(html).toContain('Public cloud (preferred)');
    // Every row renders one bucket per hosting class the region reports, in order.
    expect(hostingBadges(rows[0].availableHostingTypes, {
      preferred: rows[0].preferredHostingType,
    })).toEqual([
      { key: 'public_cloud', short: 'public', label: 'Public cloud (preferred)', preferred: true },
    ]);
  });

  it('renders the pricing badge with in / out / cached token prices on hover', () => {
    // Real entitlement costPricing: token_in 1 millicent, token_out 5 millicents.
    const priced = rows.find((m) => typeof m.inputPerM === 'number');
    expect(priced).toBeTruthy();
    const html = renderRow(priced!);
    expect(html).toContain('nexus-chat-model-col-price');
    // Badge = OUT rate (token_out 5 millicents => $50.0/M), not the input rate.
    expect(html).toContain('>$50.0/M<');
    expect(html).not.toContain('>$10.0/M<');
    expect(html).toContain('In: $10.00/M tokens');
    expect(html).toContain('Out: $50.00/M tokens');
    expect(pricingTooltipText(priced!)).toContain('In: $10.00/M tokens');
  });

  it('quotes the real `cache_read` price with NO estimate suffix', () => {
    // Change 2: the entitlement row now carries an explicit `cache_read` unit,
    // so the cached line is a QUOTED rate — the `(est. 10% of input)` suffix
    // must be gone.
    const quoted = rows.find((m) => m.cachedPerMSource === 'catalog');
    expect(quoted).toBeTruthy();
    const tip = pricingTooltipText(quoted!);
    expect(tip).toContain('Cached: $');
    expect(tip).toContain('/M tokens');
    expect(tip).not.toContain('est. 10% of input');
    expect(renderRow(quoted!)).toContain('Cached: $');
    // A real quoted case: Claude Fable 5.1 has token_in 10 / cache_read 0.25.
    const fable = rows.find((m) => m.externalModelId === 'anthropic/claude-fable-5.1');
    expect(fable?.cachedPerMSource).toBe('catalog');
    expect(pricingTooltipText(fable!)).toContain('Cached: $0.250/M tokens');
    expect(pricingTooltipText(fable!)).not.toContain('est. 10% of input');
  });

  it('keeps the labelled derived estimate where the fixture genuinely has no cache_read', () => {
    // Change 2's other half: a row with no explicit cache_read keeps the honest
    // labelled `input × 0.1` estimate.
    const derived = rows.find((m) => m.cachedPerMSource === 'derived');
    expect(derived).toBeTruthy();
    const tip = pricingTooltipText(derived!);
    expect(tip).toContain('Cached: $');
    expect(tip).toContain('(est. 10% of input)');
    expect(renderRow(derived!)).toContain('(est. 10% of input)');
  });

  it('hides every `:batch` SKU from the chat-seeded picker list', () => {
    // Change 1: `entitlements.list` defaults to `purpose:'chat'`, so the seed
    // the picker loads carries no `:batch` SKUs — even though the catalogue
    // block still contains them (the deliberate scoping asymmetry).
    expect(rows.filter((m) => /:batch\b/.test(String(m.externalModelId ?? m.id ?? '')))).toEqual([]);
    for (const m of rows) {
      expect(renderRow(m)).not.toContain(':batch');
    }
    // Non-batch twins survive.
    const ext = new Set(rows.map((m) => m.externalModelId));
    expect(ext.has('anthropic/claude-fable-5.1')).toBe(true);
    expect(ext.has('anthropic/claude-sonnet-5')).toBe(true);
    // But the catalogue block still has them: the picker maps only the seed.
    const catalogBatch = ((realRows as any).catalog?.models ?? []).filter((m: any) =>
      /:batch\b/.test(String(m.externalModelId ?? '')),
    );
    expect(catalogBatch.length).toBeGreaterThan(0);
  });

  it('titles every row with its name + region identifier and never a UUID', () => {
    for (const m of rows) {
      const html = renderRow(m);
      // No raw UUID survives into a title/aria-label.
      expect(html).not.toMatch(/title="[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/);
      const tip = modelTooltipText(m);
      if (!tip) continue;
      expect(html).toContain(`title="${escapeHtml(tip)}"`);
      if (m.externalModelId?.includes('/')) {
        expect(tip).toContain(m.externalModelId);
      }
      expect(tip).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    }
  });

  it('strips the synthesized provider prefix from real names in the name column', () => {
    // The live payload composes `<Vendor>: <model>`; the icon carries the vendor.
    const stripped = rows.filter((m) => m.label.includes(': ') && displayModelName(m) !== m.label);
    expect(stripped.length).toBeGreaterThan(0);
    for (const m of stripped) {
      expect(displayModelName(m)).toBe(m.label.slice(m.label.indexOf(': ') + 2));
      const html = renderRow(m);
      expect(html).toContain(`<strong>${escapeHtml(displayModelName(m))}</strong>`);
      expect(html).not.toContain(`<strong>${escapeHtml(m.label)}</strong>`);
    }
  });

  it('keeps a colon that is not the row\'s provider', () => {
    // `SpaceXAI: Grok 4.6` is providerId `x-ai`, so the vendor token is part of
    // the model's own name and must survive verbatim.
    const grok = rows.find((m) => m.label === 'SpaceXAI: Grok 4.6');
    if (grok) {
      expect(displayModelName(grok)).toBe('SpaceXAI: Grok 4.6');
    }
  });

  it('carries the currency the region priced in', () => {
    expect(rows.every((m) => m.costCurrency === 'USD' || m.costCurrency === null)).toBe(true);
    expect(rows.some((m) => m.costCurrency === 'USD')).toBe(true);
  });
});
