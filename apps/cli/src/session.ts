/**
 * CLI session — auth + headless chat controller + rail wiring.
 *
 * Reuses `@nexus/node-core` for region auth/device identity and
 * `@nexus/chat-core` for the framework-free chat controller. The CLI only adds
 * terminal presentation (via {@link Prompter}) and local tool execution (via
 * `@nexus/client-tools`). No chat logic is duplicated here.
 */

import {
  createNodeCommandClient,
  ensureDeviceIdentity,
  generateDeviceKeys,
  login as regionLogin,
  scopedKey,
  SECURE_KEYS,
  twoFactorLogin as regionTwoFactorLogin,
  type AuthIdentity,
  type ResolvedConnectionConfig,
  type SecureStore,
} from '@nexus/node-core';
import {
  createNexusChat,
  type ChatHooks,
  type NexusChat,
  type PendingPauseCard,
  type UserChoiceQuestion,
} from '@nexus/chat-core';
import type { WorkspaceRoot } from '@nexus/client-tools';
import { buildCliTools } from './tools.js';
import { createSecureDeviceKeyStore, loadPersistedDeviceKeys } from './device-store.js';
import type { Prompter } from './prompter.js';
import {
  presentAskUserChoice,
  presentPermissionElevation,
  presentPendingPause,
  presentSca,
  presentSubAgentNotice,
  presentToolApproval,
  resolveMultiSelection,
  resolveSelection,
} from './rails.js';

const APP_VERSION = '0.1.0';

export type CliSessionOptions = {
  connection: ResolvedConnectionConfig;
  secureStore: SecureStore;
  prompter: Prompter;
  /** cwd, registered as the read-write session workspace. */
  cwd: string;
  platform: NodeJS.Platform;
};

export type SigState = { signedIn: boolean; identity: AuthIdentity | null; token: string | null };

export class CliSession {
  readonly chat: NexusChat;
  private readonly client: ReturnType<typeof createNodeCommandClient>;
  private token: string | null = null;
  private identity: AuthIdentity | null = null;
  private readonly options: CliSessionOptions;

  constructor(options: CliSessionOptions) {
    this.options = options;
    const { connection } = options;
    this.client = createNodeCommandClient({
      baseUrl: connection.regionUrl,
      headers: { 'X-Anx-App': connection.appId },
      customCaPem: connection.customCaPem,
    });

    const workspaces: WorkspaceRoot[] = [
      { id: 'cwd', label: options.cwd, path: options.cwd, mode: 'read-write' },
    ];
    const tools = buildCliTools({
      workspaces,
      platform: options.platform,
      confirm: async (command, reason) =>
        options.prompter.confirm(
          `${reason ? `${reason}: ` : ''}run "${command}"?`,
          { defaultValue: false },
        ),
    });

    this.chat = createNexusChat({
      client: this.client,
      transport: 'direct',
      agentSource: 'nexus',
      features: { adminPanels: false },
      publicFilesBaseUrl: connection.regionUrl,
      tools: tools.map((t) => ({ descriptor: t.descriptor, handler: t.handler })),
      hooks: this.buildHooks(options.prompter),
    });
  }

  private buildHooks(prompter: Prompter): ChatHooks {
    return {
      onScaRequired: async (info) => {
        const card = presentSca(info);
        prompter.warn(card.lines.join('\n'));
      },
      onDataAccessApproval: (info) => {
        prompter.warn(`Data access approval requested: ${JSON.stringify(info)}`);
      },
      onPermissionElevationRequired: async (info) => {
        const card = presentPermissionElevation(info);
        prompter.info(card.lines.join('\n'));
      },
      onToolApprovalRequired: async (run) => {
        const card = presentToolApproval(run, 'acknowledge');
        prompter.info(card.lines.join('\n'));
      },
      onPendingPause: async (card: PendingPauseCard) => {
        await this.handlePendingPause(card, prompter);
      },
      onStreamState: (state) => {
        if (state === 'error') prompter.warn('stream error');
      },
      onError: (err) => prompter.error(err instanceof Error ? err.message : String(err)),
      onChatCommand: (command) => {
        if (command.name) prompter.info(`(agent command: ${command.name})`);
      },
    };
  }

  /** Interactive resolution of a paused turn, mirroring the desktop cards. */
  async handlePendingPause(card: PendingPauseCard, prompter: Prompter): Promise<void> {
    const presentation = presentPendingPause(card);
    if (presentation.lines.length) prompter.info(presentation.lines.join('\n'));

    if (presentation.prompt.type === 'none') {
      if (card.kind === 'client_tool') {
        await this.chat.answerClientToolPause({ callId: card.callId });
      }
      return;
    }

    const approved = await prompter.confirm(presentation.prompt.message, { defaultValue: false });
    if (card.kind === 'approval') {
      await this.chat.resolveApproval({ callId: card.callId, approved });
    } else if (card.kind === 'mode_switch') {
      await this.chat.resolveModeSwitch({ callId: card.callId, approved });
    } else {
      await this.chat.approveClientTool({ callId: card.callId, approved });
    }
  }

  /** Login (with the mandatory 2FA step) and register the device identity. */
  async signIn(email: string, password: string): Promise<SigState> {
    const { prompter, connection, secureStore } = this.options;
    const login = await regionLogin(
      { baseUrl: connection.regionUrl, headers: { 'X-Anx-App': connection.appId } },
      { email, password },
    );

    if (login.kind === 'two_factor_required') {
      prompter.info(
        `Two-factor required${login.challenge.factors.length ? ` (${login.challenge.factors.join(', ')})` : ''}.`,
      );
      const code = await prompter.text('Enter the code', { secret: true });
      const out = await regionTwoFactorLogin(
        { baseUrl: connection.regionUrl, headers: { 'X-Anx-App': connection.appId } },
        { authRequestId: login.challenge.authRequestId, code },
      );
      this.token = out.token;
      this.identity = out.identity;
    } else {
      this.token = login.token;
      this.identity = login.identity;
    }

    await secureStore.set(scopedKey(SECURE_KEYS.token, null), this.token);
    this.client.updateAuth({ token: this.token, identity: this.identity as never });
    await this.registerDevice();
    return { signedIn: true, identity: this.identity, token: this.token };
  }

  /** Reuse a persisted token (no interactive login). */
  async restore(): Promise<SigState> {
    const stored = await this.options.secureStore.get(scopedKey(SECURE_KEYS.token, null));
    if (!stored) return { signedIn: false, identity: null, token: null };
    this.token = stored;
    this.identity = { userId: null, orgId: null, role: null, deviceId: null };
    this.client.updateAuth({ token: stored, identity: this.identity as never });
    return { signedIn: true, identity: this.identity, token: stored };
  }

  /** Register as `nexus-desktop` (idempotent; never blocks a session). */
  private async registerDevice(): Promise<void> {
    if (!this.token) return;
    try {
      const keysRaw = await this.options.secureStore.get(SECURE_KEYS.deviceKeys);
      if (!keysRaw) {
        await this.options.secureStore.set(
          SECURE_KEYS.deviceKeys,
          JSON.stringify(generateDeviceKeys()),
        );
      }
      const seed = await loadPersistedDeviceKeys(this.options.secureStore);
      const store = createSecureDeviceKeyStore(this.options.secureStore, seed);
      const result = await ensureDeviceIdentity(
        this.regionClientOptions(),
        store,
        {
          deviceName: 'nexus-cli',
          deviceType: this.options.connection.deviceType,
          platform: this.options.platform,
          appVersion: APP_VERSION,
        },
        this.token,
      );
      if (this.identity) this.identity = { ...this.identity, deviceId: result.deviceId };
    } catch (err) {
      this.options.prompter.warn(
        `Device registration skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private regionClientOptions() {
    return {
      baseUrl: this.options.connection.regionUrl,
      headers: { 'X-Anx-App': this.options.connection.appId },
    };
  }

  async signOut(): Promise<void> {
    this.token = null;
    this.identity = null;
    await this.options.secureStore.delete(scopedKey(SECURE_KEYS.token, null));
  }

  getIdentity(): AuthIdentity | null {
    return this.identity;
  }

  /**
   * Send a raw region command (the same envelope the chat controller uses).
   * Exposed so the CLI can drive commands the chat layer does not wrap — e.g.
   * following a long-running (`102`) task via `anx.long-running.*`.
   */
  sendCommand(command: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    return this.client.send(command, payload);
  }

  /** Load contacts, then run the numbered agent picker. */
  async pickAgent(prompter: Prompter): Promise<string | null> {
    await this.chat.loadContacts();
    const contacts = this.chat.getState().contacts;
    const entries = contacts.map((c, i) => ({
      index: i + 1,
      id: c.virtualEmployeeId || c.id,
      label: `${c.name} (${c.type})`,
    }));
    if (!entries.length) {
      prompter.warn('No agent contacts found.');
      return null;
    }
    const value = await prompter.select(
      'Select an agent',
      entries.map((e) => ({ value: e.id, label: e.label })),
    );
    return value;
  }

  /** Resolve an interactive `ask_user_choice`. */
  async askQuestion(question: UserChoiceQuestion, prompter: Prompter): Promise<void> {
    const presentation = presentAskUserChoice(question);
    prompter.info(presentation.lines.join('\n'));
    if (presentation.prompt.type !== 'select') return;

    const options = presentation.prompt.options;
    if (question.multiSelect) {
      const raw = await prompter.text('Your selection');
      const selected = resolveMultiSelection(raw, options);
      await this.chat.answerQuestion({ questionId: question.questionId, selectedIds: selected });
    } else {
      const raw = await prompter.text('Your selection');
      const selected = resolveSelection(raw, options);
      const custom = selected ? null : raw.trim() || null;
      await this.chat.answerQuestion({
        questionId: question.questionId,
        selectedIds: selected ? [selected] : [],
        customText: custom,
      });
    }
  }

  close(): void {
    this.client.updateAuth({ token: null });
  }
}

export { presentSubAgentNotice };