/**
 * CLI argument parsing. Pure and dependency-free so it is easy to test.
 *
 * Usage:
 *   nexus                          # interactive: pick an agent, then REPL
 *   nexus run "prompt" --agent <id> [--json] [--conversation <id>]
 *   nexus whoami
 *   nexus --help
 */

export type CliCommand =
  | { kind: 'interactive'; agentId?: string; cwd: string }
  | { kind: 'run'; prompt: string; agentId?: string; conversationId?: string; json: boolean; cwd: string }
  | { kind: 'whoami' }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'error'; message: string };

export function parseArgs(argv: string[], cwd: string): CliCommand {
  if (argv.length === 0) return { kind: 'interactive', cwd };

  const [first, ...rest] = argv;
  if (first === '--help' || first === '-h' || first === 'help') return { kind: 'help' };
  if (first === '--version' || first === '-v' || first === 'version') return { kind: 'version' };
  if (first === 'whoami') return { kind: 'whoami' };

  if (first === 'run') {
    const flags = parseFlags(rest);
    if (flags.error) return { kind: 'error', message: flags.error };
    if (!flags.positional.length) {
      return { kind: 'error', message: 'run requires a prompt, e.g. nexus run "explain this repo"' };
    }
    return {
      kind: 'run',
      prompt: flags.positional.join(' '),
      agentId: flags.values.agent,
      conversationId: flags.values.conversation,
      json: flags.booleans.has('json'),
      cwd,
    };
  }

  if (first.startsWith('--')) {
    const flags = parseFlags(argv);
    if (flags.error) return { kind: 'error', message: flags.error };
    return { kind: 'interactive', agentId: flags.values.agent, cwd };
  }

  return { kind: 'error', message: `unknown command: ${first}` };
}

type ParsedFlags = {
  positional: string[];
  values: Record<string, string | undefined>;
  booleans: Set<string>;
  error?: string;
};

function parseFlags(argv: string[]): ParsedFlags {
  const positional: string[] = [];
  const values: Record<string, string | undefined> = {};
  const booleans = new Set<string>();
  const VALUE_FLAGS = new Set(['agent', 'conversation']);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (VALUE_FLAGS.has(key)) {
        const next = argv[i + 1];
        if (next == null || next.startsWith('--')) {
          return { positional, values, booleans, error: `--${key} requires a value` };
        }
        values[key] = next;
        i++;
      } else {
        booleans.add(key);
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, values, booleans };
}

export const HELP_TEXT = `Nexus CLI — talk to your agents from the terminal

Usage:
  nexus                                   Pick an agent, then chat (REPL)
  nexus --agent <id>                      Open a specific agent directly
  nexus run "<prompt>" [--agent <id>] [--json]
                                          One-shot, non-interactive
  nexus whoami                            Show the signed-in identity
  nexus --version | --help

The current directory is registered as the session workspace, so the agent can
read and (with approval) edit files in it.`;

/** Format contacts + virtual employees into a numbered picker list. */
export type PickerEntry = { index: number; id: string; label: string; kind: string };

export function buildAgentPicker(
  contacts: Array<{ id: string; name?: string; displayName?: string; kind?: string }>,
  employees: Array<{ id: string; name?: string; displayName?: string }>,
): PickerEntry[] {
  const entries: PickerEntry[] = [];
  let index = 0;
  for (const c of contacts) {
    entries.push({
      index: ++index,
      id: c.id,
      label: c.displayName || c.name || c.id,
      kind: c.kind || 'contact',
    });
  }
  for (const e of employees) {
    entries.push({
      index: ++index,
      id: e.id,
      label: e.displayName || e.name || e.id,
      kind: 'virtual_employee',
    });
  }
  return entries;
}
