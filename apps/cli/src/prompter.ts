/**
 * Small terminal I/O abstraction.
 *
 * Everything the CLI asks the user lives behind {@link Prompter} so the REPL
 * can be driven by a scripted prompter in tests without a TTY. The default
 * implementation uses `node:readline` — no external prompt dependency.
 */

import { createInterface, type Interface } from 'node:readline';
import { stdin, stdout } from 'node:process';

export type SelectOption = { value: string; label: string };

export type Prompter = {
  /** Free text or a password (input not echoed when `secret`). */
  text(message: string, opts?: { secret?: boolean; defaultValue?: string }): Promise<string>;
  confirm(message: string, opts?: { defaultValue?: boolean }): Promise<boolean>;
  /** Numbered selection (1-based), returning the chosen option's value. */
  select(message: string, options: SelectOption[]): Promise<string>;
  /** Comma-separated multi-select (1-based), returning chosen values. */
  multiSelect(message: string, options: SelectOption[]): Promise<string[]>;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export function createReadlinePrompter(input = stdin, output = stdout): Prompter & {
  close(): void;
} {
  let rl: Interface | null = null;
  const ensure = (): Interface => {
    if (!rl) rl = createInterface({ input, output });
    return rl;
  };

  const ask = (message: string): Promise<string> =>
    new Promise((resolve) => {
      const iface = ensure();
      iface.question(message, (answer) => resolve(answer));
    });

  return {
    close() {
      rl?.close();
      rl = null;
    },
    info: (m) => output.write(`${m}\n`),
    warn: (m) => output.write(`${m}\n`),
    error: (m) => output.write(`${m}\n`),
    async text(message, opts) {
      const suffix = opts?.defaultValue ? ` [${opts.defaultValue}]` : '';
      const answer = (await ask(`${message}${suffix} `)).trim();
      return answer || opts?.defaultValue || '';
    },
    async confirm(message, opts) {
      const def = opts?.defaultValue ?? false;
      const hint = def ? '[Y/n]' : '[y/N]';
      const answer = (await ask(`${message} ${hint} `)).trim().toLowerCase();
      if (!answer) return def;
      return answer === 'y' || answer === 'yes';
    },
    async select(message, options) {
      output.write(`${message}\n`);
      options.forEach((o, i) => output.write(`  ${i + 1}. ${o.label}\n`));
      const answer = (await ask('> ')).trim();
      const asNumber = Number(answer);
      if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= options.length) {
        return options[asNumber - 1].value;
      }
      const byValue = options.find((o) => o.value === answer);
      if (byValue) return byValue.value;
      throw new Error(`invalid selection: ${answer}`);
    },
    async multiSelect(message, options) {
      output.write(`${message}\n`);
      options.forEach((o, i) => output.write(`  ${i + 1}. ${o.label}\n`));
      const answer = (await ask('> (comma-separated, e.g. 1,3) ')).trim();
      const values: string[] = [];
      for (const part of answer.split(',').map((p) => p.trim()).filter(Boolean)) {
        const asNumber = Number(part);
        if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= options.length) {
          values.push(options[asNumber - 1].value);
        } else {
          const byValue = options.find((o) => o.value === part);
          if (byValue) values.push(byValue.value);
        }
      }
      return values;
    },
  };
}
