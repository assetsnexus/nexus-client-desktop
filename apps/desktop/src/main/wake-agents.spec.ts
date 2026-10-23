import { describe, expect, it, vi } from 'vitest';
import { createWakeAgentDirectory, type WakeAgentIdentity } from './wake-agents.js';

/** Active-identity fallback path: `getSender()` returns a plain `send`. */
function makeDirectory(responses: Record<string, unknown>) {
  const send = vi.fn(async (command: string) => responses[command] ?? null);
  const directory = createWakeAgentDirectory({ getSender: async () => ({ send }) });
  return { directory, send };
}

type SendMock = ReturnType<typeof vi.fn>;

/**
 * Fan-out path: explicit stored identities + injectable node-core sender.
 * The sender stub returns a raw region envelope, like the real `sendCommand`.
 */
function makeMultiIdentityDirectory(options: {
  identities: WakeAgentIdentity[];
  activeKey?: string;
  handler: (args: { token?: string; command: string; identity: Record<string, unknown> }) => unknown;
}) {
  const send: SendMock = vi.fn(async (_opts: unknown, command: string, _payload: unknown, args: unknown) => {
    const envelope = args as { token?: string; identity: Record<string, unknown> };
    return options.handler({ token: envelope.token, command, identity: envelope.identity });
  });
  const directory = createWakeAgentDirectory({
    // Never used on the fan-out path; present so the type is satisfied.
    getSender: async () => ({ send }),
    listIdentities: () => options.identities,
    getClientOptions: () => ({ baseUrl: 'https://region.example.com' }),
    activeKey: () => options.activeKey ?? null,
    send: send as never,
  });
  return { directory, send };
}

const bizIdentity = (over: Partial<WakeAgentIdentity> = {}): WakeAgentIdentity => ({
  key: 'business:o1:u1',
  userId: 'u1',
  orgId: 'o1',
  token: 'tok-o1',
  deviceId: 'dev-o1',
  ...over,
});

describe('createWakeAgentDirectory (active-identity fallback)', () => {
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

  /**
   * Regression: the live `getSender()` sender returns the raw region envelope
   * (`{ responseCode, responseObject }`). The old unwrap only read `.data`, so
   * employees hid behind `responseObject` and the picker showed nothing.
   */
  it('unwraps the raw region envelope (responseObject) instead of returning empty', async () => {
    const send = vi.fn(async (command: string) =>
      command.includes('list-public')
        ? { responseCode: 200, responseObject: [{ employeeId: 'pub1', name: 'Public' }] }
        : {
            responseCode: 200,
            responseObject: [
              { employeeId: 've1', name: 'Owned' },
              { employeeId: 've2', name: 'Owned Two' },
            ],
          },
    );
    const directory = createWakeAgentDirectory({ getSender: async () => ({ send }) });
    const rows = await directory.list();
    expect(rows.map((r) => r.contactId).sort()).toEqual(['pub1', 've1', 've2']);
    expect(rows.find((r) => r.contactId === 've1')!.canConfigure).toBe(true);
    expect(rows.find((r) => r.contactId === 'pub1')!.canConfigure).toBe(false);
  });
});

describe('createWakeAgentDirectory (multi-membership fan-out)', () => {
  it('unions agents across every stored membership', async () => {
    const { directory } = makeMultiIdentityDirectory({
      identities: [
        { key: 'private:u1', userId: 'u1', orgId: null, token: 'tok-personal', deviceId: 'dev-personal' },
        bizIdentity({ key: 'business:o1:u1', token: 'tok-o1' }),
        bizIdentity({ key: 'business:ox:u1', orgId: 'ox', token: 'tok-ox', deviceId: 'dev-ox' }),
      ],
      handler: ({ token, command }) => {
        if (token === 'tok-personal') {
          return { responseCode: 200, responseObject: [{ employeeId: 'p1', name: 'Selene' }] };
        }
        if (command.includes('list-public')) {
          return { responseCode: 200, responseObject: [] };
        }
        if (token === 'tok-ox') {
          // The xchange org that owns the xcamp app agent.
          return {
            responseCode: 200,
            responseObject: [{ employeeId: 'xg1', name: 'Xcamp', oauthClientId: 'xcamp-client' }],
          };
        }
        return { responseCode: 200, responseObject: [{ employeeId: 'a1', name: 'Rune' }] };
      },
    });

    const rows = await directory.list();
    expect(rows.map((r) => r.contactId).sort()).toEqual(['a1', 'p1', 'xg1']);
    // The xcamp agent from the non-active membership is present.
    expect(rows.find((r) => r.contactId === 'xg1')!.name).toBe('Xcamp');
  });

  it('queries each identity with its own token and deviceId', async () => {
    const seen: Array<{ token?: string; identity: Record<string, unknown> }> = [];
    const { directory } = makeMultiIdentityDirectory({
      identities: [
        { key: 'private:u1', userId: 'u1', orgId: null, token: 'tok-personal', deviceId: 'dev-personal' },
        bizIdentity({ token: 'tok-o1', deviceId: 'dev-o1' }),
      ],
      handler: ({ token, identity }) => {
        seen.push({ token, identity });
        return { responseCode: 200, responseObject: [] };
      },
    });
    await directory.list();
    expect(seen).toContainEqual({
      token: 'tok-personal',
      identity: { userId: 'u1', deviceId: 'dev-personal' },
    });
    expect(seen).toContainEqual({
      token: 'tok-o1',
      identity: { userId: 'u1', orgId: 'o1', deviceId: 'dev-o1' },
    });
  });

  it('queries the active identity first so its owned row wins a collision', async () => {
    const { directory } = makeMultiIdentityDirectory({
      activeKey: 'business:oactive:u1',
      identities: [
        bizIdentity({ key: 'business:oother:u1', orgId: 'oother', token: 'tok-other' }),
        bizIdentity({ key: 'business:oactive:u1', orgId: 'oactive', token: 'tok-active' }),
      ],
      handler: ({ token, command }) => {
        // Both orgs expose the same employee id; only the active one owns it.
        if (command.includes('list-public')) return { responseCode: 200, responseObject: [] };
        return {
          responseCode: 200,
          responseObject: [
            { employeeId: 'shared', name: token === 'tok-active' ? 'Active Org Agent' : 'Other Org Agent' },
          ],
        };
      },
    });
    const rows = await directory.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('Active Org Agent');
    expect(rows[0]!.canConfigure).toBe(true);
  });

  it('tolerates one membership failing and keeps the others', async () => {
    const { directory } = makeMultiIdentityDirectory({
      identities: [
        bizIdentity({ key: 'business:bad:u1', orgId: 'bad', token: 'tok-bad' }),
        bizIdentity({ key: 'business:ok:u1', orgId: 'ok', token: 'tok-ok' }),
      ],
      handler: ({ token }) => {
        if (token === 'tok-bad') throw new Error('region unreachable');
        return { responseCode: 200, responseObject: [{ employeeId: 'ok1', name: 'OK' }] };
      },
    });
    const rows = await directory.list();
    expect(rows.map((r) => r.contactId)).toEqual(['ok1']);
  });

  it('returns a clean empty list when no membership has agents', async () => {
    const { directory } = makeMultiIdentityDirectory({
      identities: [bizIdentity()],
      handler: () => ({ responseCode: 200, responseObject: [] }),
    });
    expect(await directory.list()).toEqual([]);
  });

  it('falls back to the active sender when no identities are stored', async () => {
    const send = vi.fn(async (command: string) =>
      command.includes('list-public')
        ? { employees: [{ employeeId: 'pub', name: 'Public' }] }
        : { employees: [{ employeeId: 'own', name: 'Owned' }] },
    );
    const directory = createWakeAgentDirectory({
      getSender: async () => ({ send }),
      listIdentities: () => [],
    });
    expect((await directory.list()).map((r) => r.contactId).sort()).toEqual(['own', 'pub']);
  });
});
