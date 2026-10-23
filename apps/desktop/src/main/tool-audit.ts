/**
 * The client-tool invocation choke point, instrumented for the audit trail.
 *
 * Every agent-initiated client tool call arrives as `IPC.toolsRun` and is
 * dispatched through here. It is the single place a tool runs, so it is also the
 * single place we record an audit entry — agent id, conversation correlation,
 * redacted args/result, outcome and timing — before returning the result
 * unchanged.
 *
 * The audit sink is the main-process store; it is passed in, never reachable
 * from the renderer. This wrapper grants no authority and changes no policy: it
 * runs the tool exactly as `runTool` would and only observes the outcome.
 */

import type { AuditStore } from './audit-store.js';
import type { Logger } from './logger.js';
import { runTool, type ToolRunnerOptions, type ToolResult } from './tool-runner.js';
import type { ToolInvocation } from '../shared/ipc.js';

/** Metadata-only correlation fields carried alongside the tool args. */
export type ToolInvocationContext = {
  /** Agent (contact) id that requested the call, when known. */
  agentId?: string | null;
  /** Conversation the call belongs to, when known. */
  conversationId?: string | null;
};

/** Strip the routing/correlation fields, leaving only the tool's own args. */
export function toolArgsOf(req: ToolInvocation): Record<string, unknown> {
  const { name: _name, agentId: _agentId, conversationId: _conversationId, ...args } = req;
  return args;
}

export type ToolAuditorDeps = {
  audit: AuditStore;
  logger?: Logger;
  /** Host surface recorded on each entry. Defaults to `desktop`. */
  source?: string;
  /** Clock, injectable for deterministic tests. */
  now?: () => number;
};

export type ToolAuditor = {
  /** Run `req` through the real runner, recording exactly one audit entry. */
  invoke(req: ToolInvocation, options: ToolRunnerOptions): Promise<ToolResult>;
};

export function createToolAuditor(deps: ToolAuditorDeps): ToolAuditor {
  const source = deps.source ?? 'desktop';
  const now = deps.now ?? (() => Date.now());
  const log = deps.logger?.child('tools');

  return {
    async invoke(req, options) {
      const startedAt = now();
      const agentId = typeof req.agentId === 'string' && req.agentId ? req.agentId : null;
      const conversationId =
        typeof req.conversationId === 'string' && req.conversationId ? req.conversationId : null;
      const args = toolArgsOf(req);

      try {
        const result = await runTool(req as never, options);
        deps.audit.append({
          tool: req.name,
          agentId,
          conversationId,
          source,
          ok: result.ok,
          args,
          result: result.data,
          error: result.error ?? null,
          startedAt,
          finishedAt: now(),
        });
        log?.debug('client tool invoked', {
          tool: req.name,
          agentId,
          conversationId,
          ok: result.ok,
        });
        return result;
      } catch (err) {
        // A thrown tool is still an audited outcome; then it propagates so the
        // caller sees exactly what it would have without the auditor.
        const message = err instanceof Error ? err.message : String(err);
        deps.audit.append({
          tool: req.name,
          agentId,
          conversationId,
          source,
          ok: false,
          args,
          error: message,
          startedAt,
          finishedAt: now(),
        });
        log?.warn('client tool threw', { tool: req.name, agentId, conversationId, message });
        throw err;
      }
    },
  };
}
