import { describe, expect, it } from 'vitest';
import {
  ANY_AGENT,
  normalizeWorkspaceRoot,
  rootGrantsAgent,
  rootsForAgent,
  type WorkspaceRoot,
} from './workspace.js';
import { previewPathAccess } from './access.js';

const root = (over: Partial<WorkspaceRoot> & Pick<WorkspaceRoot, 'id' | 'path'>): WorkspaceRoot => ({
  label: over.label ?? over.id,
  mode: 'read-write',
  ...over,
});

describe('normalizeWorkspaceRoot (ACL migration)', () => {
  it('treats a missing agentContactIds as "every agent"', () => {
    const out = normalizeWorkspaceRoot(root({ id: 'a', path: '/srv/a' }));
    expect(out.agentContactIds).toEqual([ANY_AGENT]);
  });

  it('keeps explicit ids and drops blanks', () => {
    const out = normalizeWorkspaceRoot(
      root({ id: 'a', path: '/srv/a', agentContactIds: ['c1', '', 'c2'] }),
    );
    expect(out.agentContactIds).toEqual(['c1', 'c2']);
  });

  it('falls back to everyone when the list is empty', () => {
    expect(normalizeWorkspaceRoot(root({ id: 'a', path: '/srv/a', agentContactIds: [] })).agentContactIds).toEqual([
      ANY_AGENT,
    ]);
  });
});

describe('rootGrantsAgent', () => {
  it('grants everyone when the root lists *', () => {
    const r = root({ id: 'a', path: '/srv/a', agentContactIds: [ANY_AGENT] });
    expect(rootGrantsAgent(r, 'anyone')).toBe(true);
    expect(rootGrantsAgent(r, null)).toBe(true);
  });

  it('grants only the listed ids otherwise', () => {
    const r = root({ id: 'a', path: '/srv/a', agentContactIds: ['c1'] });
    expect(rootGrantsAgent(r, 'c1')).toBe(true);
    expect(rootGrantsAgent(r, 'c2')).toBe(false);
    // No id => no private root.
    expect(rootGrantsAgent(r, null)).toBe(false);
  });
});

describe('rootsForAgent', () => {
  const roots: WorkspaceRoot[] = [
    root({ id: 'shared', path: '/srv/shared', agentContactIds: [ANY_AGENT] }),
    root({ id: 'only-c1', path: '/srv/c1', agentContactIds: ['c1'] }),
    root({ id: 'only-c2', path: '/srv/c2', agentContactIds: ['c2'] }),
  ];

  it('returns shared + the agent’s own roots', () => {
    expect(rootsForAgent(roots, 'c1').map((r) => r.id)).toEqual(['shared', 'only-c1']);
  });

  it('returns only shared roots when the agent id is missing (fail closed)', () => {
    expect(rootsForAgent(roots, null).map((r) => r.id)).toEqual(['shared']);
    expect(rootsForAgent(roots, '').map((r) => r.id)).toEqual(['shared']);
  });

  it("treats the 'any' caller as every root that grants someone", () => {
    expect(rootsForAgent(roots, 'any').map((r) => r.id)).toEqual(['shared', 'only-c1', 'only-c2']);
  });
});

describe('previewPathAccess', () => {
  it('reports the covering roots and their reach', () => {
    const preview = previewPathAccess('/srv/shared/project/file.ts', [
      root({ id: 'shared', path: '/srv/shared', agentContactIds: [ANY_AGENT] }),
      root({ id: 'elsewhere', path: '/srv/other', agentContactIds: ['c9'] }),
    ]);
    expect(preview.reachable).toBe(true);
    expect(preview.granted).toHaveLength(1);
    expect(preview.granted[0].rootId).toBe('shared');
    expect(preview.granted[0].everyone).toBe(true);
    expect(preview.granted[0].agentContactIds).toEqual([]);
  });

  it('lists explicit agents when the root is not shared with everyone', () => {
    const preview = previewPathAccess('/srv/c1/x', [
      root({ id: 'c1', path: '/srv/c1', agentContactIds: ['c1', 'c2'] }),
    ]);
    expect(preview.granted[0].everyone).toBe(false);
    expect(preview.granted[0].agentContactIds).toEqual(['c1', 'c2']);
  });

  it('is unreachable when no root covers the path', () => {
    const preview = previewPathAccess('/etc/passwd', [root({ id: 'shared', path: '/srv/shared' })]);
    expect(preview.reachable).toBe(false);
    expect(preview.granted).toEqual([]);
  });
});
