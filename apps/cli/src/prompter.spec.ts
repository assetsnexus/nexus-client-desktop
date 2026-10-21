import { describe, expect, it, vi } from 'vitest';
import { createReadlinePrompter } from './prompter.js';
import { PassThrough } from 'node:stream';

/** Drive the readline prompter with scripted lines and captured output. */
function scripted(lines: string[]) {
  const input = new PassThrough();
  const output = new PassThrough();
  let captured = '';
  output.on('data', (d) => {
    captured += String(d);
  });
  const prompter = createReadlinePrompter(input, output);
  let i = 0;
  const answer = () => {
    const line = lines[i++] ?? '';
    // Emit after a tick so readline has attached its question listener.
    setTimeout(() => input.write(`${line}\n`), 0);
    return prompter;
  };
  return { prompter, answer, outputText: () => captured };
}

describe('createReadlinePrompter', () => {
  it('reads free text with a default', async () => {
    const { prompter, answer } = scripted(['']);
    answer();
    expect(await prompter.text('Name', { defaultValue: 'anon' })).toBe('anon');
    prompter.close();
  });

  it('parses a yes/no confirm with the default applied on empty input', async () => {
    const { prompter, answer } = scripted(['', 'n']);
    answer();
    expect(await prompter.confirm('Proceed?', { defaultValue: true })).toBe(true);
    answer();
    expect(await prompter.confirm('Proceed?', { defaultValue: true })).toBe(false);
    prompter.close();
  });

  it('resolves a numbered select', async () => {
    const { prompter, answer } = scripted(['2']);
    answer();
    const value = await prompter.select('Pick', [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ]);
    expect(value).toBe('b');
    prompter.close();
  });

  it('resolves a select by raw value', async () => {
    const { prompter, answer } = scripted(['a']);
    answer();
    expect(
      await prompter.select('Pick', [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ]),
    ).toBe('a');
    prompter.close();
  });

  it('throws on an invalid select', async () => {
    const { prompter, answer } = scripted(['9']);
    answer();
    await expect(
      prompter.select('Pick', [{ value: 'a', label: 'A' }]),
    ).rejects.toThrow(/invalid selection/i);
    prompter.close();
  });

  it('resolves a multi-select from indices and values', async () => {
    const { prompter, answer } = scripted(['1,c']);
    answer();
    const values = await prompter.multiSelect('Pick', [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
      { value: 'c', label: 'C' },
    ]);
    expect(values).toEqual(['a', 'c']);
    prompter.close();
  });

  it('prints info/warn/error to the output stream', () => {
    const { prompter, outputText } = scripted([]);
    const spy = vi.fn();
    prompter.info('hello');
    prompter.warn('careful');
    prompter.error('bad');
    spy();
    const text = outputText();
    expect(text).toContain('hello');
    expect(text).toContain('careful');
    expect(text).toContain('bad');
    prompter.close();
  });
});
