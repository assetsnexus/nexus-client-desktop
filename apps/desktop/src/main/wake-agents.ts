/**
 * Wake-word agent directory (main process).
 *
 * The wake settings picker needs the list of agents a phrase can be mapped to.
 * The chat SPA owns the rich contact mapping, but it is not mounted while the
 * settings panel is open, so this module asks the region directly for the two
 * virtual-employee catalogs (owned + public) and projects a flat, renderer-safe
 * row. It only reads — it never maps a wake to an agent by itself.
 */

import type { WakeAgentRow } from '../shared/wake.js';

export type WakeAgentDirectoryOptions = {
  /** Region command sender with the active identity's token. */
  getSender: () => Promise<{
    send: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
  }>;
};

function unwrapData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  const data = record.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return record;
}

/** The rows array a region list handler returns (array, `.employees`, `.items`). */
function rowsOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const data = unwrapData(value);
  if (Array.isArray(data)) return data as unknown[];
  if (Array.isArray(data.employees)) return data.employees as unknown[];
  if (Array.isArray(data.items)) return data.items as unknown[];
  if (Array.isArray(data.contacts)) return data.contacts as unknown[];
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

export type WakeAgentDirectory = ReturnType<typeof createWakeAgentDirectory>;

export function createWakeAgentDirectory(options: WakeAgentDirectoryOptions) {
  return {
    /**
     * List mappable agents, deduped by contact id (owned rows win over public
     * ones so `canConfigure` reflects ownership). Failures are tolerated: a
     * wake-word picker with an empty list is better than a hard error.
     */
    async list(): Promise<WakeAgentRow[]> {
      const sender = await options.getSender();
      const [ownedResult, publicResult] = await Promise.all([
        sender.send('anx.ai-agents.virtual-employees.list', {}).catch(() => null),
        sender.send('anx.ai-agents.virtual-employees.list-public', {}).catch(() => null),
      ]);
      const byId = new Map<string, WakeAgentRow>();
      for (const row of project(rowsOf(ownedResult), true)) byId.set(row.contactId, row);
      for (const row of project(rowsOf(publicResult), false)) {
        if (!byId.has(row.contactId)) byId.set(row.contactId, row);
      }
      return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}
