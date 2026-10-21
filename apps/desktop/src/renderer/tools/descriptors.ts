/**
 * Client-tool descriptors registered on the chat controller.
 *
 * These ride the existing paused-turn rail: the descriptor declares schema +
 * `access` (a UI hint only), and the handler forwards to the Electron main
 * process, which is the authoritative security boundary.
 */

import { bridge, type ToolInvocation, type ToolInvocationResult } from '../bridge.js';

export type ChatToolDescriptor = {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** UI hint mapping onto Ask/Plan/Agent. Never a security control. */
  access: 'read' | 'write';
};

export type RegisteredTool = {
  descriptor: ChatToolDescriptor;
  handler: (args: unknown) => Promise<ToolInvocationResult>;
};

function forward(name: string, args: unknown): Promise<ToolInvocationResult> {
  const payload: ToolInvocation = { name, ...(args as Record<string, unknown>) };
  return bridge.runTool(payload);
}

export const SHELL_RUN_TOOL: RegisteredTool = {
  descriptor: {
    name: 'app.shell.run',
    description:
      'Run a local command in an allowed workspace directory. Commands are spawned as argv arrays (never a shell string). Denied patterns and unapproved commands are refused by the main process.',
    parameters: {
      type: 'object',
      properties: {
        argv: {
          type: 'array',
          items: { type: 'string' },
          description: 'Program and arguments, e.g. ["npm","test"].',
        },
        cwd: { type: 'string', description: 'Working directory inside an allowed workspace.' },
        timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds.' },
      },
      required: ['argv'],
    },
    access: 'write',
  },
  handler: (args) => forward('app.shell.run', args),
};

export const FS_READ_TOOL: RegisteredTool = {
  descriptor: {
    name: 'app.fs.read',
    description: 'Read a file inside an allowed workspace root.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute file path.' } },
      required: ['path'],
    },
    access: 'read',
  },
  handler: (args) => forward('app.fs.read', args),
};

export const FS_LIST_TOOL: RegisteredTool = {
  descriptor: {
    name: 'app.fs.list',
    description: 'List a directory inside an allowed workspace root.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute directory path.' } },
      required: ['path'],
    },
    access: 'read',
  },
  handler: (args) => forward('app.fs.list', args),
};

export const FS_WRITE_TOOL: RegisteredTool = {
  descriptor: {
    name: 'app.fs.write',
    description:
      'Write a file inside a read-write workspace root. Refuses to clobber a file whose revision changed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        expectedRevision: { type: 'object', description: 'Optional {mtimeMs,sha256,sizeBytes} guard.' },
      },
      required: ['path', 'content'],
    },
    access: 'write',
  },
  handler: (args) => forward('app.fs.write', args),
};

export const FS_EDIT_TOOL: RegisteredTool = {
  descriptor: {
    name: 'app.fs.edit',
    description:
      'Replace a unique exact string in a file inside a read-write workspace root. Fails on ambiguous or missing matches.',
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
  handler: (args) => forward('app.fs.edit', args),
};

export const DEFAULT_DESKTOP_TOOLS: RegisteredTool[] = [
  SHELL_RUN_TOOL,
  FS_READ_TOOL,
  FS_LIST_TOOL,
  FS_WRITE_TOOL,
  FS_EDIT_TOOL,
];

/**
 * Descriptors for the user's local-command skills, so the agent can invoke a
 * named skill the user manages. These are `read` when the skill is read-only.
 */
export function localCommandTools(
  skills: Array<{ skillId: string; title: string; oneLiner: string; commands: Array<{ os: string; access: 'read' | 'write' }> }>,
): RegisteredTool[] {
  return skills.map((skill) => {
    const access = skill.commands.every((c) => c.access === 'read') ? 'read' : 'write';
    return {
      descriptor: {
        name: `app.local.${skill.skillId}`,
        description: `${skill.oneLiner} (user-managed local command skill)`,
        parameters: { type: 'object', properties: {} },
        access,
      },
      handler: () => forward('app.shell.run-skill', { skillId: skill.skillId }),
    } satisfies RegisteredTool;
  });
}
