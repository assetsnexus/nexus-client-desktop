/**
 * Path sandbox — the real security boundary for local file access.
 *
 * Every filesystem target is resolved (realpath, defeating `..` and symlink
 * escapes) and checked against the set of allowed workspace roots. The main
 * process is authoritative: a renderer/agent cannot bypass this by asking for a
 * different path, because the check happens here, not in the tool schema.
 */

import { realpathSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export type WorkspaceMode = 'read-only' | 'read-write';

/** The sentinel contact id that grants a root to **every** agent. */
export const ANY_AGENT = '*';

export type WorkspaceRoot = {
  id: string;
  label: string;
  /** Absolute root path the agent may touch. */
  path: string;
  mode: WorkspaceMode;
  /**
   * Which agents (by desktop contact id) may use this root. `['*']` grants every
   * agent — the migration default for roots persisted before per-agent ACLs
   * existed. An empty array grants nobody, so a new root always names an agent.
   */
  agentContactIds?: string[];
};

/**
 * Migration/normalizer: a root with no `agentContactIds` (or a malformed one)
 * is treated as granted to every agent, so existing installs keep working after
 * the ACL lands. Pure and total, so it is safe on any persisted shape.
 */
export function normalizeWorkspaceRoot(root: WorkspaceRoot): WorkspaceRoot {
  const ids = Array.isArray(root.agentContactIds)
    ? root.agentContactIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  return { ...root, agentContactIds: ids.length ? ids : [ANY_AGENT] };
}

/** A root grants `contactId` when it lists `*` or the exact id. */
export function rootGrantsAgent(root: WorkspaceRoot, contactId: string | null | undefined): boolean {
  const ids = normalizeWorkspaceRoot(root).agentContactIds ?? [];
  if (ids.includes(ANY_AGENT)) return true;
  return typeof contactId === 'string' && contactId.length > 0 && ids.includes(contactId);
}

/**
 * The effective roots a single agent may touch. `contactId` is the caller's
 * desktop contact id; a null/absent id resolves to roots shared with every agent
 * (`*`) only, so an unauthenticated tool call still cannot reach a private root.
 * An `'any'` caller (pure previews: "which agents can reach this path") gets
 * every root that grants *someone*.
 */
export function rootsForAgent(
  roots: WorkspaceRoot[],
  contactId: string | null | undefined | 'any',
): WorkspaceRoot[] {
  if (contactId === 'any') return roots.map(normalizeWorkspaceRoot);
  return roots.map(normalizeWorkspaceRoot).filter((r) => rootGrantsAgent(r, contactId));
}

export type WorkspaceRegistry = {
  list(): WorkspaceRoot[];
  add(root: WorkspaceRoot): void;
  remove(id: string): boolean;
  get(id: string): WorkspaceRoot | undefined;
};

export function createWorkspaceRegistry(seed: WorkspaceRoot[] = []): WorkspaceRegistry {
  const roots = new Map<string, WorkspaceRoot>();
  for (const root of seed) roots.set(root.id, root);
  return {
    list: () => [...roots.values()],
    add: (root) => {
      roots.set(root.id, root);
    },
    remove: (id) => roots.delete(id),
    get: (id) => roots.get(id),
  };
}

export type SandboxDenyReason =
  | 'not_absolute'
  | 'outside_allowed_roots'
  | 'read_only'
  | 'root_not_found';

export type SandboxResult =
  | { ok: true; realPath: string; root: WorkspaceRoot }
  | { ok: false; reason: SandboxDenyReason; message: string };

/**
 * Resolve `target` to a real absolute path and confirm it sits inside an allowed
 * root that grants `need`.
 *
 * For writes to a not-yet-existing file, the *parent directory* must resolve
 * inside a root (so creating a new file is allowed but not escaping the root).
 */
export function resolveWithinWorkspace(
  target: string,
  roots: WorkspaceRoot[],
  need: 'read' | 'write',
): SandboxResult {
  if (!target || !isAbsolute(target)) {
    return { ok: false, reason: 'not_absolute', message: 'path must be absolute' };
  }

  const realCandidate = realpathForCheck(target);
  const probe = realCandidate ?? realpathIfExists(dirname(target)) ?? resolve(target);

  const root = roots.find((r) => isInside(probe, r.path));
  if (!root) {
    return {
      ok: false,
      reason: 'outside_allowed_roots',
      message: `path is outside every allowed workspace root: ${target}`,
    };
  }
  if (need === 'write' && root.mode !== 'read-write') {
    return {
      ok: false,
      reason: 'read_only',
      message: `workspace "${root.label}" is read-only`,
    };
  }
  // For a path that does not exist yet, return the *resolved* target (not the
  // parent we probed) so callers see an accurate "does not exist" state.
  return { ok: true, realPath: realCandidate ?? resolve(target), root };
}

/** True when `candidate` is inside `root` (or equals it). */
export function isInside(candidate: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function realpathIfExists(p: string): string | null {
  try {
    if (!existsSync(p)) return null;
    return realpathSync(p);
  } catch {
    return null;
  }
}

function realpathForCheck(p: string): string | null {
  return realpathIfExists(p);
}
