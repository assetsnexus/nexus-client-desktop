/**
 * Persisted last-known companion position per agent/contact (main process).
 *
 * Powers the `remember-last` placement mode: when the user drags a companion
 * somewhere, that spot is where *that* agent reopens next time. Mirrors
 * `local-avatar-store.ts` — plain JSON in `userData`, every value re-validated on
 * read so a hand-edited file cannot place a window at `NaN`.
 *
 * Deliberately separate from `settings.json`: positions change on every drag, and
 * burying them in the settings blob would rewrite the whole file each time.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import type { PlacementPoint } from '../shared/companion-placement.js';

export type CompanionPositionStore = {
  /** Remembered top-left for a contact, or `null` when none was recorded. */
  get(contactId: string): PlacementPoint | null;
  /** Record a contact's new top-left (already clamped by the caller). */
  set(contactId: string, point: PlacementPoint): void;
  /** Forget one contact (e.g. its remembered spot is stale/off-screen for good). */
  clear(contactId: string): void;
  /** Every remembered position, for display validation at spawn time. */
  all(): Record<string, PlacementPoint>;
};

function isPoint(value: unknown): value is PlacementPoint {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return Number.isFinite(rec.x) && Number.isFinite(rec.y);
}

/** Keep only finite, in-range points; drop everything else. */
export function normalizeCompanionPositions(raw: unknown): Record<string, PlacementPoint> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, PlacementPoint> = {};
  for (const [contactId, point] of Object.entries(raw as Record<string, unknown>)) {
    if (!contactId || !isPoint(point)) continue;
    out[contactId] = { x: Math.round(point.x), y: Math.round(point.y) };
  }
  return out;
}

export function createCompanionPositionStore(filePath?: string): CompanionPositionStore {
  const path = filePath ?? join(app.getPath('userData'), 'companion-positions.json');

  const read = (): Record<string, PlacementPoint> => {
    if (!existsSync(path)) return {};
    try {
      return normalizeCompanionPositions(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      return {};
    }
  };

  const write = (value: Record<string, PlacementPoint>): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
  };

  return {
    get(contactId) {
      const key = typeof contactId === 'string' ? contactId.trim() : '';
      if (!key) return null;
      return read()[key] ?? null;
    },
    set(contactId, point) {
      const key = typeof contactId === 'string' ? contactId.trim() : '';
      if (!key || !isPoint(point)) return;
      write({ ...read(), [key]: { x: Math.round(point.x), y: Math.round(point.y) } });
    },
    clear(contactId) {
      const key = typeof contactId === 'string' ? contactId.trim() : '';
      if (!key) return;
      const current = read();
      if (!(key in current)) return;
      delete current[key];
      write(current);
    },
    all: read,
  };
}
