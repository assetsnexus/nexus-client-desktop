/**
 * Bash gating policy.
 *
 * Mirrors the region's `autoApproveRules` shape (`{ commandPattern, action }`):
 * an allow list of exact/pattern commands, an explicit deny list for dangerous
 * patterns, and a default of "ask". Evaluation is pure and dependency-free so it
 * is easy to unit-test and reused verbatim by the desktop main process and CLI.
 *
 * Safety: commands are spawned as argv arrays (never `shell: true` with a
 * concatenated string). This module only decides *whether* a command may run.
 */

export type GateDecision = 'allow' | 'deny' | 'ask';

export type BashRule = {
  /** Regex source matched against the full command string. */
  commandPattern: string;
  action: Exclude<GateDecision, 'ask'>;
  /** Optional human note surfaced to the user. */
  reason?: string;
};

export type BashPolicy = {
  allow: BashRule[];
  deny: BashRule[];
  /** Decision when no rule matches. Defaults to `ask`. */
  fallback: GateDecision;
};

/**
 * Conservative denials applied even when the user has a permissive allow list.
 * Hard security floor: these never auto-allow.
 */
export const DANGEROUS_PATTERNS: BashRule[] = [
  { commandPattern: '\\brm\\s+-rf\\s+/', action: 'deny', reason: 'recursive delete from root' },
  { commandPattern: '\\bmkfs\\b', action: 'deny', reason: 'filesystem format' },
  { commandPattern: '\\bdd\\b.*of=/dev/', action: 'deny', reason: 'raw device write' },
  { commandPattern: ':\\s*\\(\\s*\\)\\s*\\{', action: 'deny', reason: 'fork bomb shape' },
  { commandPattern: '\\bcurl\\b.*\\|\\s*(sh|bash)\\b', action: 'deny', reason: 'pipe-to-shell' },
  { commandPattern: '\\bwget\\b.*\\|\\s*(sh|bash)\\b', action: 'deny', reason: 'pipe-to-shell' },
  { commandPattern: '\\bchmod\\s+-R\\s+777\\b', action: 'deny', reason: 'world-writable recursive' },
  { commandPattern: '>/dev/sd[a-z]', action: 'deny', reason: 'raw disk redirect' },
];

export const DEFAULT_BASH_POLICY: BashPolicy = {
  allow: [
    { commandPattern: '^git status$', action: 'allow' },
    { commandPattern: '^git diff( .*)?$', action: 'allow' },
    { commandPattern: '^git log( .*)?$', action: 'allow' },
    { commandPattern: '^npm (test|run (test|build|lint))( .*)?$', action: 'allow' },
    { commandPattern: '^ls( .*)?$', action: 'allow' },
    { commandPattern: '^cat [^|;&]+$', action: 'allow' },
  ],
  deny: [],
  fallback: 'ask',
};

function matches(pattern: string, command: string): boolean {
  try {
    return new RegExp(pattern).test(command);
  } catch {
    return false; // a malformed rule never grants access
  }
}

/**
 * Decide whether `command` may run. Deny always wins; then allow; then fallback.
 * The dangerous-pattern floor is applied first and cannot be overridden.
 */
export function evaluateBashCommand(command: string, policy: BashPolicy): {
  decision: GateDecision;
  reason?: string;
} {
  const cmd = command.trim();
  if (!cmd) return { decision: 'deny', reason: 'empty command' };

  for (const rule of DANGEROUS_PATTERNS) {
    if (matches(rule.commandPattern, cmd)) return { decision: 'deny', reason: rule.reason };
  }
  for (const rule of policy.deny) {
    if (matches(rule.commandPattern, cmd)) return { decision: 'deny', reason: rule.reason };
  }
  for (const rule of policy.allow) {
    if (matches(rule.commandPattern, cmd)) return { decision: 'allow', reason: rule.reason };
  }
  return { decision: policy.fallback };
}
