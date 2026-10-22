/**
 * Speech-engine binary catalog (@nexus/local-voice).
 *
 * The local wake-word engine (`stt_phrase`) and the on-device STT lifecycle both
 * need an actual *executable* — whisper.cpp's `whisper-server` — not just the
 * GGML model weights. The model downloader already fetches the weights, but the
 * runner binary was left to be installed manually on the system `PATH`, which is
 * the step users get stuck on.
 *
 * This module is the pure, dependency-free description of *where to get that
 * binary* for each platform, plus the honest manual instructions when no
 * prebuilt exists. The main process performs the download/extract/chmod; this
 * module only decides what should be fetched and how to tell the user.
 *
 * Availability reality (checked against upstream):
 *  - Linux x64 / arm64: prebuilt `whisper-server` tarballs ✓
 *  - Windows x64 / arm64:  prebuilt `whisper-server.exe` zips ✓
 *  - macOS: **no** prebuilt server binary (the `.xcframework` is for embedding,
 *    and Homebrew builds with `-DWHISPER_BUILD_SERVER=OFF`, so `brew install
 *    whisper.cpp` provides only `whisper-cli`). macOS therefore falls back to
 *    manual instructions / a custom endpoint.
 */

/** The only runner binary we currently provision. */
export type VoiceBinaryId = 'whisper-server';

export type VoiceBinaryArchive = 'tar.gz' | 'zip';

/** One downloadable, platform-specific binary bundle. */
export type VoiceBinaryAsset = {
  id: VoiceBinaryId;
  platform: NodeJS.Platform;
  /** `x64` | `arm64` (Node's `process.arch`). */
  arch: string;
  /** Direct release-asset URL. */
  url: string;
  archive: VoiceBinaryArchive;
  /** Expected download size, for the progress bar (best-effort). */
  sizeBytes: number | null;
  /**
   * Candidate executable base names inside the archive, most-likely first. The
   * extractor picks the shallowest match so a helper in a subfolder cannot win.
   */
  executableNames: string[];
  /** Human label for the settings row. */
  label: string;
};

/**
 * whisper.cpp publishes per-commit *build* releases (e.g. `b5454`); the semver
 * tags (`v1.9.5`) carry no binary assets at all. We therefore pin the latest
 * build release that ships the widest platform matrix.
 */
export const WHISPER_CPP_BUILD_TAG = 'b5454';

const RELEASE_BASE = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CPP_BUILD_TAG}`;

/** The executable base name for a platform (`whisper-server.exe` on Windows). */
export function voiceBinaryFileName(
  id: VoiceBinaryId = 'whisper-server',
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32' ? `${id}.exe` : id;
}

/**
 * Every binary bundle we know how to install. Keyed implicitly by
 * platform+arch via {@link resolveVoiceBinaryAsset}.
 */
export const VOICE_BINARY_ASSETS: VoiceBinaryAsset[] = [
  {
    id: 'whisper-server',
    platform: 'linux',
    arch: 'x64',
    url: `${RELEASE_BASE}/whisper-bin-ubuntu-x64.tar.gz`,
    archive: 'tar.gz',
    sizeBytes: 10_364_195,
    executableNames: ['whisper-server'],
    label: 'whisper.cpp server (Linux x64)',
  },
  {
    id: 'whisper-server',
    platform: 'linux',
    arch: 'arm64',
    url: `${RELEASE_BASE}/whisper-bin-ubuntu-arm64.tar.gz`,
    archive: 'tar.gz',
    sizeBytes: 4_608_377,
    executableNames: ['whisper-server'],
    label: 'whisper.cpp server (Linux arm64)',
  },
  {
    id: 'whisper-server',
    platform: 'win32',
    arch: 'x64',
    url: `${RELEASE_BASE}/whisper-bin-x64.zip`,
    archive: 'zip',
    sizeBytes: 8_928_640,
    executableNames: ['whisper-server.exe', 'whisper-server'],
    label: 'whisper.cpp server (Windows x64)',
  },
  {
    id: 'whisper-server',
    platform: 'win32',
    arch: 'arm64',
    url: `${RELEASE_BASE}/whisper-bin-win-cpu-arm64.zip`,
    archive: 'zip',
    sizeBytes: 4_371_193,
    executableNames: ['whisper-server.exe', 'whisper-server'],
    label: 'whisper.cpp server (Windows arm64)',
  },
];

/**
 * The asset for a platform/arch, or null when no prebuilt binary is published
 * (notably macOS). Never guesses a mismatched build.
 */
export function resolveVoiceBinaryAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  id: VoiceBinaryId = 'whisper-server',
): VoiceBinaryAsset | null {
  return (
    VOICE_BINARY_ASSETS.find((a) => a.id === id && a.platform === platform && a.arch === arch) ?? null
  );
}

/** True when a one-click in-app install is possible on this platform/arch. */
export function canAutoInstallVoiceBinary(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  return resolveVoiceBinaryAsset(platform, arch) !== null;
}

export type VoiceBinaryInstructions = {
  /** The command a user would run in a terminal, when one exists. */
  command: string | null;
  /** Ordered, human steps. Always non-empty. */
  steps: string[];
  /** True when the platform has no prebuilt runner and manual setup is required. */
  manualRequired: boolean;
  /** Where the binary must end up for the desktop to find it. */
  expectsOnPath: string;
};

/**
 * Honest, per-OS setup instructions for a user who cannot (or prefers not to)
 * use the one-click installer. Kept here so the UI and any docs show the same
 * text, and so the macOS dead-end is stated plainly instead of implied.
 */
export function voiceBinaryInstructions(
  platform: NodeJS.Platform = process.platform,
): VoiceBinaryInstructions {
  const bin = voiceBinaryFileName('whisper-server', platform);
  switch (platform) {
    case 'linux':
      return {
        command: 'sudo apt install whisper.cpp   # or build from source',
        steps: [
          'Prefer the “Install” button above — it downloads the official whisper.cpp build into this app’s data folder.',
          'If you install it yourself, put `whisper-server` on your PATH (e.g. `~/.local/bin`).',
          'Build from source: `git clone https://github.com/ggml-org/whisper.cpp && cd whisper.cpp && cmake -B build -DWHISPER_BUILD_SERVER=ON && cmake --build build -j`',
          `Make sure \`${bin}\` runs: \`${bin} --help\`.`,
        ],
        manualRequired: false,
        expectsOnPath: bin,
      };
    case 'darwin':
      return {
        command: 'brew install whisper-cpp   # provides whisper-cli, NOT whisper-server',
        steps: [
          'macOS has no official prebuilt `whisper-server` binary, and Homebrew’s whisper.cpp formula is built without the server, so it installs `whisper-cli` only.',
          'Option A (recommended): build the server yourself — `git clone https://github.com/ggml-org/whisper.cpp && cd whisper.cpp && cmake -B build -DWHISPER_BUILD_SERVER=ON && cmake --build build -j`',
          `Then put the built \`${bin}\` on your PATH (e.g. copy it to /usr/local/bin) and confirm \`${bin} --help\` works.`,
          'Option B: run a local OpenAI/Whisper-compatible server (e.g. in Docker) and configure it under “Custom endpoints” instead — wake detection stays on-device either way.',
        ],
        manualRequired: true,
        expectsOnPath: bin,
      };
    case 'win32':
      return {
        command: null,
        steps: [
          'Prefer the “Install” button above — it downloads the official whisper.cpp build into this app’s data folder.',
          'To do it by hand: download `whisper-bin-x64.zip` (CPU) from the whisper.cpp releases page.',
          `Keep \`${bin}\` together with the DLLs from the same zip (they must sit in the same folder), and add that folder to your PATH.`,
        ],
        manualRequired: false,
        expectsOnPath: bin,
      };
    default:
      return {
        command: null,
        steps: [
          'Prebuilt runners are published for Linux and Windows only.',
          'Build whisper.cpp from source with `-DWHISPER_BUILD_SERVER=ON` and put the binary on your PATH.',
          'Alternatively, point the app at a local Whisper-compatible server under “Custom endpoints”.',
        ],
        manualRequired: true,
        expectsOnPath: bin,
      };
  }
}
