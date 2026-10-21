import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createIdentityPersistence } from './persistence.js';
import { createIdentityStoreState, upsertIdentity, type StoredIdentity } from './store.js';

const dirs: string[] = [];
function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-identity-'));
  dirs.push(dir);
  return join(dir, 'identities.json');
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const privateId = (userId: string, over: Partial<StoredIdentity> = {}): StoredIdentity => ({
  key: `private:${userId}`,
  kind: 'private',
  userId,
  orgId: null,
  role: 'owner',
  token: `t-${userId}`,
  deviceId: 'd1',
  label: 'Personal',
  expiresAt: null,
  ...over,
});

describe('createIdentityPersistence', () => {
  it('round-trips the store', () => {
    const p = createIdentityPersistence({ filePath: tempFile() });
    const state = upsertIdentity(createIdentityStoreState(), privateId('u1'));
    p.save(state);
    const loaded = p.load();
    expect(loaded.activeUserId).toBe('u1');
    expect(loaded.accounts[0].identities[0].token).toBe('t-u1');
  });

  it('returns a fresh state when the file is missing or corrupt', () => {
    const p = createIdentityPersistence({ filePath: tempFile() });
    expect(p.load()).toEqual(createIdentityStoreState());
  });

  it('applies redaction before writing', () => {
    const p = createIdentityPersistence({
      filePath: tempFile(),
      redact: (s) => ({ ...s, accounts: [] }),
    });
    p.save(upsertIdentity(createIdentityStoreState(), privateId('u1')));
    expect(p.load().accounts).toHaveLength(0);
  });

  it('prunes expired sessions on load', () => {
    const file = tempFile();
    const p = createIdentityPersistence({ filePath: file });
    p.save(
      upsertIdentity(
        createIdentityStoreState(),
        privateId('u1', { expiresAt: '2020-01-01T00:00:00.000Z' }),
      ),
    );
    expect(p.load().accounts).toHaveLength(0);
  });
});
