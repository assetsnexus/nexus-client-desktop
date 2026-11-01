/**
 * Agent filesystem-access preview (pure).
 *
 * The Access surface answers "which agents can reach this path / bucket / mount
 * / sync dir?" without touching disk or the renderer: it intersects a plain path
 * with the workspace-root catalog and reports the covering roots plus the agents
 * each one grants. Agent reachability is always local (a mountpoint / sync dir is
 * just a directory), so a cloud workspace is previewed through the local dirs it
 * is projected to.
 */

import { ANY_AGENT, isInside, normalizeWorkspaceRoot, type WorkspaceRoot } from './workspace.js';

/** One covering root and the agents it grants (expanded from `*` when known). */
export type AccessGrant = {
  rootId: string;
  label: string;
  path: string;
  mode: WorkspaceRoot['mode'];
  /** True when the root grants every agent (`*`). */
  everyone: boolean;
  /** Explicit contact ids; empty when `everyone` is set. */
  agentContactIds: string[];
};

export type PathAccessPreview = {
  path: string;
  /** Roots whose path contains `path` (or equals it). */
  granted: AccessGrant[];
  /**
   * True when at least one root covers the path. When false the path sits
   * outside every allowed root and no agent can reach it.
   */
  reachable: boolean;
};

function toGrant(root: WorkspaceRoot): AccessGrant {
  const normalized = normalizeWorkspaceRoot(root);
  const ids = normalized.agentContactIds ?? [];
  const everyone = ids.includes(ANY_AGENT);
  return {
    rootId: normalized.id,
    label: normalized.label,
    path: normalized.path,
    mode: normalized.mode,
    everyone,
    agentContactIds: everyone ? [] : ids,
  };
}

/**
 * Which roots cover `path`, and which agents each grants. Containment uses the
 * same normalized comparison as the sandbox (`isInside`), so the preview cannot
 * claim a path the sandbox would refuse.
 */
export function previewPathAccess(path: string, roots: WorkspaceRoot[]): PathAccessPreview {
  const target = String(path ?? '').trim();
  const granted = roots
    .map(normalizeWorkspaceRoot)
    .filter((r) => target.length > 0 && isInside(target, r.path))
    .map(toGrant);
  return { path: target, granted, reachable: granted.length > 0 };
}

/** The full preview set for a bucket projected onto local dirs (mounts/syncs). */
export function previewLocalDirsAccess(
  dirs: Array<{ path: string }>,
  roots: WorkspaceRoot[],
): PathAccessPreview[] {
  return dirs.map((d) => previewPathAccess(d.path, roots));
}
