import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  connectionFromEnv,
  connectionPatchFromEnv,
  loadDotenvFile,
  parseDotenv,
  resolveEnvFilePath,
} from './dotenv.js';

describe('parseDotenv', () => {
  it('parses plain, quoted and exported assignments', () => {
    const parsed = parseDotenv(
      [
        '# a comment',
        '',
        'NEXUS_REGION_URL=http://localhost:3005',
        'export NEXUS_PORTAL_URL="http://localhost:8080"',
        "SINGLE='keep $literal'",
      ].join('\n'),
    );
    expect(parsed.NEXUS_REGION_URL).toBe('http://localhost:3005');
    expect(parsed.NEXUS_PORTAL_URL).toBe('http://localhost:8080');
    expect(parsed.SINGLE).toBe('keep $literal');
  });

  it('strips inline comments only when unquoted', () => {
    const parsed = parseDotenv(['A=value # note', 'B="value # kept"'].join('\n'));
    expect(parsed.A).toBe('value');
    expect(parsed.B).toBe('value # kept');
  });

  it('decodes escapes inside double quotes but not single quotes', () => {
    const parsed = parseDotenv(['A="line1\\nline2"', "B='line1\\nline2'"].join('\n'));
    expect(parsed.A).toBe('line1\nline2');
    expect(parsed.B).toBe('line1\\nline2');
  });

  it('ignores malformed lines and bad keys', () => {
    const parsed = parseDotenv(['no-equals', '=novalue', '1BAD=x', 'GOOD=1'].join('\n'));
    expect(parsed).toEqual({ GOOD: '1' });
  });

  it('keeps a value containing = intact', () => {
    expect(parseDotenv('TOKEN=a=b=c').TOKEN).toBe('a=b=c');
  });
});

describe('connectionFromEnv', () => {
  it('maps NEXUS_* vars and prefers NEXUS_ over ANX_', () => {
    const cfg = connectionFromEnv({
      NEXUS_REGION_URL: 'http://localhost:3005',
      ANX_REGION_URL: 'http://ignored:1',
      NEXUS_PORTAL_URL: 'http://localhost:8080',
    });
    expect(cfg.regionUrl).toBe('http://localhost:3005');
    expect(cfg.portalUrl).toBe('http://localhost:8080');
    expect(cfg.gatewayUrl).toBeNull();
  });

  it('reads a CA from a file path when the value is not inline PEM', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-ca-'));
    const pem = join(dir, 'ca.pem');
    writeFileSync(pem, '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n');
    const cfg = connectionFromEnv({ NEXUS_CUSTOM_CA_PEM: pem });
    expect(cfg.customCaPem).toContain('BEGIN CERTIFICATE');
  });

  it('passes inline PEM through unchanged', () => {
    const inline = '-----BEGIN CERTIFICATE-----\nxyz\n-----END CERTIFICATE-----';
    expect(connectionFromEnv({ NEXUS_CUSTOM_CA_PEM: inline }).customCaPem).toBe(inline);
  });

  it('treats blank values as unset', () => {
    const cfg = connectionFromEnv({ NEXUS_REGION_URL: '   ', NEXUS_PORTAL_URL: '' });
    expect(cfg.regionUrl).toBeNull();
    expect(cfg.portalUrl).toBeNull();
  });
});

describe('connectionPatchFromEnv', () => {
  it('lets the real process env win over the .env file', () => {
    const patch = connectionPatchFromEnv(
      { NEXUS_REGION_URL: 'http://from-file:3005' },
      { NEXUS_REGION_URL: 'http://from-shell:3005' } as NodeJS.ProcessEnv,
    );
    expect(patch.regionUrl).toBe('http://from-shell:3005');
  });

  it('omits keys the environment did not supply', () => {
    const patch = connectionPatchFromEnv({ NEXUS_REGION_URL: 'http://localhost:3005' }, {});
    expect(patch).toEqual({ regionUrl: 'http://localhost:3005' });
    expect('portalUrl' in patch).toBe(false);
  });

  it('returns an empty patch when nothing is configured', () => {
    expect(connectionPatchFromEnv({}, {})).toEqual({});
  });
});

describe('resolveEnvFilePath', () => {
  const existsIn = (set: string[]) => (p: string) => set.includes(p);

  it('honours NEXUS_ENV_FILE when it exists', () => {
    const resolved = resolveEnvFilePath({
      envFileVar: '/custom/.env',
      appPath: '/app',
      mainDir: '/app/dist-electron',
      cwd: '/work',
      exists: existsIn(['/custom/.env']),
    });
    expect(resolved).toBe('/custom/.env');
  });

  it('returns null when NEXUS_ENV_FILE points at a missing file', () => {
    const resolved = resolveEnvFilePath({
      envFileVar: '/custom/missing.env',
      appPath: '/app',
      mainDir: '/app/dist-electron',
      cwd: '/work',
      exists: existsIn(['/app/.env']),
    });
    expect(resolved).toBeNull();
  });

  it('falls back to the main bundle parent when appPath is bogus', () => {
    const resolved = resolveEnvFilePath({
      appPath: '/tmp',
      mainDir: '/repo/apps/desktop/dist-electron',
      cwd: '/elsewhere',
      exists: existsIn(['/repo/apps/desktop/.env']),
    });
    expect(resolved).toBe('/repo/apps/desktop/.env');
  });

  it('falls back to cwd as a last resort', () => {
    const resolved = resolveEnvFilePath({
      appPath: '/tmp',
      mainDir: '/nope/dist-electron',
      cwd: '/work',
      exists: existsIn(['/work/.env']),
    });
    expect(resolved).toBe('/work/.env');
  });

  it('returns null when no candidate exists', () => {
    expect(
      resolveEnvFilePath({
        appPath: '/tmp',
        mainDir: '/nope/dist-electron',
        cwd: '/work',
        exists: () => false,
      }),
    ).toBeNull();
  });
});

describe('loadDotenvFile', () => {
  it('reads a file and returns {} when missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-env-'));
    const file = join(dir, '.env');
    writeFileSync(file, 'NEXUS_REGION_URL=http://localhost:3005\n');
    expect(loadDotenvFile(file).NEXUS_REGION_URL).toBe('http://localhost:3005');
    expect(loadDotenvFile(join(dir, 'nope.env'))).toEqual({});
  });
});
