import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLogger,
  createNullLogger,
  formatLogLine,
  levelEnabled,
  normalizeLogLevel,
  rotatedName,
  shouldRotate,
  type LogRecord,
} from './logger.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'nexus-log-'));
}

describe('pure logging helpers', () => {
  it('normalises an unknown level to the fallback', () => {
    expect(normalizeLogLevel('warn')).toBe('warn');
    expect(normalizeLogLevel('trace')).toBe('info');
    expect(normalizeLogLevel(undefined, 'error')).toBe('error');
  });

  it('ranks levels for the min-level filter', () => {
    expect(levelEnabled('debug', 'info')).toBe(false);
    expect(levelEnabled('info', 'info')).toBe(true);
    expect(levelEnabled('error', 'warn')).toBe(true);
  });

  it('formats a single JSON line with level, timestamp, source and message', () => {
    const record: LogRecord = { t: '2026-01-02T03:04:05.000Z', level: 'info', source: 'audit', msg: 'hi' };
    const line = formatLogLine(record);
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toMatchObject({ t: record.t, level: 'info', source: 'audit', msg: 'hi' });
  });

  it('redacts secrets in structured data', () => {
    const line = formatLogLine({ t: 't', level: 'info', source: 's', msg: 'm', data: { token: 'abc123' } });
    expect(line).not.toContain('abc123');
  });

  it('rotates only once the file passes the cap', () => {
    expect(shouldRotate(10, 100)).toBe(false);
    expect(shouldRotate(100, 100)).toBe(true);
    expect(shouldRotate(1_000_000, 0)).toBe(false);
  });

  it('names rotated generations predictably', () => {
    expect(rotatedName('desktop.log', 1)).toBe('desktop.log.1');
  });
});

describe('createLogger — file sink', () => {
  it('appends structured lines to the log file', () => {
    const dir = tmpDir();
    const logger = createLogger({ dir, sink: () => undefined });
    logger.info('hello', { n: 1 });
    logger.warn('careful');

    const lines = readFileSync(logger.filePath(), 'utf8').trim().split('\n');
    // First line is the "logger ready" record.
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed.some((r) => r.msg === 'hello' && r.level === 'info')).toBe(true);
    expect(parsed.some((r) => r.msg === 'careful' && r.level === 'warn')).toBe(true);
  });

  it('drops lines below the configured min level', () => {
    const dir = tmpDir();
    const seen: string[] = [];
    const logger = createLogger({ dir, minLevel: 'warn', sink: (line) => seen.push(line) });
    logger.debug('nope');
    logger.info('nope');
    logger.error('yes');
    expect(seen.some((l) => l.includes('"msg":"yes"'))).toBe(true);
    expect(seen.some((l) => l.includes('nope'))).toBe(false);
  });

  it('exposes a child logger that stamps the source', () => {
    const dir = tmpDir();
    const seen: string[] = [];
    const child = createLogger({ dir, sink: (line) => seen.push(line) }).child('audit');
    child.info('child line');
    const last = JSON.parse(seen[seen.length - 1]!) as Record<string, unknown>;
    expect(last.source).toBe('audit');
  });
});

describe('createNullLogger', () => {
  it('never throws and reports no file', () => {
    const logger = createNullLogger();
    expect(() => {
      logger.info('x');
      logger.child('y').error('z');
    }).not.toThrow();
    expect(logger.filePath()).toBe('');
    expect(logger.sizeBytes()).toBe(0);
  });
});
