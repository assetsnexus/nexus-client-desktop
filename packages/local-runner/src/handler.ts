/**
 * OpenAI-compatible loopback proxy for a local model server (Phase 4).
 *
 * Why a proxy at all: Ollama exposes an OpenAI-compatible API on plain `http`,
 * but the region's BYOK surface requires an `https` endpoint and a bearer key.
 * This handler fronts the upstream local server so the *registered* endpoint is
 * `https://127.0.0.1:<port>/v1` with a locally-minted bearer, matching what the
 * region's `edge_gpu_sidecar` adapter calls (`GET {base}/models`,
 * `POST {base}/chat/completions`).
 *
 * The handler is transport-free and returns a plain `{ status, headers, body }`
 * so it is fully testable without opening a socket; `./server.ts` wraps it in
 * node's `https`.
 */

export type RunnerHandlerRequest = {
  method: string;
  /** Path only, e.g. `/v1/models`. */
  path: string;
  headers: Record<string, string | string[] | undefined>;
  /** Raw request body (already read), for POST forwards. */
  body?: string;
  /** Abort signal forwarded to the upstream call. */
  signal?: AbortSignal;
};

export type RunnerHandlerResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

/** Paths we forward, mapped to the upstream OpenAI-compatible surface. */
const FORWARD_PATHS = new Set(['/v1/models', '/v1/chat/completions', '/v1/completions', '/v1/embeddings']);

export type RunnerHandlerOptions = {
  /** Upstream local server base, e.g. `http://127.0.0.1:11434`. */
  upstreamBaseUrl: string;
  /** Bearer the runner accepts from the region. */
  apiKey: string;
  /** Injected for tests. */
  fetchFn?: typeof fetch;
};

export function createRunnerHandler(options: RunnerHandlerOptions) {
  const upstream = options.upstreamBaseUrl.replace(/\/+$/, '');
  const fetchFn = options.fetchFn ?? fetch;

  return async function handle(req: RunnerHandlerRequest): Promise<RunnerHandlerResponse> {
    if (req.method === 'GET' && (req.path === '/health' || req.path === '/v1/health')) {
      return json(200, { status: 'ok' });
    }

    const bearer = firstHeader(req.headers['authorization']);
    if (!isAuthorized(bearer, options.apiKey)) {
      return json(401, { error: { message: 'invalid runner key', type: 'unauthorized' } });
    }

    if (!FORWARD_PATHS.has(req.path)) {
      return json(404, { error: { message: `unsupported path ${req.path}`, type: 'not_found' } });
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
      return json(405, { error: { message: `method ${req.method} not allowed`, type: 'method_not_allowed' } });
    }

    const target = `${upstream}${req.path}`;
    const forwardHeaders: Record<string, string> = { authorization: `Bearer ${options.apiKey}` };
    const contentType = firstHeader(req.headers['content-type']);
    if (contentType) forwardHeaders['content-type'] = contentType;
    // Pass through OpenAI-compatible negotiation headers the upstream may honor.
    for (const name of ['accept', 'openai-beta', 'openai-organization', 'openai-project']) {
      const v = firstHeader(req.headers[name]);
      if (v) forwardHeaders[name] = v;
    }

    try {
      const res = await fetchFn(target, {
        method: req.method,
        headers: forwardHeaders,
        body: req.method === 'POST' ? req.body : undefined,
        signal: req.signal,
      });
      const text = await res.text();
      return {
        status: res.status,
        headers: {
          'content-type': res.headers.get('content-type') ?? 'application/json',
          'cache-control': 'no-store',
        },
        body: text,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'upstream call failed';
      return json(502, { error: { message: `local runner upstream error: ${detail}`, type: 'bad_gateway' } });
    }
  };
}

/** Constant-time-ish bearer comparison (no crypto dep; the key is loopback-scoped). */
function isAuthorized(bearer: string | null, expected: string): boolean {
  if (!bearer) return false;
  const token = bearer.replace(/^Bearer\s+/i, '').trim();
  if (token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i += 1) diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function firstHeader(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

function json(status: number, body: unknown): RunnerHandlerResponse {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
