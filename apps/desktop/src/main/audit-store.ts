/**
 * Main-process-only, append-only audit store for client tools called by agents.
 *
 * **Immutability by agents (enforced here, not by convention):**
 * - This module is imported only by the main process. It is never re-exported
 *   through `shared/ipc.ts` and no IPC channel in the contract maps to
 *   `append`, `trim`, `clear`, `readAll` or `path`.
 * - The agent-facing tool surface (`preload/preload.ts` → `IPC.toolsRun` →
 *   `main/tool-runner.ts`) can only *invoke* a tool. It has no channel that
 *   reaches this store, so an agent cannot read, edit, delete or truncate it.
 * - Writes are append-only JSONL: entries are appended, never rewritten. The
 *   only mutation is retention trimming, which is driven exclusively by the main
 *   process (`append` / `trimNow` / the store's own timer) and is never exposed
 *   to the renderer or to a tool call.
 *
 * The pure shaping/retention/filtering live in `shared/audit.ts`; this file only
 * adds the filesystem + schedule.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  byteSizeOfEntry,
  filterAuditEntries,
  normalizeAuditRetention,
  selectRetained,
  shapeAuditEntry,
  type AuditFilter,
  type AuditRetention,
  type ClientToolAuditEntry,
  type ShapeAuditEntryInput,
} from '../shared/audit.js';
import type { Logger } from './logger.js';

export type AuditStore = {
  /** Append one entry (main process only). Returns the stored entry. */
  append(input: Omit<ShapeAuditEntryInput, 'id'> & { id?: string }): ClientToolAuditEntry;
  /** Newest-first entries matching `filter`, from the in-memory retained set. */
  list(filter?: AuditFilter): ClientToolAuditEntry[];
  /** Current safe retention settings. */
  getRetention(): AuditRetention;
  /**
   * Replace retention settings and immediately re-trim (main process only —
   * this is the ONE mutation, and it is never reachable from an agent tool).
   */
  setRetention(next: Partial<AuditRetention>): AuditRetention;
  /** Run a retention pass now (main-process timer + startup call this). */
  trimNow(): void;
  /** Absolute path of the JSONL file (main process only). */
  filePath(): string;
  /** Number of currently-retained entries. */
  count(): number;
  /** Total persisted bytes of retained entries. */
  sizeBytes(): number;
};

export type AuditStoreOptions = {
  /** Absolute path to the JSONL file. Defaults to `<userData>/audit/client-tools.jsonl`. */
  filePath?: string;
  /** Initial retention; persisted settings override it when configured. */
  retention?: Partial<AuditRetention>;
  /** Where retention settings are persisted. Defaults beside the JSONL file. */
  retentionPath?: string;
  logger?: Logger;
  /** Trim interval, ms. Defaults to one hour. */
  trimIntervalMs?: number;
};

export { byteSizeOfEntry };
export type { AuditFilter, AuditRetention, ClientToolAuditEntry };

let counter = 0;
function nextId(now: number): string {
  counter += 1;
  return `${now.toString(36)}-${counter.toString(36)}`;
}

function parseLine(line: string): ClientToolAuditEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as ClientToolAuditEntry;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.tool !== 'string' || typeof parsed.at !== 'number') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Load the JSONL file oldest→newest, skipping any corrupt line (a torn final
 * write must not make the whole audit unreadable). Retention is applied by the
 * caller once the settings are known.
 */
export function readAuditFile(path: string): ClientToolAuditEntry[] {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .map(parseLine)
      .filter((entry): entry is ClientToolAuditEntry => entry !== null);
  } catch {
    return [];
  }
}

export function createAuditStore(options: AuditStoreOptions = {}): AuditStore {
  const filePath = options.filePath ?? join(process.cwd(), 'audit', 'client-tools.jsonl');
  const retentionPath = options.retentionPath ?? join(dirname(filePath), 'audit-retention.json');
  const log = options.logger?.child('audit');
  const trimIntervalMs = options.trimIntervalMs ?? 60 * 60 * 1000;

  mkdirSync(dirname(filePath), { recursive: true });

  const readRetentionFile = (): AuditRetention => {
    if (!existsSync(retentionPath)) return normalizeAuditRetention(options.retention);
    try {
      return normalizeAuditRetention(JSON.parse(readFileSync(retentionPath, 'utf8')));
    } catch {
      return normalizeAuditRetention(options.retention);
    }
  };

  const writeRetentionFile = (retention: AuditRetention): void => {
    try {
      writeFileSync(retentionPath, JSON.stringify(retention, null, 2), 'utf8');
    } catch {
      /* best-effort; the in-memory value still applies this run */
    }
  };

  let retention = readRetentionFile();
  // In-memory mirror of the append-only file, oldest→newest.
  let entries = readAuditFile(filePath);

  const persist = (): void => {
    // Rewrite the JSONL with only the retained entries. This is the only write
    // that is not an append, and it happens purely from the main-process
    // retention pass (never from an agent tool call).
    const body = entries.map((entry) => JSON.stringify(entry)).join('\n');
    writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
  };

  const trim = (reason: string): void => {
    const before = entries.length;
    const { kept, dropped, bytes } = selectRetained(entries, Date.now(), retention);
    if (dropped === 0) return;
    entries = kept;
    persist();
    log?.info('audit retention trimmed', { reason, dropped, before, kept: kept.length, bytes });
  };

  // Startup trim so a store that grew while the settings were looser is bounded
  // the moment the app boots.
  trim('startup');

  const timer =
    trimIntervalMs > 0
      ? setInterval(() => trim('scheduled'), trimIntervalMs)
      : null;
  // A resident tray app should not keep the event loop alive just for trimming.
  if (timer && typeof timer.unref === 'function') timer.unref();

  const store: AuditStore = {
    append(input) {
      const entry = shapeAuditEntry({ ...input, id: input.id ?? nextId(Date.now()) });
      entries.push(entry);
      try {
        appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
      } catch (err) {
        log?.warn('audit append failed', { message: err instanceof Error ? err.message : String(err) });
      }
      log?.debug('client tool audited', {
        tool: entry.tool,
        agentId: entry.agentId,
        conversationId: entry.conversationId,
        outcome: entry.outcome,
        durationMs: entry.durationMs,
      });
      return entry;
    },
    list(filter = {}) {
      return filterAuditEntries(entries, filter);
    },
    getRetention() {
      return { ...retention };
    },
    setRetention(next) {
      retention = normalizeAuditRetention({ ...retention, ...next });
      writeRetentionFile(retention);
      log?.info('audit retention updated', { retention });
      trim('retention-change');
      return { ...retention };
    },
    trimNow() {
      trim('manual');
    },
    filePath: () => filePath,
    count: () => entries.length,
    sizeBytes: () => entries.reduce((sum, entry) => sum + (entry.bytes ?? byteSizeOfEntry(entry)), 0),
  };

  return store;
}

/** File size on disk, bytes (0 when missing). Used by the settings UI display. */
export function auditFileSize(path: string): number {
  try {
    return existsSync(path) ? statSync(path).size : 0;
  } catch {
    return 0;
  }
}
