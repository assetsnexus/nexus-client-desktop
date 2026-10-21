/**
 * `@nexus/client-tools` — client-side tool runtime.
 *
 * Shared by the Electron desktop main process and the `nexus` CLI. Everything
 * here is OS-level, not UI-level, so both hosts reuse it verbatim. The main
 * process is the security boundary: the workspace sandbox and bash policy are
 * authoritative and cannot be bypassed from the renderer/agent.
 */

export {
  createWorkspaceRegistry,
  isInside,
  resolveWithinWorkspace,
  type SandboxDenyReason,
  type SandboxResult,
  type WorkspaceMode,
  type WorkspaceRegistry,
  type WorkspaceRoot,
} from './workspace.js';

export {
  DANGEROUS_PATTERNS,
  DEFAULT_BASH_POLICY,
  evaluateBashCommand,
  type BashPolicy,
  type BashRule,
  type GateDecision,
} from './bash-policy.js';

export {
  runBash,
  type BashExecutorOptions,
  type BashRunRequest,
  type BashRunResult,
} from './bash.js';

export {
  deleteFile,
  editFile,
  hashContent,
  readFile,
  readRevision,
  writeFile,
  type EditFileOptions,
  type FileOpResult,
  type FileRevision,
  type ReadFileOptions,
  type WriteFileOptions,
} from './fs.js';

export {
  CPU_GPU_LOAD_SKILL,
  DEFAULT_LOCAL_COMMAND_SKILLS,
  createLocalCommandRegistry,
  type LocalCommand,
  type LocalCommandRegistry,
  type LocalCommandSkill,
  type SkillOs,
} from './local-commands.js';
