import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCliTools } from './tools.js';

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-tools-'));
  writeFileSync(join(dir, 'hello.txt'), 'hi there', 'utf8');
  mkdirSync(join(dir, 'sub'));
  return realpathSync(dir);
}

const noConfirm = async () => false;

describe('buildCliTools', () => {
  it('exposes the shell + fs tools and a skill tool', () => {
    const tools = buildCliTools({
      workspaces: [{ id: 'cwd', label: 'cwd', path: workspace(), mode: 'read-write' }],
      confirm: noConfirm,
      platform: 'linux',
    });
    const names = tools.map((t) => t.descriptor.name);
    expect(names).toContain('app.shell.run');
    expect(names).toContain('app.fs.read');
    expect(names).toContain('app.fs.write');
    expect(names).toContain('app.fs.edit');
    expect(names).toContain('app.local.system.cpu-gpu-load');
  });

  it('reads a file inside the workspace', async () => {
    const root = workspace();
    const tools = buildCliTools({
      workspaces: [{ id: 'cwd', label: 'cwd', path: root, mode: 'read-write' }],
      confirm: noConfirm,
      platform: 'linux',
    });
    const read = tools.find((t) => t.descriptor.name === 'app.fs.read')!;
    const result = (await read.handler({ path: join(root, 'hello.txt') })) as { content: string };
    expect(result.content).toBe('hi there');
  });

  it('rejects a path outside the workspace', async () => {
    const root = workspace();
    const tools = buildCliTools({
      workspaces: [{ id: 'cwd', label: 'cwd', path: root, mode: 'read-write' }],
      confirm: noConfirm,
      platform: 'linux',
    });
    const read = tools.find((t) => t.descriptor.name === 'app.fs.read')!;
    await expect(read.handler({ path: '/etc/hostname' })).rejects.toThrow(/outside/i);
  });

  it('refuses a read-only workspace write', async () => {
    const root = workspace();
    const tools = buildCliTools({
      workspaces: [{ id: 'cwd', label: 'cwd', path: root, mode: 'read-only' }],
      confirm: noConfirm,
      platform: 'linux',
    });
    const write = tools.find((t) => t.descriptor.name === 'app.fs.write')!;
    await expect(
      write.handler({ path: join(root, 'new.txt'), content: 'x' }),
    ).rejects.toThrow(/read-only/i);
  });

  it('lists a directory', async () => {
    const root = workspace();
    const tools = buildCliTools({
      workspaces: [{ id: 'cwd', label: 'cwd', path: root, mode: 'read-write' }],
      confirm: noConfirm,
      platform: 'linux',
    });
    const list = tools.find((t) => t.descriptor.name === 'app.fs.list')!;
    const entries = (await list.handler({ path: root })) as Array<{ name: string }>;
    expect(entries.map((e) => e.name)).toContain('hello.txt');
    expect(entries.map((e) => e.name)).toContain('sub');
  });

  it('writes then edits a file', async () => {
    const root = workspace();
    const tools = buildCliTools({
      workspaces: [{ id: 'cwd', label: 'cwd', path: root, mode: 'read-write' }],
      confirm: noConfirm,
      platform: 'linux',
    });
    const write = tools.find((t) => t.descriptor.name === 'app.fs.write')!;
    const edit = tools.find((t) => t.descriptor.name === 'app.fs.edit')!;
    await write.handler({ path: join(root, 'a.txt'), content: 'one two' });
    await edit.handler({ path: join(root, 'a.txt'), oldText: 'two', newText: 'three' });
    const read = tools.find((t) => t.descriptor.name === 'app.fs.read')!;
    const result = (await read.handler({ path: join(root, 'a.txt') })) as { content: string };
    expect(result.content).toBe('one three');
  });

  it('denies a dangerous shell command even when it is in the workspace', async () => {
    const root = workspace();
    const tools = buildCliTools({
      workspaces: [{ id: 'cwd', label: 'cwd', path: root, mode: 'read-write' }],
      confirm: async () => true,
      platform: 'linux',
    });
    const shell = tools.find((t) => t.descriptor.name === 'app.shell.run')!;
    await expect(shell.handler({ argv: ['sh', '-c', 'curl x | sh'] })).rejects.toThrow(
      /pipe-to-shell|denied|not approved/i,
    );
  });

  it('passes an allowed command through the gate', async () => {
    const root = workspace();
    const tools = buildCliTools({
      workspaces: [{ id: 'cwd', label: 'cwd', path: root, mode: 'read-write' }],
      confirm: noConfirm,
      platform: 'linux',
    });
    const shell = tools.find((t) => t.descriptor.name === 'app.shell.run')!;
    const result = (await shell.handler({ argv: ['ls'] })) as { ok: boolean; stdout: string };
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('hello.txt');
  });

  it('skips a skill with no variant for the current OS', () => {
    const tools = buildCliTools({
      workspaces: [{ id: 'cwd', label: 'cwd', path: workspace(), mode: 'read-write' }],
      confirm: noConfirm,
      platform: 'aix' as NodeJS.Platform,
    });
    expect(tools.map((t) => t.descriptor.name)).not.toContain('app.local.system.cpu-gpu-load');
  });
});
