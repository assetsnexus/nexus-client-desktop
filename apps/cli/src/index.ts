/**
 * `nexus` CLI entry point.
 *
 * Two modes:
 *   - interactive: `nexus` — sign in, pick an agent, then a REPL.
 *   - one-shot:    `nexus run "prompt" [--agent <id>] [--json]`
 *
 * All chat/auth/tool logic lives in `@nexus/node-core` + `@nexus/chat-core` +
 * `@nexus/client-tools`; this file only parses argv, presents the terminal, and
 * drives the controller.
 */

import { createInterface } from 'node:readline';
import { cwd as processCwd, exit, platform, argv as processArgv } from 'node:process';
import { createMemorySecureStore } from '@nexus/node-core';
import { parseArgs, HELP_TEXT, type CliCommand } from './args.js';
import { createConfigStore } from './config.js';
import { createCliSecureStore, defaultSecretsPath } from './store.js';
import { createReadlinePrompter, type Prompter } from './prompter.js';
import { CliSession } from './session.js';
import { parseLongRunningAccepted, createTaskPoller, renderProgress, waitForTask } from './long-running.js';

const CWD = processCwd();

function printIdentity(session: CliSession, prompter: Prompter): void {
  const identity = session.getIdentity();
  if (!identity) {
    prompter.info('Not signed in.');
    return;
  }
  prompter.info(
    [
      `Signed in${identity.email ? ` as ${identity.email}` : ''}`,
      `  user:   ${identity.userId ?? '—'}`,
      `  org:    ${identity.orgId ?? '—'}`,
      `  role:   ${identity.role ?? '—'}`,
      `  device: ${identity.deviceId ?? '—'}`,
    ].join('\n'),
  );
}

/** Follow a long-running (`102`) task to completion, rendering progress. */
export async function followTask(
  taskId: string,
  pollAfterMs: number | null,
  send: (command: string, payload: Record<string, unknown>) => Promise<unknown>,
  prompter: Prompter,
): Promise<ReturnType<typeof waitForTask> extends Promise<infer T> ? T : never> {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);
  try {
    return await waitForTask(taskId, {
      fetchTask: createTaskPoller(send),
      pollAfterMs: pollAfterMs ?? undefined,
      signal: controller.signal,
      onTick: (snapshot) => prompter.info(renderProgress(snapshot)),
    });
  } finally {
    process.off('SIGINT', onSigint);
  }
}

async function resolveConversation(
  session: CliSession,
  prompter: Prompter,
  agentId: string | undefined,
  conversationId: string | undefined,
): Promise<string | null> {
  if (conversationId) return conversationId;
  const id = agentId ?? (await session.pickAgent(prompter));
  if (!id) return null;
  const opened = await session.chat.openContact(id);
  return opened.conversationId;
}

async function runOneShot(
  command: Extract<CliCommand, { kind: 'run' }>,
  session: CliSession,
  prompter: Prompter,
): Promise<number> {
  const conversationId = await resolveConversation(
    session,
    prompter,
    command.agentId,
    command.conversationId,
  );
  if (!conversationId) return 1;

  const result = await session.chat.sendMessage(command.prompt, { conversationId });
  const failed = result && typeof result === 'object' && 'ok' in result && result.ok === false;

  if (command.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return failed ? 1 : 0;
  }
  if (failed) {
    prompter.error(`Send failed: ${(result as { message?: string }).message ?? 'unknown error'}`);
    return 1;
  }

  // Envelope 102: the region accepted long-running work; follow it to completion.
  const accepted = parseLongRunningAccepted(result);
  if (accepted) {
    prompter.info(`Accepted (${accepted.command || 'task'}); following ${accepted.taskId}…`);
    const snapshot = await followTask(
      accepted.taskId,
      accepted.pollAfterMs,
      (cmd, payload) => session.sendCommand(cmd, payload),
      prompter,
    );
    if (snapshot.status === 'failed' || snapshot.status === 'expired') {
      prompter.error(`Task ${snapshot.status}: ${snapshot.error ?? 'unknown'}`);
      return 1;
    }
    return 0;
  }

  // Wait for the assistant turn to settle on the live stream.
  await session.chat.streamInit({ conversationId }).catch(() => undefined);
  const lastAssistant = [...session.chat.getState().turns]
    .reverse()
    .find((t) => t.role === 'assistant');
  if (lastAssistant?.text) prompter.info(lastAssistant.text);
  return 0;
}

async function runInteractive(
  command: Extract<CliCommand, { kind: 'interactive' }>,
  session: CliSession,
  prompter: Prompter & { close(): void },
): Promise<number> {
  const conversationId = await resolveConversation(session, prompter, command.agentId, undefined);
  if (!conversationId) return 1;

  prompter.info(`Connected. Workspace: ${command.cwd}\nType your message, or /help for commands.`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (): Promise<string | null> =>
    new Promise((resolve) => rl.question('nexus> ', (line) => resolve(line)));

  // Stream assistant text as it grows by emitting only the new suffix.
  let rendered = '';
  const unsubscribe = session.chat.subscribe(() => {
    const turns = session.chat.getState().turns;
    const last = [...turns].reverse().find((t) => t.role === 'assistant');
    if (!last?.text) return;
    if (last.text.length > rendered.length) process.stdout.write(last.text.slice(rendered.length));
    rendered = last.text;
  });

  try {
    for (;;) {
      const line = await ask();
      if (line == null) break;
      const text = line.trim();
      if (!text) continue;
      if (text === '/exit' || text === '/quit') break;
      if (text === '/help') {
        prompter.info('Commands: /exit, /compact, /cancel');
        continue;
      }
      if (text === '/compact') {
        await session.chat.compactConversation({ conversationId });
        prompter.info('Compacted.');
        continue;
      }
      if (text === '/cancel') {
        await session.chat.cancelConversation({ conversationId });
        prompter.info('Cancelled.');
        continue;
      }

      rendered = '';
      await session.chat.sendMessage(text, { conversationId });
      process.stdout.write('\n');
    }
  } finally {
    unsubscribe();
    rl.close();
  }
  return 0;
}

async function signInOrRestore(
  session: CliSession,
  prompter: Prompter,
  allowPrompt: boolean,
): Promise<boolean> {
  const restored = await session.restore();
  if (restored.signedIn) return true;
  if (!allowPrompt) return false;

  const email = await prompter.text('Email');
  const password = await prompter.text('Password', { secret: true });
  const state = await session.signIn(email, password);
  return state.signedIn;
}

export async function main(argv: string[] = processArgv.slice(2)): Promise<void> {
  const command = parseArgs(argv, CWD);

  switch (command.kind) {
    case 'help':
      process.stdout.write(`${HELP_TEXT}\n`);
      return;
    case 'version':
      process.stdout.write('nexus 0.1.0\n');
      return;
    case 'error':
      process.stderr.write(`${command.message}\n`);
      exit(2);
      return;
    default:
      break;
  }

  const config = createConfigStore();
  const connection = config.get();
  const ephemeral = argv.includes('--ephemeral');
  const secureStore = ephemeral
    ? createMemorySecureStore()
    : createCliSecureStore(false, process.env.NEXUS_SECRETS_PATH || defaultSecretsPath());

  const prompter = createReadlinePrompter();
  const session = new CliSession({
    connection,
    secureStore,
    prompter,
    cwd: CWD,
    platform,
  });

  try {
    if (command.kind === 'whoami') {
      if (!(await signInOrRestore(session, prompter, false))) {
        prompter.error('Not signed in. Run `nexus` to sign in.');
        exit(1);
      }
      printIdentity(session, prompter);
      return;
    }

    const interactive = command.kind === 'interactive';
    if (!(await signInOrRestore(session, prompter, interactive))) {
      prompter.error('Sign-in required. Run `nexus` to sign in.');
      exit(1);
      return;
    }

    const code =
      command.kind === 'run'
        ? await runOneShot(command, session, prompter)
        : await runInteractive(command, session, prompter);
    if (code !== 0) exit(code);
  } finally {
    session.close();
    prompter.close();
  }
}

export { renderProgress };
