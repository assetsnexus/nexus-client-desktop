/**
 * Dependency-free `fetch` for the Node main process that trusts a custom CA.
 *
 * Electron 33 bundles Node 20, which has no `tls.setDefaultCACertificates` and
 * no bundled `undici`, so there is no supported way to teach the *global*
 * `fetch` about a local/self-signed region CA. Instead we build a
 * `fetch`-compatible function on `node:http(s)` with an `https.Agent({ ca })`,
 * which is exactly how the rest of the main process already reaches a
 * self-signed endpoint.
 *
 * It implements the subset the region/command/storage/local-runner paths use:
 * method, headers, string/bytes body, `AbortSignal`, and a response exposing
 * `ok`, `status`, `headers.get`, `text`, `json`, and `arrayBuffer`. Redirects
 * are followed (bounded) so presigned-URL hops keep working.
 *
 * TRUST: this only ever *adds* a CA to the trust set for requests made with it.
 * It never disables verification. Callers that need plain `http:` (local dev)
 * get it transparently because the scheme picks the transport.
 */

import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Agent as HttpsAgent } from 'node:https';

type FetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | ArrayBuffer | null;
  signal?: AbortSignal;
  redirect?: 'follow' | 'error' | 'manual';
};

/** A body-less response shape covering everything the callers read. */
export type MinimalResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
};

const MAX_REDIRECTS = 5;

function toHeaderMap(raw: Record<string, string | string[] | undefined>): {
  get(name: string): string | null;
} {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(raw)) {
    if (value == null) continue;
    map.set(key.toLowerCase(), Array.isArray(value) ? value.join(', ') : value);
  }
  return { get: (name) => map.get(name.toLowerCase()) ?? null };
}

function bodyBuffer(body: FetchInit['body']): Buffer | null {
  if (body == null) return null;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
  return null;
}

export type NodeFetchOptions = {
  /** PEM contents of a custom CA bundle. */
  caPem?: string | null;
  /** Local-dev escape hatch; never wired to a UI toggle. */
  allowInsecure?: boolean;
  /** Extra headers merged into every request. */
  defaultHeaders?: Record<string, string>;
};

/**
 * Build a `fetch`-compatible function bound to a custom CA. Returns the global
 * `fetch` untouched when no custom trust is configured, so the common path keeps
 * Node's native implementation.
 */
export function createNodeFetch(options: NodeFetchOptions = {}): typeof fetch {
  const ca = options.caPem?.trim();
  const insecure = options.allowInsecure === true;
  if (!ca && !insecure) return fetch;

  const agent = new HttpsAgent({
    ...(ca ? { ca } : {}),
    rejectUnauthorized: !insecure,
    keepAlive: true,
  });

  const doFetch = async (input: string, init: FetchInit, redirectsLeft: number): Promise<MinimalResponse> => {
    const url = new URL(input);
    const isHttps = url.protocol === 'https:';
    const send = isHttps ? httpsRequest : httpRequest;
    const payload = bodyBuffer(init.body);
    const headers: Record<string, string> = { ...(options.defaultHeaders ?? {}), ...(init.headers ?? {}) };
    if (payload && headers['content-length'] === undefined && headers['Content-Length'] === undefined) {
      headers['content-length'] = String(payload.byteLength);
    }

    const requestOptions: RequestOptions = {
      method: init.method ?? (payload ? 'POST' : 'GET'),
      headers,
      signal: init.signal,
      ...(isHttps ? { agent } : {}),
    };

    const result = await new Promise<{
      status: number;
      statusText: string;
      headers: ReturnType<typeof toHeaderMap>;
      buffer: Buffer;
      location: string | null;
    }>((resolve, reject) => {
      const req = send(url, requestOptions, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk as Buffer));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? '',
            headers: toHeaderMap(res.headers),
            buffer: Buffer.concat(chunks),
            location: (res.headers.location as string | undefined) ?? null,
          }),
        );
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });

    // Follow redirects (HuggingFace/presigned hops) unless told otherwise.
    const follow = (init.redirect ?? 'follow') === 'follow';
    if (follow && result.status >= 300 && result.status < 400 && result.location && redirectsLeft > 0) {
      const next = new URL(result.location, url).toString();
      // A redirect to a plain GET drops the body, per fetch semantics.
      const isRedirectToGet = result.status === 301 || result.status === 302 || result.status === 303;
      return doFetch(
        next,
        { ...init, method: isRedirectToGet ? 'GET' : init.method, body: isRedirectToGet ? null : init.body },
        redirectsLeft - 1,
      );
    }

    const { buffer, status, statusText, headers: resHeaders } = result;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText,
      url: url.toString(),
      headers: resHeaders,
      async text() {
        return buffer.toString('utf8');
      },
      async json() {
        return JSON.parse(buffer.toString('utf8')) as unknown;
      },
      async arrayBuffer() {
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
      },
    };
  };

  const fetchFn = ((input: string | URL | { url: string }, init?: RequestInit): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return doFetch(
      href,
      {
        method: init?.method,
        headers: init?.headers as Record<string, string> | undefined,
        body: (init?.body as FetchInit['body']) ?? null,
        signal: init?.signal ?? undefined,
        redirect: init?.redirect,
      },
      MAX_REDIRECTS,
    ) as unknown as Promise<Response>;
  }) as typeof fetch;

  return fetchFn;
}
