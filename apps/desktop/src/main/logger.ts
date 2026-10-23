/**
 * Structured, file-backed local logger for the desktop **main** process.
 *
 * Replaces ad-hoc `console.*` noise with one predictable sink: newline-delimited
 * JSON under `<userData>/logs/`, so every line carries a level, an ISO
 * timestamp, a named source and (optional, redacted) structured data. The file
 * rotates by size so a long-running (tray-resident) app can never fill the disk.
 *
 * The pure parts — `formatLogLine`, `shouldRotate`, `normalizeLogLevel` — are
 * exported separately and unit-tested without touching the filesystem.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { redactValue } from '../shared/redaction.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** Numeric rank so a `minLevel` filter is a single comparison. */
const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function normalizeLogLevel(raw: unknown, fallback: LogLevel = 'info'): LogLevel {
  return typeof raw === 'string' && (LOG_LEVELS as readonly string[]).includes(raw)
    ? (raw as LogLevel)
    : fallback;
}

/** True when `level` should be emitted given the configured `minLevel`. */
export function levelEnabled(level: LogLevel, minLevel: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[minLevel];
}

export type LogRecord = {
  /** ISO-8601 timestamp. */
  t: string;
  level: LogLevel;
  /** Named subsystem, e.g. `audit`, `tools`, `main`. */
  source: string;
  msg: string;
  /** Optional structured context (redacted before it is serialised). */
  data?: unknown;
};

/**
 * Render one log line. Pure: same record → same string. Always a single line
 * (embedded newlines in `msg`/`data` are escaped by JSON), so a tail reader can
 * split on `\n`.
 */
export function formatLogLine(record: LogRecord): string {
  const payload: Record<string, unknown> = {
    t: record.t,
    level: record.level,
    source: record.source,
    msg: record.msg,
  };
  if (record.data !== undefined) payload.data = redactValue(record.data);
  return `${JSON.stringify(payload)}\n`;
}

/** Rotate once the active file exceeds `maxBytes` (0 disables rotation). */
export function shouldRotate(sizeBytes: number, maxBytes: number): boolean {
  return maxBytes > 0 && sizeBytes >= maxBytes;
}

/** `desktop.log` → `desktop.log.1`; the oldest generation is dropped. */
export function rotatedName(fileName: string, generation: number): string {
  return `${fileName}.${generation}`;
}

export type LoggerSink = (line: string) => void;

export type LoggerOptions = {
  /** Directory the log file lives in. Defaults to `<cwd>/logs`. */
  dir?: string;
  /** Base file name. Defaults to `desktop.log`. */
  fileName?: string;
  /** Rotate the active file past this size. Defaults to 5 MiB. */
  maxFileBytes?: number;
  /** How many rotated generations to keep. Defaults to 3. */
  maxFiles?: number;
  /** Minimum level to emit. Defaults to `info`. */
  minLevel?: LogLevel;
  /** Where lines go once formatted (injectable for tests). */
  sink?: LoggerSink;
};

export type Logger = {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  /** A child logger that stamps every line with the same `source`. */
  child(source: string): Logger;
  /** Absolute path of the active log file (for the UI to show). */
  filePath(): string;
  /** Last-known size of the active file, bytes. */
  sizeBytes(): number;
};

const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 3;

/**
 * Create the file-backed logger. `dir` defaults to a `logs` folder beside the
 * caller's working directory; the main process passes `app.getPath('userData')`.
 */
export function createLogger(options: LoggerOptions = {}, source = 'main'): Logger {
  const dir = options.dir ?? join(process.cwd(), 'logs');
  const fileName = options.fileName ?? 'desktop.log';
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const minLevel = options.minLevel ?? 'info';
  const sink: LoggerSink =
    options.sink ??
    ((line) => {
      try {
        // stderr keeps the log stream separate from the app's own stdout chat.
        process.stderr.write(line);
      } catch {
        /* a broken stream must never crash logging */
      }
    });

  const filePath = join(dir, fileName);
  let size = 0;
  try {
    mkdirSync(dir, { recursive: true });
    size = existsSync(filePath) ? statSync(filePath).size : 0;
  } catch {
    /* fall back to a best-effort append below */
  }

  const rotate = (): void => {
    try {
      for (let generation = maxFiles - 1; generation >= 1; generation -= 1) {
        const from = join(dir, rotatedName(fileName, generation));
        const to = join(dir, rotatedName(fileName, generation + 1));
        if (existsSync(from)) renameSync(from, to);
      }
      if (existsSync(filePath)) renameSync(filePath, join(dir, rotatedName(fileName, 1)));
      const stale = join(dir, rotatedName(fileName, maxFiles + 1));
      if (existsSync(stale)) rmSync(stale, { force: true });
    } catch {
      /* rotation is best-effort; never block a log write */
    }
    size = 0;
  };

  const write = (record: LogRecord): void => {
    const line = formatLogLine(record);
    try {
      if (shouldRotate(size, maxFileBytes)) rotate();
      appendFileSync(filePath, line, 'utf8');
      size += Buffer.byteLength(line);
    } catch {
      /* a full disk must not take the app down */
    }
    sink(line);
  };

  const make = (name: string): Logger => ({
    debug(msg, data) {
      if (levelEnabled('debug', minLevel)) write({ t: new Date().toISOString(), level: 'debug', source: name, msg, data });
    },
    info(msg, data) {
      if (levelEnabled('info', minLevel)) write({ t: new Date().toISOString(), level: 'info', source: name, msg, data });
    },
    warn(msg, data) {
      if (levelEnabled('warn', minLevel)) write({ t: new Date().toISOString(), level: 'warn', source: name, msg, data });
    },
    error(msg, data) {
      if (levelEnabled('error', minLevel)) write({ t: new Date().toISOString(), level: 'error', source: name, msg, data });
    },
    child(childSource) {
      return make(childSource);
    },
    filePath: () => filePath,
    sizeBytes: () => size,
  });

  const root = make(source);
  root.info('logger ready', { file: filePath, minLevel, maxFileBytes, maxFiles });
  return root;
}

/** A logger that writes nothing; handy as a default so callers never null-check. */
export function createNullLogger(): Logger {
  const noop = (): void => undefined;
  const self: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => self,
    filePath: () => '',
    sizeBytes: () => 0,
  };
  return self;
}
