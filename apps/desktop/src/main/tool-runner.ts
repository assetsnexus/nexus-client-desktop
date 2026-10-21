/**
 * Main-process client-tool runner.
 *
 * Authoritative execution path for the gated shell and sandboxed file tools. The
 * renderer/agent can only *request* a tool; the policy and workspace checks here
 * decide whether it runs. Approval for `write`/`ask` happens in the renderer via
 * the chat approval card, but a deny here always wins.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  deleteFile,
  editFile,
  readFile,
  resolveWithinWorkspace,
  runBash,
  writeFile,
  type BashPolicy,
  type FileRevision,
} from '@nexus/client-tools';
import type { ToolsStore } from './tools-store.js';

export type ToolRequest =
  | { name: 'app.shell.run'; argv: string[]; cwd?: string; timeoutMs?: number }
  | { name: 'app.shell.run-skill'; skillId: string; os?: string }
  | { name: 'app.fs.read'; path: string }
  | { name: 'app.fs.list'; path: string }
  | { name: 'app.fs.write'; path: string; content: string; expectedRevision?: FileRevision | null }
  | { name: 'app.fs.edit'; path: string; oldText: string; newText: string; expectedRevision?: FileRevision | null }
  | { name: 'app.fs.delete'; path: string };

export type ToolResult = {
  ok: boolean;
  data?: unknown;
  error?: string;
};

export type ToolRunnerOptions = {
  store: ToolsStore;
  policy?: BashPolicy;
  /** Renderer-provided confirmation for `ask` commands (from the approval card). */
  confirm?: (command: string, reason?: string) => Promise<boolean>;
};

export async function runTool(
  req: ToolRequest,
  options: ToolRunnerOptions,
): Promise<ToolResult> {
  const { workspaces } = options.store.get();
  try {
    switch (req.name) {
      case 'app.shell.run': {
        const cwd =
          req.cwd ??
          workspaces[0]?.path ??
          '';
        const result = await runBash(
          { argv: req.argv, cwd, timeoutMs: req.timeoutMs },
          { roots: workspaces, policy: options.policy, confirm: options.confirm },
        );
        return { ok: result.ok, data: result, error: result.ok ? undefined : result.reason };
      }
      case 'app.shell.run-skill': {
        const { localCommands } = options.store.get();
        const os = (req.os as 'linux' | 'darwin' | 'win32') ?? process.platform;
        const skill = localCommands.find((s) => s.skillId === req.skillId);
        const variant = skill?.commands.find((c) => c.os === os);
        if (!variant) return { ok: false, error: `no command for ${os} in skill ${req.skillId}` };
        const cwd = variant.cwd ?? workspaces[0]?.path ?? '';
        const result = await runBash(
          { argv: variant.argv, cwd, envAllowlist: variant.envAllowlist },
          {
            roots: workspaces,
            policy:
              variant.access === 'read'
                ? { allow: [{ commandPattern: '.*', action: 'allow' }], deny: [], fallback: 'allow' }
                : options.policy,
            confirm: options.confirm,
          },
        );
        return { ok: result.ok, data: result, error: result.ok ? undefined : result.reason };
      }
      case 'app.fs.read': {
        const result = readFile(req.path, { roots: workspaces });
        return result.ok
          ? { ok: true, data: result.value }
          : { ok: false, error: result.reason };
      }
      case 'app.fs.list': {
        const sandbox = resolveWithinWorkspace(req.path, workspaces, 'read');
        if (!sandbox.ok) return { ok: false, error: sandbox.message };
        if (!existsSync(sandbox.realPath)) return { ok: false, error: 'path not found' };
        const entries = readdirSync(sandbox.realPath).map((name) => {
          const full = join(sandbox.realPath, name);
          const stat = statSync(full);
          return {
            name,
            path: full,
            isDirectory: stat.isDirectory(),
            sizeBytes: stat.size,
            mtimeMs: stat.mtimeMs,
          };
        });
        return { ok: true, data: entries };
      }
      case 'app.fs.write': {
        const result = writeFile(req.path, req.content, {
          roots: workspaces,
          expectedRevision: req.expectedRevision,
        });
        return result.ok ? { ok: true, data: result.value } : { ok: false, error: result.reason };
      }
      case 'app.fs.edit': {
        const result = editFile(req.path, {
          roots: workspaces,
          oldText: req.oldText,
          newText: req.newText,
          expectedRevision: req.expectedRevision,
        });
        return result.ok ? { ok: true, data: result.value } : { ok: false, error: result.reason };
      }
      case 'app.fs.delete': {
        const result = deleteFile(req.path, { roots: workspaces });
        if (!result.ok) return { ok: false, error: result.reason };
        const { unlinkSync } = await import('node:fs');
        unlinkSync(req.path);
        return { ok: true, data: { deleted: req.path } };
      }
      default:
        return { ok: false, error: `unknown tool: ${(req as { name: string }).name}` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'tool failed' };
  }
}

/** Ensure a directory exists inside an allowed workspace (used by the UI). */
export function ensureWorkspaceDir(path: string, store: ToolsStore): ToolResult {
  const { workspaces } = store.get();
  const sandbox = resolveWithinWorkspace(path, workspaces, 'write');
  if (!sandbox.ok) return { ok: false, error: sandbox.message };
  mkdirSync(sandbox.realPath, { recursive: true });
  return { ok: true, data: { path: sandbox.realPath } };
}
