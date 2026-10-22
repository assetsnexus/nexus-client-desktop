/**
 * Minimal `.env` loader for local development.
 *
 * The desktop client ships pointing at the sandbox region. When working against
 * a locally-running region node + portal, hand-editing `settings.json` in
 * `userData` is awkward — this lets a checked-out `.env` (or exported shell
 * vars) redirect the client, mirroring how the region node and portal already
 * read their own `.env`.
 *
 * Deliberately dependency-free and side-effect-free (it *returns* the parsed
 * map rather than mutating `process.env`) so it stays testable and bundles
 * cleanly into the Electron main process. Precedence, highest first:
 *
 *   1. real environment variables (an explicit `export` always wins)
 *   2. the `.env` file
 *   3. built-in sandbox defaults (see `resolveConnectionConfig`)
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type DotenvMap = Record<string, string>;

/**
 * Parse `.env` content. Supports `KEY=value`, `export KEY=value`, `#` comments,
 * blank lines, single/double quoting, and `\n`/`\t`/`\\`/`\"` escapes inside
 * double quotes. Values are taken literally — no variable interpolation, so a
 * password containing `$` is never silently mangled.
 */
export function parseDotenv(content: string): DotenvMap {
  const out: DotenvMap = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    // Tolerate `export KEY=value` (common when a file is also `source`d).
    const body = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value
        .slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      // Single quotes are literal in dotenv semantics.
      value = value.slice(1, -1);
    } else {
      // Unquoted: strip a trailing inline comment (` # …`).
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/** Read and parse a `.env` file. Returns `{}` when the file is absent/unreadable. */
export function loadDotenvFile(path: string): DotenvMap {
  try {
    if (!existsSync(path)) return {};
    return parseDotenv(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

export type ConnectionEnv = {
  regionUrl?: string | null;
  portalUrl?: string | null;
  gatewayUrl?: string | null;
  customCaPem?: string | null;
};

/**
 * Candidate `.env` locations, most specific first.
 *
 * Electron's `app.getAppPath()` is not dependable for locating a repo file: it
 * is derived from the entry script's directory, which for the dev launcher is
 * `dist-electron/` and can even fall back to the OS temp dir. So we try the app
 * directory, the main bundle's parent, and the current working directory.
 * `NEXUS_ENV_FILE` short-circuits everything when set.
 *
 * Returns `null` when nothing matches, so the caller can skip cleanly.
 */
export function resolveEnvFilePath(options: {
  envFileVar?: string | null;
  appPath: string;
  mainDir: string;
  cwd: string;
  exists?: (path: string) => boolean;
}): string | null {
  const exists = options.exists ?? existsSync;
  const explicit = options.envFileVar?.trim();
  if (explicit) return exists(explicit) ? explicit : null;
  const candidates = [
    join(options.appPath, '.env'),
    // `mainDir` is dist-electron/, so its parent is the app directory.
    join(options.mainDir, '..', '.env'),
    join(options.cwd, '.env'),
  ];
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * The subset of connection keys the environment can supply, all non-null. Only
 * keys actually present are set, so this drops straight into
 * `setConnectionConfig` without clobbering saved settings.
 */
export type ConnectionEnvPatch = {
  regionUrl?: string;
  portalUrl?: string;
  gatewayUrl?: string;
  customCaPem?: string;
};

/**
 * Map `NEXUS_*` env vars onto the connection config. Only defined, non-empty
 * values are returned so a blank var never blanks out a real setting.
 *
 * `NEXUS_CUSTOM_CA_PEM` may hold PEM contents directly, or a path to a PEM file
 * (convenient when the CA is a long multi-line bundle).
 */
export function connectionFromEnv(env: DotenvMap): ConnectionEnv {
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = env[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
  };
  const ca = pick('NEXUS_CUSTOM_CA_PEM', 'NEXUS_CUSTOM_CA_FILE');
  let customCaPem: string | null = ca;
  if (ca && !ca.includes('-----BEGIN') && existsSync(ca)) {
    try {
      customCaPem = readFileSync(ca, 'utf8');
    } catch {
      customCaPem = ca;
    }
  }
  return {
    regionUrl: pick('NEXUS_REGION_URL', 'ANX_REGION_URL'),
    portalUrl: pick('NEXUS_PORTAL_URL', 'ANX_PORTAL_URL'),
    gatewayUrl: pick('NEXUS_GATEWAY_URL', 'ANX_GATEWAY_URL'),
    customCaPem,
  };
}

/**
 * Merge the environment over the persisted config, with real `process.env`
 * winning over the `.env` file. Returns a patch suitable for
 * `setConnectionConfig`; only keys the environment actually supplied appear, so
 * a user's saved settings survive an unrelated `.env`.
 */
export function connectionPatchFromEnv(
  fileEnv: DotenvMap,
  processEnv: NodeJS.ProcessEnv = process.env,
): ConnectionEnvPatch {
  const merged: DotenvMap = { ...fileEnv };
  // Real environment overrides the file for the keys we care about.
  for (const key of Object.keys(fileEnv)) {
    const live = processEnv[key];
    if (typeof live === 'string' && live.trim()) merged[key] = live.trim();
  }
  const fromEnv = connectionFromEnv(merged);
  const patch: ConnectionEnvPatch = {};
  for (const [key, value] of Object.entries(fromEnv) as Array<[keyof ConnectionEnv, string | null]>) {
    if (value != null) patch[key] = value;
  }
  return patch;
}
