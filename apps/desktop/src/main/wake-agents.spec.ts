import { describe, expect, it, vi } from 'vitest';
import { createWakeAgentDirectory } from './wake-agents.js';

function makeDirectory(responses: Record<string, unknown>) {
  const send = vi.fn(async (command: string) => responses[command] ?? null);
  const directory = createWakeAgentDirectory({ getSender: async () => ({ send }) });
  return { directory, send };
}

describe('createWakeAgentDirectory', () => {
  it('projects owned employees and marks them configurable', async () => {
    const { directory } = makeDirectory({
      'anx.ai-agents.virtual-employees.list': [
        { employeeId: 've1', name: 'Jarvis', agentId: 'a1' },
      ],
      'anx.ai-agents.virtual-employees.list-public': [],
    });
    expect(await directory.list()).toEqual([
      { contactId: 've1', virtualEmployeeId: 've1', agentId: 'a1', name: 'Jarvis', canConfigure: true },
    ]);
  });

  it('merges public employees that are not already owned', async () => {
    const { directory } = makeDirectory({
      'anx.ai-agents.virtual-employees.list': [{ employeeId: 've1', name: 'Mine' }],
      'anx.ai-agents.virtual-employees.list-public': {
        employees: [
          { employeeId: 've1', name: 'Mine (dupe)' },
          { employeeId: 've2', name: 'Public Bot' },
        ],
      },
    });
    const rows = await directory.list();
    expect(rows.map((r) => r.contactId).sort()).toEqual(['ve1', 've2']);
    expect(rows.find((r) => r.contactId === 've1')!.canConfigure).toBe(true);
    expect(rows.find((r) => r.contactId === 've2')!.canConfigure).toBe(false);
  });

  it('tolerates a failing catalog', async () => {
    const send = vi.fn(async (command: string) => {
      if (command.includes('list-public')) return { employees: [{ employeeId: 've9', name: 'Solo' }] };
      throw new Error('owned list failed');
    });
    const directory = createWakeAgentDirectory({ getSender: async () => ({ send }) });
    const rows = await directory.list();
    expect(rows.map((r) => r.contactId)).toEqual(['ve9']);
  });

  it('falls back to _id and synthesises an id', async () => {
    const { directory } = makeDirectory({
      'anx.ai-agents.virtual-employees.list': [{ _id: 'mongo1', title: 'No Employee Id' }],
      'anx.ai-agents.virtual-employees.list-public': [],
    });
    expect((await directory.list())[0]!.contactId).toBe('mongo1');
  });
});
