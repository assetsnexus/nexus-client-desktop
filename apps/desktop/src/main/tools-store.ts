/**
 * Persisted client-tool configuration: the workspace registry and the
 * user-managed local command skills. Plain JSON in `userData` (no secrets).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import {
  DEFAULT_LOCAL_COMMAND_SKILLS,
  type LocalCommandSkill,
  type WorkspaceRoot,
} from '@nexus/client-tools';

export type ToolsConfig = {
  workspaces: WorkspaceRoot[];
  localCommands: LocalCommandSkill[];
};

export type ToolsStore = {
  get(): ToolsConfig;
  setWorkspaces(workspaces: WorkspaceRoot[]): ToolsConfig;
  setLocalCommands(localCommands: LocalCommandSkill[]): ToolsConfig;
};

export function createToolsStore(filePath?: string): ToolsStore {
  const path = filePath ?? join(app.getPath('userData'), 'client-tools.json');

  const read = (): ToolsConfig => {
    const empty: ToolsConfig = { workspaces: [], localCommands: DEFAULT_LOCAL_COMMAND_SKILLS };
    if (!existsSync(path)) return empty;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<ToolsConfig>;
      return {
        workspaces: Array.isArray(raw.workspaces) ? raw.workspaces : [],
        localCommands: Array.isArray(raw.localCommands)
          ? raw.localCommands
          : DEFAULT_LOCAL_COMMAND_SKILLS,
      };
    } catch {
      return empty;
    }
  };

  const write = (value: ToolsConfig): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
  };

  return {
    get: read,
    setWorkspaces(workspaces) {
      const next = { ...read(), workspaces };
      write(next);
      return next;
    },
    setLocalCommands(localCommands) {
      const next = { ...read(), localCommands };
      write(next);
      return next;
    },
  };
}
