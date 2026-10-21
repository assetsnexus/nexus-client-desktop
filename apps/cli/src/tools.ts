/**
 * CLI client-tool runtime.
 *
 * The CLI reuses `@nexus/client-tools` verbatim: the same workspace sandbox,
 * gated bash executor, and file tools the Electron main process uses. The cwd
 * is registered as the session workspace, so the agent can read and (with
 * approval) edit files here — the exact same security boundary, no duplication.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_LOCAL_COMMAND_SKILLS,
  deleteFile,
  editFile,
  readFile,
  resolveWithinWorkspace,
  runBash,
  writeFile,
  type BashPolicy,
  type FileRevision,
  type LocalCommandSkill,
  type WorkspaceRoot,
} from '@nexus/client-tools';
import { unlinkSync } from 'node:fs';

export type ToolDescriptor = {
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  access: 'read' | 'write';
};

export type RegisteredTool = {
  descriptor: ToolDescriptor;
  handler: (args: unknown) => Promise<unknown>;
};

export type CliToolsOptions = {
  /** Workspace roots; the CLI seeds the cwd as read-write. */
  workspaces: WorkspaceRoot[];
  policy?: BashPolicy;
  localCommands?: LocalCommandSkill[];
  /** Resolve a gate `ask` to a decision (the terminal approval rail). */
  confirm: (command: string, reason?: string) => Promise<boolean>;
  platform?: NodeJS.Platform;
};

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** Build the same tool surface the desktop exposes, backed by client-tools. */
export function buildCliTools(options: CliToolsOptions): RegisteredTool[] {
  const platform = options.platform ?? process.platform;
  const skills = options.localCommands ?? DEFAULT_LOCAL_COMMAND_SKILLS;
  const cwdDefault = options.workspaces[0]?.path ?? process.cwd();

  const tools: RegisteredTool[] = [
    {
      descriptor: {
        name: 'app.shell.run',
        description:
          'Run a local command in the session workspace. Spawned as an argv array (never a shell string); denied patterns and unapproved commands are refused.',
        parameters: {
          type: 'object',
          properties: {
            argv: { type: 'array', items: { type: 'string' } },
            cwd: { type: 'string' },
            timeoutMs: { type: 'number' },
          },
          required: ['argv'],
        },
        access: 'write',
      },
      handler: async (args) => {
        const a = asRecord(args);
        const result = await runBash(
          {
            argv: asStringArray(a.argv),
            cwd: typeof a.cwd === 'string' ? a.cwd : cwdDefault,
            timeoutMs: typeof a.timeoutMs === 'number' ? a.timeoutMs : undefined,
          },
          { roots: options.workspaces, policy: options.policy, confirm: options.confirm },
        );
        if (!result.ok) throw new Error(result.reason ?? 'command failed');
        return result;
      },
    },
    {
      descriptor: {
        name: 'app.fs.read',
        description: 'Read a file inside the session workspace.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        access: 'read',
      },
      handler: async (args) => {
        const a = asRecord(args);
        const result = readFile(String(a.path ?? ''), { roots: options.workspaces });
        if (!result.ok) throw new Error(result.reason);
        return result.value;
      },
    },
    {
      descriptor: {
        name: 'app.fs.list',
        description: 'List a directory inside the session workspace.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        access: 'read',
      },
      handler: async (args) => {
        const a = asRecord(args);
        const sandbox = resolveWithinWorkspace(String(a.path ?? ''), options.workspaces, 'read');
        if (!sandbox.ok) throw new Error(sandbox.message);
        if (!existsSync(sandbox.realPath)) throw new Error('path not found');
        return readdirSync(sandbox.realPath).map((name) => {
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
      },
    },
    {
      descriptor: {
        name: 'app.fs.write',
        description:
          'Write a file inside the session workspace. Refuses to clobber a file whose revision changed.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
            expectedRevision: { type: 'object' },
          },
          required: ['path', 'content'],
        },
        access: 'write',
      },
      handler: async (args) => {
        const a = asRecord(args);
        const result = writeFile(String(a.path ?? ''), String(a.content ?? ''), {
          roots: options.workspaces,
          expectedRevision: (a.expectedRevision as FileRevision | null) ?? null,
        });
        if (!result.ok) throw new Error(result.reason);
        return result.value;
      },
    },
    {
      descriptor: {
        name: 'app.fs.edit',
        description: 'Replace a unique exact string in a workspace file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            oldText: { type: 'string' },
            newText: { type: 'string' },
            expectedRevision: { type: 'object' },
          },
          required: ['path', 'oldText', 'newText'],
        },
        access: 'write',
      },
      handler: async (args) => {
        const a = asRecord(args);
        const result = editFile(String(a.path ?? ''), {
          roots: options.workspaces,
          oldText: String(a.oldText ?? ''),
          newText: String(a.newText ?? ''),
          expectedRevision: (a.expectedRevision as FileRevision | null) ?? null,
        });
        if (!result.ok) throw new Error(result.reason);
        return result.value;
      },
    },
    {
      descriptor: {
        name: 'app.fs.delete',
        description: 'Delete a workspace file.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        access: 'write',
      },
      handler: async (args) => {
        const a = asRecord(args);
        const target = String(a.path ?? '');
        const result = deleteFile(target, { roots: options.workspaces });
        if (!result.ok) throw new Error(result.reason);
        unlinkSync(target);
        return { deleted: target };
      },
    },
  ];

  for (const skill of skills) {
    const variant = skill.commands.find((c) => c.os === platform);
    if (!variant) continue;
    tools.push({
      descriptor: {
        name: `app.local.${skill.skillId}`,
        description: `${skill.oneLiner} (user-managed local command skill)`,
        parameters: { type: 'object', properties: {} },
        access: variant.access,
      },
      handler: async () => {
        const result = await runBash(
          {
            argv: variant.argv,
            cwd: variant.cwd ?? cwdDefault,
            envAllowlist: variant.envAllowlist,
          },
          {
            roots: options.workspaces,
            policy:
              variant.access === 'read'
                ? { allow: [{ commandPattern: '.*', action: 'allow' }], deny: [], fallback: 'allow' }
                : options.policy,
            confirm: options.confirm,
          },
        );
        if (!result.ok) throw new Error(result.reason ?? 'skill command failed');
        return result;
      },
    });
  }

  return tools;
}
