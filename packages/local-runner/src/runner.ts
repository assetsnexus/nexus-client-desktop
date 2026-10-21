/**
 * Local GPU runner (Phase 4) — the BYOK edge sidecar client.
 *
 * The desktop can host a local OpenAI-compatible model server (Ollama today,
 * ComfyUI later). To make those models selectable by agents we register the
 * loopback endpoint with the region as a BYOK provider of kind
 * `edge_gpu_sidecar` (`anx.ai.byok.register`), which the region proxies to like
 * any other OpenAI-compatible upstream. The region requires an absolute
 * `https` endpoint, so the local runner presents the self-signed loopback cert
 * from `./tls.ts`.
 *
 * This module is deliberately transport-free: `buildByokRegistration` is pure,
 * and `registerLocalRunner` takes a `send` function so it is testable with a
 * mock and reusable from the Electron main process or the CLI.
 */

export type LocalRunnerKind = 'edge_gpu_sidecar';

/** Region BYOK host types (mirrors `HOSTING_TYPES` in byok.command-handlers). */
export const EDGE_HOSTING_TYPE = 'edge_processing' as const;

export type LocalRunnerConfig = {
  /** Stable id for this runner within the app (e.g. `ollama-local`). */
  id: string;
  /** Label shown in the model picker. */
  name: string;
  /** Loopback OpenAI-compatible base URL, e.g. `https://127.0.0.1:11435/v1`. */
  endpointUrl: string;
  /** Bearer key the local server accepts. Minted locally; never returned by the region. */
  apiKey: string;
  /** Default model id to advertise (optional; discovery fills the rest). */
  defaultModel?: string;
  /** Extra static upstream headers. */
  headers?: Record<string, string>;
};

export type ByokRegistrationPayload = {
  scope: 'user' | 'org';
  name: string;
  kind: LocalRunnerKind;
  endpointUrl: string;
  apiKey: string;
  hostingType: typeof EDGE_HOSTING_TYPE;
  headers?: Record<string, string>;
  idempotencyKey: string;
};

export class LocalRunnerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'LocalRunnerError';
    this.code = code;
  }
}

/**
 * The region rejects non-`https` BYOK endpoints outright, so catch it locally
 * with a clearer message than the round-trip would produce.
 */
export function assertHttpsEndpoint(endpointUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch {
    throw new LocalRunnerError('invalid_endpoint', `endpointUrl is not an absolute URL: ${endpointUrl}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new LocalRunnerError(
      'insecure_endpoint',
      'endpointUrl must use https (the region rejects plaintext BYOK endpoints); ' +
        'the local runner serves TLS with its loopback certificate.',
    );
  }
}

/** True when the endpoint is a loopback address (the runner's trust boundary). */
export function isLoopbackEndpoint(endpointUrl: string): boolean {
  let host: string;
  try {
    host = new URL(endpointUrl).hostname;
  } catch {
    return false;
  }
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/**
 * Map a learned availability state to the two things the app needs: whether the
 * runner is currently usable, and a short human reason when it is not.
 */
export type RunnerAvailability = 'available' | 'starting' | 'stopped' | 'error' | 'disabled';

export type RunnerStatus = {
  id: string;
  availability: RunnerAvailability;
  detail?: string;
  endpointUrl?: string;
  registered?: boolean;
  providerId?: string;
  lastCheckedAt?: string;
};

export function runnerAvailable(status: RunnerStatus): boolean {
  return status.availability === 'available';
}

/**
 * Build the `anx.ai.byok.register` payload for a local runner.
 *
 * `idempotencyKey` should be stable per (runner, key) so a retry cannot register
 * the same key twice — the region treats it as required for exactly this reason.
 */
export function buildByokRegistration(
  config: LocalRunnerConfig,
  input: { scope?: 'user' | 'org'; idempotencyKey: string },
): ByokRegistrationPayload {
  assertHttpsEndpoint(config.endpointUrl);
  if (!config.apiKey.trim()) {
    throw new LocalRunnerError('missing_key', 'a local runner apiKey is required');
  }
  if (!input.idempotencyKey.trim()) {
    throw new LocalRunnerError('missing_idempotency_key', 'idempotencyKey is required');
  }
  const payload: ByokRegistrationPayload = {
    scope: input.scope ?? 'user',
    name: config.name,
    kind: 'edge_gpu_sidecar',
    endpointUrl: config.endpointUrl,
    apiKey: config.apiKey,
    hostingType: EDGE_HOSTING_TYPE,
    idempotencyKey: input.idempotencyKey,
  };
  if (config.headers && Object.keys(config.headers).length) payload.headers = config.headers;
  return payload;
}

/** Derive a stable idempotency key for a runner + installed key. */
export function idempotencyKeyFor(config: LocalRunnerConfig): string {
  // A cheap, stable digest of the identity-bearing fields (no key material in
  // the clear beyond the short local apiKey, which is already loopback-scoped).
  const basis = `${config.id}\u0000${config.endpointUrl}\u0000${config.name}`;
  let hash = 0;
  for (let i = 0; i < basis.length; i += 1) {
    hash = (hash * 31 + basis.charCodeAt(i)) | 0;
  }
  return `local-runner:${config.id}:${(hash >>> 0).toString(16)}`;
}

export type ByokSend = (
  command: string,
  payload: Record<string, unknown>,
) => Promise<unknown>;

export type RegisterResult = {
  providerId: string | null;
  wrapperId: string | null;
  raw: Record<string, unknown>;
};

/** Extract the wrapper/provider ids from the region's `{ wrapper }` response. */
export function parseByokRegistration(raw: unknown): RegisterResult {
  const record = asRecord(raw);
  const body = asRecord(record.responseObject ?? record.data ?? record);
  const wrapper = asRecord(body.wrapper ?? body);
  return {
    providerId: str(wrapper.providerId ?? wrapper.provider_id ?? wrapper.id),
    wrapperId: str(wrapper.wrapperId ?? wrapper.wrapper_id),
    raw: body,
  };
}

/**
 * Register (or re-register) a local runner as a BYOK edge provider.
 *
 * Idempotent by construction: pass the same `config` and the generated key makes
 * a retry safe.
 */
export async function registerLocalRunner(
  send: ByokSend,
  config: LocalRunnerConfig,
  input: { scope?: 'user' | 'org'; idempotencyKey?: string } = {},
): Promise<RegisterResult> {
  const payload = buildByokRegistration(config, {
    scope: input.scope,
    idempotencyKey: input.idempotencyKey ?? idempotencyKeyFor(config),
  });
  const raw = await send('anx.ai.byok.register', payload as unknown as Record<string, unknown>);
  return parseByokRegistration(raw);
}

/** List the BYOK keys owned by the caller (for showing registration state). */
export async function listLocalRunners(
  send: ByokSend,
  input: { scope?: 'user' | 'org' } = {},
): Promise<Array<{ providerId: string | null; name: string; kind: string; endpointUrl: string }>> {
  const raw = await send('anx.ai.byok.list', { scope: input.scope ?? 'user' });
  const record = asRecord(raw);
  const body = asRecord(record.responseObject ?? record.data ?? record);
  const wrappers = Array.isArray(body.wrappers) ? body.wrappers : [];
  return wrappers
    .map((w) => {
      const r = asRecord(w);
      return {
        providerId: str(r.providerId ?? r.provider_id ?? r.id),
        name: str(r.name) ?? '',
        kind: str(r.kind) ?? '',
        endpointUrl: str(r.endpointUrl ?? r.endpoint_url) ?? '',
      };
    })
    .filter((w) => w.kind === 'edge_gpu_sidecar');
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}
