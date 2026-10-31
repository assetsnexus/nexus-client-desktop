import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanionPositionStore, normalizeCompanionPositions } from './companion-position-store.js';

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'nexus-positions-')), 'companion-positions.json');
}

describe('normalizeCompanionPositions', () => {
  it('keeps finite points and drops everything else', () => {
    expect(
      normalizeCompanionPositions({
        a: { x: 10, y: 20 },
        b: { x: 'nope', y: 1 },
        c: null,
        d: { x: 3.6, y: 4.2 },
      }),
    ).toEqual({
      a: { x: 10, y: 20 },
      d: { x: 4, y: 4 },
    });
  });

  it('returns an empty map for a malformed blob', () => {
    expect(normalizeCompanionPositions('nope')).toEqual({});
    expect(normalizeCompanionPositions(null)).toEqual({});
  });
});

describe('createCompanionPositionStore', () => {
  it('round-trips a position across store instances', () => {
    const path = tempFile();
    expect(createCompanionPositionStore(path).get('ve-1')).toBeNull();
    createCompanionPositionStore(path).set('ve-1', { x: 120, y: 340 });
    expect(createCompanionPositionStore(path).get('ve-1')).toEqual({ x: 120, y: 340 });
  });

  it('clears one contact without touching the others', () => {
    const store = createCompanionPositionStore(tempFile());
    store.set('ve-1', { x: 1, y: 2 });
    store.set('ve-2', { x: 3, y: 4 });
    store.clear('ve-1');
    expect(store.get('ve-1')).toBeNull();
    expect(store.get('ve-2')).toEqual({ x: 3, y: 4 });
  });

  it('ignores an empty contact id or a malformed point', () => {
    const store = createCompanionPositionStore(tempFile());
    store.set('  ', { x: 1, y: 2 });
    store.set('ve-1', { x: Number.NaN, y: 2 });
    expect(store.all()).toEqual({});
  });

  it('survives a hand-edited file with junk entries', () => {
    const path = tempFile();
    writeFileSync(path, JSON.stringify({ 've-1': { x: 5, y: 6 }, 've-2': 'garbage' }), 'utf8');
    const store = createCompanionPositionStore(path);
    expect(store.all()).toEqual({ 've-1': { x: 5, y: 6 } });
  });
});
