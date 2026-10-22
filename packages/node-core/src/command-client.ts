/**
 * Node command client — the `@nexus/chat-core` `CommandClient` shape for the CLI
 * and any headless host. Uses plain `fetch` (Node 18+) with an optional custom
 * CA agent so a local/self-signed region node works.
 */

import { createHttpsAgent } from './tls.js';
import { sendCommand, type AuthClientOptions } from './auth.js';
import type { CommandResult } from './transport.js';

export type NodeCommandClientOptions = {
  baseUrl: string;
  token?: string | null;
  identity?: Record<string, unknown> | null;
  headers?: Record<string, string>;
  customCaPem?: string | null;
  allowInsecure?: boolean;
  fetchFn?: typeof fetch;
};

export type NodeCommandClient = {
  send(command: string, payload?: Record<string, unknown>): Promise<CommandResult>;
  updateAuth(next: { token?: string | null; identity?: Record<string, unknown> | null }): void;
};

export function createNodeCommandClient(
  options: NodeCommandClientOptions,
): NodeCommandClient {
  let token = options.token ?? null;
  let identity = options.identity ?? null;

  const clientOptions: AuthClientOptions = {
    baseUrl: options.baseUrl,
    headers: options.headers,
    fetchFn: options.fetchFn,
  };
  // A custom CA agent is only meaningful for the Node http path; `fetch` here
  // uses undici, so callers that need custom trust pass a `fetchFn` bound to it.
  void createHttpsAgent({ caPem: options.customCaPem, allowInsecure: options.allowInsecure });

  return {
    async send(command, payload): Promise<CommandResult> {
      const res = await sendCommand(clientOptions, command, payload ?? {}, { token, identity });
      return {
        ok: res.responseCode >= 200 && res.responseCode < 300,
        data: res.responseObject,
        responseCode: res.responseCode,
        responseObject: res.responseObject,
        message: res.message,
        code: res.code,
        authorizationRequired: res.authorizationRequired,
        authRequestId: res.authRequestId,
      };
    },
    updateAuth(next) {
      if (next.token !== undefined) token = next.token;
      if (next.identity !== undefined) identity = next.identity;
    },
  };
}
