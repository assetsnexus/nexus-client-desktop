/**
 * User-managed local command skills.
 *
 * A "skill" here is a named, per-OS local command the user owns (the "custom
 * user manages skill" requirement). It bundles onto the existing skill shape
 * (`skillId`, `title`, `oneLiner`, `triggerHints`, `body`, `suggestedTools`)
 * rather than inventing a new one, and can optionally be published via
 * `anx.oauth2.app.skills.register`.
 */

export type SkillOs = 'linux' | 'darwin' | 'win32';

export type LocalCommand = {
  id: string;
  label: string;
  /** Which OS this variant targets. */
  os: SkillOs;
  /** argv array, never a shell string. */
  argv: string[];
  cwd?: string;
  envAllowlist?: string[];
  access: 'read' | 'write';
  approval: 'auto' | 'ask';
};

export type LocalCommandSkill = {
  skillId: string;
  title: string;
  oneLiner: string;
  triggerHints: string[];
  body: string;
  suggestedTools: string[];
  commands: LocalCommand[];
};

export type LocalCommandRegistry = {
  list(): LocalCommandSkill[];
  register(skill: LocalCommandSkill): void;
  remove(skillId: string): boolean;
  get(skillId: string): LocalCommandSkill | undefined;
  /** The command within a skill matching `os`, if any. */
  resolve(skillId: string, os: SkillOs): LocalCommand | undefined;
};

export function createLocalCommandRegistry(
  seed: LocalCommandSkill[] = [],
): LocalCommandRegistry {
  const skills = new Map<string, LocalCommandSkill>();
  for (const skill of seed) skills.set(skill.skillId, skill);
  return {
    list: () => [...skills.values()],
    register: (skill) => {
      skills.set(skill.skillId, skill);
    },
    remove: (skillId) => skills.delete(skillId),
    get: (skillId) => skills.get(skillId),
    resolve: (skillId, os) => skills.get(skillId)?.commands.find((c) => c.os === os),
  };
}

/**
 * Reference skill shipped with the app: CPU + GPU load.
 * One skill, one command per OS. Registered `access: 'read'` so it runs without
 * an approval card in Plan mode.
 */
export const CPU_GPU_LOAD_SKILL: LocalCommandSkill = {
  skillId: 'system.cpu-gpu-load',
  title: 'CPU + GPU load',
  oneLiner: 'Report current CPU load average and NVIDIA GPU utilization/memory.',
  triggerHints: ['cpu load', 'gpu load', 'system load', 'is the machine busy'],
  body:
    'Reads the OS load average and, when NVIDIA tooling is present, `nvidia-smi` ' +
    'GPU utilization and memory usage. Read-only; safe to run without approval.',
  suggestedTools: ['app.shell.run'],
  commands: [
    {
      id: 'system.cpu-gpu-load.linux',
      label: 'CPU + GPU load (Linux)',
      os: 'linux',
      argv: [
        'sh',
        '-c',
        'cat /proc/loadavg; command -v nvidia-smi >/dev/null && nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv || echo "nvidia-smi not available"',
      ],
      access: 'read',
      approval: 'auto',
    },
    {
      id: 'system.cpu-gpu-load.win32',
      label: 'CPU + GPU load (Windows)',
      os: 'win32',
      argv: [
        'powershell',
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Processor | Select-Object -ExpandProperty LoadPercentage; if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) { nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv } else { "nvidia-smi not available" }',
      ],
      access: 'read',
      approval: 'auto',
    },
    {
      id: 'system.cpu-gpu-load.darwin',
      label: 'CPU + GPU load (macOS)',
      os: 'darwin',
      argv: [
        'sh',
        '-c',
        'sysctl -n vm.loadavg; if command -v nvidia-smi >/dev/null; then nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv; else echo "no NVIDIA GPU on this macOS host"; fi',
      ],
      access: 'read',
      approval: 'auto',
    },
  ],
};

/** Default skill set seeded into a fresh install. */
export const DEFAULT_LOCAL_COMMAND_SKILLS: LocalCommandSkill[] = [CPU_GPU_LOAD_SKILL];
