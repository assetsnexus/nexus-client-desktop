/**
 * `@nexus/local-runner` — local OpenAI-compatible GPU runner for the desktop.
 *
 * Phase 4: expose this machine's local model server to the user's agents via
 * BYOK. The runner owns three concerns, each independently testable:
 *
 * 1. `tls.ts`     — the loopback certificate the region's `https` BYOK rule requires.
 * 2. `handler.ts` — the OpenAI-compatible proxy (`/v1/models`, `/v1/chat/completions`).
 * 3. `runner.ts`  — `anx.ai.byok.register` as kind `edge_gpu_sidecar`.
 * 4. `server.ts`  — the bound loopback https server tying the three together.
 */

export {
  LOCAL_RUNNER_ALT_NAMES,
  mintLocalTls,
  type LocalTlsMaterial,
  type MintOptions,
} from './tls.js';

export {
  EDGE_HOSTING_TYPE,
  LocalRunnerError,
  assertHttpsEndpoint,
  buildByokRegistration,
  idempotencyKeyFor,
  isLoopbackEndpoint,
  listLocalRunners,
  parseByokRegistration,
  registerLocalRunner,
  runnerAvailable,
  type ByokRegistrationPayload,
  type ByokSend,
  type LocalRunnerConfig,
  type LocalRunnerKind,
  type RegisterResult,
  type RunnerAvailability,
  type RunnerStatus,
} from './runner.js';

export {
  createRunnerHandler,
  type RunnerHandlerOptions,
  type RunnerHandlerRequest,
  type RunnerHandlerResponse,
} from './handler.js';

export {
  startLocalRunnerServer,
  type LocalRunnerServer,
  type LocalRunnerServerOptions,
} from './server.js';
