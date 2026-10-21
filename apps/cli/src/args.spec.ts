import { describe, expect, it } from 'vitest';
import { buildAgentPicker, parseArgs } from './args.js';

const CWD = '/work/project';

describe('parseArgs', () => {
  it('defaults to interactive with no args', () => {
    expect(parseArgs([], CWD)).toEqual({ kind: 'interactive', cwd: CWD });
  });

  it('parses help/version/whoami', () => {
    expect(parseArgs(['--help'], CWD).kind).toBe('help');
    expect(parseArgs(['-v'], CWD).kind).toBe('version');
    expect(parseArgs(['whoami'], CWD).kind).toBe('whoami');
  });

  it('parses run with a prompt', () => {
    const cmd = parseArgs(['run', 'explain', 'this', 'repo'], CWD);
    expect(cmd).toEqual({
      kind: 'run',
      prompt: 'explain this repo',
      agentId: undefined,
      conversationId: undefined,
      json: false,
      cwd: CWD,
    });
  });

  it('parses run flags', () => {
    const cmd = parseArgs(['run', 'hi', '--agent', 'a1', '--json'], CWD);
    expect(cmd.kind).toBe('run');
    if (cmd.kind === 'run') {
      expect(cmd.agentId).toBe('a1');
      expect(cmd.json).toBe(true);
    }
  });

  it('errors when run has no prompt', () => {
    const cmd = parseArgs(['run', '--agent', 'a1'], CWD);
    expect(cmd.kind).toBe('error');
  });

  it('errors when a value flag has no value', () => {
    const cmd = parseArgs(['run', 'hi', '--agent'], CWD);
    expect(cmd.kind).toBe('error');
    if (cmd.kind === 'error') expect(cmd.message).toContain('--agent');
  });

  it('parses an interactive --agent', () => {
    const cmd = parseArgs(['--agent', 'a1'], CWD);
    expect(cmd).toEqual({ kind: 'interactive', agentId: 'a1', cwd: CWD });
  });

  it('errors on an unknown command', () => {
    expect(parseArgs(['frobnicate'], CWD).kind).toBe('error');
  });
});

describe('buildAgentPicker', () => {
  it('lists contacts then virtual employees with 1-based indices', () => {
    const entries = buildAgentPicker(
      [{ id: 'c1', displayName: 'Alice' }],
      [{ id: 'e1', name: 'Selene' }],
    );
    expect(entries).toEqual([
      { index: 1, id: 'c1', label: 'Alice', kind: 'contact' },
      { index: 2, id: 'e1', label: 'Selene', kind: 'virtual_employee' },
    ]);
  });

  it('falls back to id when no name is present', () => {
    expect(buildAgentPicker([{ id: 'c1' }], [])[0].label).toBe('c1');
  });
});
