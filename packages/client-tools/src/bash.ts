/**
 * Gated bash executor.
 *
 * Runs a command **only** as an argv array (never `shell: true`), with:
 * - a working directory constrained to an allowed workspace root,
 * - a hard timeout that kills the child,
 * - an env allowlist (nothing else is passed through),
 * - captured + truncated stdout/stderr.
 *
 * The policy gate ({@link evaluateBashCommand}) is applied before spawning; the
 * caller decides whether to prompt for `ask`.
 */

import { spawn } from 'node:child_process';
import { resolveWithinWorkspace, type WorkspaceRoot } from './workspace.js';
import { DEFAULT_BASH_POLICY, evaluateBashCommand, type BashPolicy } from './bash-policy.js';

export type BashRunRequest = {
  /** argv[0] is the program, the rest are arguments. Never a shell string. */
  argv: string[];
  cwd: string;
  timeoutMs?: number;
  envAllowlist?: string[];
};

export type BashRunResult = {
  ok: boolean;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  /** Set when the gate or sandbox refused before spawning. */
  denied?: 'deny' | 'sandbox';
  reason?: string;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'USER', 'SHELL', 'TMPDIR'];
const MAX_OUTPUT_BYTES = 64 * 1024;

export type BashExecutorOptions = {
  roots: WorkspaceRoot[];
  policy?: BashPolicy;
  /** Called when the gate says `ask`; resolve true to allow. */
  confirm?: (command: string, reason?: string) => Promise<boolean>;
  runFn?: typeof spawn;
};

function buildEnv(allowlist: string[]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of allowlist) {
    if (process.env[key] != null) out[key] = process.env[key];
  }
  return out;
}

function truncate(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= MAX_OUTPUT_BYTES) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_OUTPUT_BYTES)}\n…[truncated]`, truncated: true };
}

/**
 * Evaluate the gate, then run. `deny` never spawns. `ask` consults `confirm`.
 */
export async function runBash(
  req: BashRunRequest,
  options: BashExecutorOptions,
): Promise<BashRunResult> {
  const command = req.argv.join(' ');
  const policy = options.policy ?? DEFAULT_BASH_POLICY;
  const gate = evaluateBashCommand(command, policy);

  if (gate.decision === 'deny') {
    return denyResult(command, gate.reason ?? 'denied by policy');
  }
  if (gate.decision === 'ask') {
    const confirmed = options.confirm ? await options.confirm(command, gate.reason) : false;
    if (!confirmed) return denyResult(command, 'not approved');
  }

  const sandbox = resolveWithinWorkspace(req.cwd, options.roots, 'read');
  if (!sandbox.ok) {
    return {
      ok: false,
      command,
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      truncated: false,
      denied: 'sandbox',
      reason: sandbox.message,
    };
  }

  const spawnFn = options.runFn ?? spawn;
  const [program, ...args] = req.argv;
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<BashRunResult>((resolve) => {
    const child = spawnFn(program, args, {
      cwd: sandbox.realPath,
      env: buildEnv(req.envAllowlist ?? DEFAULT_ENV_ALLOWLIST),
      shell: false,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        command,
        exitCode: null,
        stdout: '',
        stderr: err.message,
        timedOut: false,
        truncated: false,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const out = truncate(stdout);
      const err = truncate(stderr);
      resolve({
        ok: code === 0 && !timedOut,
        command,
        exitCode: code,
        stdout: out.text,
        stderr: err.text,
        timedOut,
        truncated: out.truncated || err.truncated,
      });
    });
  });
}

function denyResult(command: string, reason: string): BashRunResult {
  return {
    ok: false,
    command,
    exitCode: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    truncated: false,
    denied: 'deny',
    reason,
  };
}
