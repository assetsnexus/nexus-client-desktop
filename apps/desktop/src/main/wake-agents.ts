/**
 * Wake-word agent directory (main process).
 *
 * The wake settings picker needs the list of agents a phrase can be mapped to.
 * The chat SPA owns the rich contact mapping, but it is not mounted while the
 * settings panel is open, so this module asks the region directly for the two
 * virtual-employee catalogs (owned + public) and projects a flat, renderer-safe
 * row. It only reads — it never maps a wake to an agent by itself.
 *
 * ## Why every stored identity
 *
 * `anx.ai-agents.virtual-employees.list` / `.list-public` scope their result to
 * the **JWT identity's tenant** (the handler deliberately ignores payload
 * `orgId`/`userId`). A user with several org memberships therefore only sees the
 * active org's agents if we ask as the active identity, so agents owned by
 * another membership (e.g. the `xcamp` app agent under an `xchange` org) are
 * missed — even though the region serves them and the portal shows them. The
 * directory fans out over **all** stored sessions and unions the rows by contact
 * id, so the picker reflects every membership. The active identity is queried
 * first so its owned rows win the `canConfigure` flag on any id collision.
 *
 * Every authenticated command is device-gated, so each identity envelope carries
 * its own stored `deviceId`; omitting it yields a 401 `Device validation failed`.
 */

import type { AuthClientOptions, sendCommand } from '@nexus/node-core';
import type { WakeAgentRow } from '../shared/wake.js';

/** One stored session the directory may query as (token authority). */
export type WakeAgentIdentity = {
  key: string;
  userId: string | null;
  orgId: string | null;
  token: string;
  deviceId: string | null;
};

export type WakeAgentDirectoryOptions = {
  /** Region command sender with the active identity's token (single-identity path). */
  getSender: () => Promise<{
    send: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
  }>;
  /**
   * Every stored identity to fan out over. When omitted (or empty) the directory
   * falls back to `getSender()` so the single-identity path still works.
   */
  listIdentities?: () => WakeAgentIdentity[];
  /** Injectable for tests; defaults to the node-core `sendCommand`. */
  send?: typeof sendCommand;
  /** Region client options, rebuilt when the connection config changes. */
  getClientOptions?: () => AuthClientOptions;
  /**
   * The active identity key, queried first so its owned rows win the dedupe.
   * Optional; when absent the list order is used.
   */
  activeKey?: () => string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Unwrap a list response to its rows.
 *
 * Two shapes arrive here:
 *  - the raw `RegionResponse` (`{ responseCode, responseObject }`) from a direct
 *    `sendCommand`, where the rows live under `responseObject`; and
 *  - an already-unwrapped body (a `CommandResult`, or a bare array) where the
 *    rows are the value itself or sit under `employees`/`items`/`contacts`.
 *
 * The earlier version only looked at `.data`, so a raw envelope's `employees`
 * array stayed hidden behind `responseObject` and every list came back empty —
 * which is why the picker showed no agents even though the region returned them.
 */
function rowsOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  // A `RegionResponse` / `CommandResult` envelope: descend into the payload
  // first, so its `employees` / `items` array is visible.
  const inner = record.responseObject ?? record.data;
  if (inner !== undefined && inner !== value) {
    const rows = rowsOf(inner);
    if (rows.length) return rows;
    if (Array.isArray(inner)) return [];
  }
  if (Array.isArray(record.employees)) return record.employees;
  if (Array.isArray(record.items)) return record.items;
  if (Array.isArray(record.virtualEmployees)) return record.virtualEmployees;
  if (Array.isArray(record.contacts)) return record.contacts;
  return [];
}

function project(rows: unknown[], canConfigure: boolean): WakeAgentRow[] {
  const out: WakeAgentRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as Record<string, unknown> | null;
    if (!row || typeof row !== 'object') continue;
    const employeeId = String(row.employeeId ?? '').trim();
    const mongoId = String(row._id ?? row.id ?? '').trim();
    const contactId = employeeId || mongoId || `ve_${i}`;
    if (!contactId) continue;
    out.push({
      // The chat contact id is the employee id when present (matches `mapVeAgents`).
      contactId,
      virtualEmployeeId: employeeId || contactId,
      agentId: row.agentId ? String(row.agentId) : null,
      name: String(row.name ?? row.title ?? row.publicRole ?? 'Agent'),
      canConfigure,
    });
  }
  return out;
}

/** Merge owned + public rows, owned winning the `canConfigure` flag. */
function merge(ownedResult: unknown, publicResult: unknown): WakeAgentRow[] {
  const byId = new Map<string, WakeAgentRow>();
  for (const row of project(rowsOf(ownedResult), true)) byId.set(row.contactId, row);
  for (const row of project(rowsOf(publicResult), false)) {
    if (!byId.has(row.contactId)) byId.set(row.contactId, row);
  }
  return Array.from(byId.values());
}

export type WakeAgentDirectory = ReturnType<typeof createWakeAgentDirectory>;

export function createWakeAgentDirectory(options: WakeAgentDirectoryOptions) {
  /** Lazily resolve the node-core sender so tests need no region import. */
  let resolvedSend: typeof sendCommand | null = options.send ?? null;
  async function sender(): Promise<typeof sendCommand> {
    if (!resolvedSend) {
      const mod = await import('@nexus/node-core');
      resolvedSend = mod.sendCommand;
    }
    return resolvedSend;
  }

  /** Query the two catalogs for one stored identity. */
  async function listForIdentity(identity: WakeAgentIdentity): Promise<WakeAgentRow[]> {
    const send = await sender();
    const clientOptions = options.getClientOptions?.();
    if (!clientOptions) return [];
    const envelope = {
      token: identity.token,
      identity: {
        ...(identity.userId ? { userId: identity.userId } : {}),
        ...(identity.orgId ? { orgId: identity.orgId } : {}),
        // Device validation is mandatory for every authenticated command.
        ...(identity.deviceId ? { deviceId: identity.deviceId } : {}),
      },
    };
    const call = (command: string) =>
      send(clientOptions, command, {}, envelope).catch(() => null);
    const [ownedResult, publicResult] = await Promise.all([
      call('anx.ai-agents.virtual-employees.list'),
      call('anx.ai-agents.virtual-employees.list-public'),
    ]);
    return merge(ownedResult, publicResult);
  }

  /** Single-identity fallback: query only the active identity through its sender. */
  async function listActiveOnly(): Promise<WakeAgentRow[]> {
    const sendActive = await options.getSender();
    const [ownedResult, publicResult] = await Promise.all([
      sendActive.send('anx.ai-agents.virtual-employees.list', {}).catch(() => null),
      sendActive.send('anx.ai-agents.virtual-employees.list-public', {}).catch(() => null),
    ]);
    return merge(ownedResult, publicResult);
  }

  return {
    /**
     * List mappable agents across every stored membership, deduped by contact id
     * (owned rows win over public ones so `canConfigure` reflects ownership).
     * Failures are tolerated: a wake-word picker with an empty list is better
     * than a hard error.
     */
    async list(): Promise<WakeAgentRow[]> {
      const usable = (options.listIdentities?.() ?? []).filter((i) => i.token);
      if (usable.length === 0) {
        const rows = await listActiveOnly();
        return rows.sort((a, b) => a.name.localeCompare(b.name));
      }
      const activeKey = options.activeKey?.() ?? null;
      // Active identity first so its owned rows win the cross-identity dedupe.
      const ordered = activeKey
        ? [...usable.filter((i) => i.key === activeKey), ...usable.filter((i) => i.key !== activeKey)]
        : usable;
      const perIdentity = await Promise.all(ordered.map((identity) => listForIdentity(identity)));
      const byId = new Map<string, WakeAgentRow>();
      for (const rows of perIdentity) {
        for (const row of rows) {
          if (!byId.has(row.contactId)) byId.set(row.contactId, row);
        }
      }
      return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}
