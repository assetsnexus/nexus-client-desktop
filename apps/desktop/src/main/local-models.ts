/**
 * Local model instances (desktop-local).
 *
 * The desktop is a client: region node and inference are cloud-hosted per-region
 * stacks, so this probes **this machine's** local model servers. Unlike the old
 * single-hardcoded-backend version, the user may now configure 0..n instances of
 * Ollama / ComfyUI, each with its own TLS policy (a self-signed cert on their own
 * network) and optional bearer key, and pick how a job is routed across them.
 *
 * Two concerns are kept apart so both are unit-testable with no network:
 *  - `probeBackend` — one instance's health, model list, and busy signal;
 *  - `selectRoutableBackend` — pure "which instance gets the next job" policy.
 */

import type {
  LocalModelBackend,
  LocalModelBackendStatus,
  LocalModelRow,
  LocalModelsSnapshot,
  LocalModelsRoutingPolicy,
} from '../shared/ipc.js';

export const DEFAULT_LOCAL_BACKENDS: LocalModelBackend[] = [
  {
    id: 'ollama-local',
    kind: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://127.0.0.1:11434',
    enabled: true,
    ignoreTls: false,
    apiKey: null,
    customCaPem: null,
  },
  {
    id: 'comfyui-local',
    kind: 'comfyui',
    label: 'ComfyUI (local)',
    baseUrl: 'http://127.0.0.1:8188',
    enabled: false,
    ignoreTls: false,
    apiKey: null,
    customCaPem: null,
  },
];

const KINDS: LocalModelBackend['kind'][] = ['ollama', 'comfyui'];

function trimUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/** Ollama's tags endpoint lists installed models. */
export function ollamaTagsUrl(baseUrl: string): string {
  return `${trimUrl(baseUrl)}/api/tags`;
}

/** Ollama's `ps` endpoint lists models currently loaded (a busy signal). */
export function ollamaPsUrl(baseUrl: string): string {
  return `${trimUrl(baseUrl)}/api/ps`;
}

/** ComfyUI's system stats (health + device info). */
export function comfySystemStatsUrl(baseUrl: string): string {
  return `${trimUrl(baseUrl)}/system_stats`;
}

/** ComfyUI's queue (running + pending jobs, a busy signal). */
export function comfyQueueUrl(baseUrl: string): string {
  return `${trimUrl(baseUrl)}/queue`;
}

type OllamaTagsResponse = {
  models?: Array<{ name?: string; model?: string; size?: number }>;
};

/** Parse Ollama `/api/tags` into model rows (tolerant of partial payloads). */
export function parseOllamaModels(body: unknown): LocalModelRow[] {
  if (!body || typeof body !== 'object') return [];
  const models = (body as OllamaTagsResponse).models;
  if (!Array.isArray(models)) return [];
  const rows: LocalModelRow[] = [];
  for (const m of models) {
    if (!m || typeof m !== 'object') continue;
    const name = typeof m.name === 'string' && m.name ? m.name : m.model;
    if (!name) continue;
    rows.push({
      id: name,
      name,
      sizeBytes: typeof m.size === 'number' ? m.size : null,
    });
  }
  return rows;
}

/** Names of the models Ollama currently holds in memory (`/api/ps`). */
export function parseOllamaLoaded(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const models = (body as OllamaTagsResponse).models;
  if (!Array.isArray(models)) return [];
  const names: string[] = [];
  for (const m of models) {
    if (!m || typeof m !== 'object') continue;
    const name = typeof m.name === 'string' && m.name ? m.name : m.model;
    if (name) names.push(name);
  }
  return names;
}

export type ComfyQueueSummary = { running: number; pending: number; busy: boolean };

/** Read ComfyUI's queue shape into a busy summary (tolerant of partials). */
export function parseComfyQueue(body: unknown): ComfyQueueSummary {
  const r = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const len = (value: unknown): number => (Array.isArray(value) ? value.length : 0);
  const running = len(r.queue_running);
  const pending = len(r.queue_pending);
  return { running, pending, busy: running + pending > 0 };
}

/**
 * A JSON request the prober uses. Injectable so the whole probe policy is
 * testable without a server, and so a TLS-relaxed request can be routed through
 * a plain `https` call (undici's `fetch` cannot relax certificate validation).
 */
export type JsonRequest = (
  url: string,
  init: {
    ignoreTls?: boolean;
    customCaPem?: string | null;
    apiKey?: string | null;
    timeoutMs?: number;
  },
) => Promise<{ ok: boolean; status: number; body: unknown }>;

export type ProbeOptions = {
  request?: JsonRequest;
  timeoutMs?: number;
};

/**
 * Probe one instance. Never throws: transport failure, timeout, or a non-ok
 * response becomes `unreachable`, so the settings UI can always render a status.
 * A disabled instance is reported without any request being made.
 */
export async function probeBackend(
  backend: LocalModelBackend,
  options: ProbeOptions = {},
): Promise<LocalModelBackendStatus> {
  const checkedAt = new Date().toISOString();
  const base: LocalModelBackendStatus = {
    backend,
    health: 'disabled',
    models: [],
    busy: false,
    loadedModels: [],
    checkedAt,
  };
  if (!backend.enabled) {
    return { ...base, detail: 'Disabled — turn it on to probe.' };
  }

  const request = options.request ?? defaultJsonRequest;
  const timeoutMs = options.timeoutMs ?? 1500;
  const call = (url: string) =>
    request(url, {
      ignoreTls: backend.ignoreTls,
      customCaPem: backend.customCaPem ?? null,
      apiKey: backend.apiKey ?? null,
      timeoutMs,
    });

  try {
    if (backend.kind === 'ollama') {
      const tags = await call(ollamaTagsUrl(backend.baseUrl));
      if (!tags.ok) {
        return { ...base, health: 'unreachable', detail: `HTTP ${tags.status}` };
      }
      const models = parseOllamaModels(tags.body);
      // The loaded-models probe is best-effort: a tags-only server still works.
      let loadedModels: string[] = [];
      let psDetail: string | undefined;
      try {
        const ps = await call(ollamaPsUrl(backend.baseUrl));
        if (ps.ok) loadedModels = parseOllamaLoaded(ps.body);
        else psDetail = `ps HTTP ${ps.status}`;
      } catch {
        psDetail = 'ps probe failed';
      }
      return {
        ...base,
        health: 'healthy',
        models,
        busy: loadedModels.length > 0,
        loadedModels,
        detail: psDetail,
      };
    }

    if (backend.kind === 'comfyui') {
      const stats = await call(comfySystemStatsUrl(backend.baseUrl));
      if (!stats.ok) {
        return { ...base, health: 'unreachable', detail: `HTTP ${stats.status}` };
      }
      let running = 0;
      let pending = 0;
      try {
        const queue = await call(comfyQueueUrl(backend.baseUrl));
        if (queue.ok) {
          const summary = parseComfyQueue(queue.body);
          running = summary.running;
          pending = summary.pending;
        }
      } catch {
        /* queue is best-effort */
      }
      const busy = running + pending > 0;
      return {
        ...base,
        health: 'healthy',
        busy,
        models: [],
        loadedModels: [],
        detail: busy ? `${running} running · ${pending} queued` : 'idle',
      };
    }

    return { ...base, health: 'disabled', detail: 'Backend type not supported yet' };
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'probe failed';
    return { ...base, health: 'unreachable', detail };
  }
}

/** Probe every enabled instance concurrently and compute the routed target. */
export async function probeLocalModels(
  backends: LocalModelBackend[] = DEFAULT_LOCAL_BACKENDS,
  options: ProbeOptions & {
    policy?: LocalModelsRoutingPolicy;
    cursor?: number;
  } = {},
): Promise<LocalModelsSnapshot> {
  const policy = options.policy ?? 'first_available';
  const statuses = await Promise.all(backends.map((b) => probeBackend(b, options)));
  const routed = selectRoutableBackend(statuses, { policy, cursor: options.cursor });
  return { backends: statuses, routedBackendId: routed.backendId, policy };
}

/**
 * Pick the instance the next job should go to, purely from the probe snapshot.
 *
 * - `first_available` (default): the first healthy, non-busy instance.
 * - `least_busy`: the healthy instance with the fewest loaded jobs, preferring
 *   idle instances, then declaration order.
 * - `round_robin`: rotates through healthy instances using `cursor`.
 *
 * A healthy-but-busy instance is only chosen when no idle instance exists, so a
 * single loaded model never takes a second instance out of rotation.
 */
export function selectRoutableBackend(
  statuses: LocalModelBackendStatus[],
  options: { policy?: LocalModelsRoutingPolicy; cursor?: number } = {},
): { backendId: string | null; nextCursor: number } {
  const policy = options.policy ?? 'first_available';
  const cursor = Number.isFinite(options.cursor) ? Math.max(0, Math.floor(options.cursor!)) : 0;

  const healthy = statuses.filter((s) => s.health === 'healthy');
  if (!healthy.length) return { backendId: null, nextCursor: cursor };

  const load = (s: LocalModelBackendStatus): number =>
    s.loadedModels.length + (s.detail?.includes('queued') ? 1 : 0);

  const idle = healthy.filter((s) => !s.busy);
  const pool = idle.length ? idle : healthy;

  if (policy === 'round_robin') {
    const index = cursor % pool.length;
    return { backendId: pool[index]!.backend.id, nextCursor: (cursor + 1) % pool.length };
  }

  if (policy === 'least_busy') {
    let best = pool[0]!;
    for (const s of pool) if (load(s) < load(best)) best = s;
    return { backendId: best.backend.id, nextCursor: 0 };
  }

  // first_available
  return { backendId: pool[0]!.backend.id, nextCursor: 0 };
}

/**
 * Coerce an untrusted persisted instance into a valid one. Returns null when the
 * entry is unusable (no id/url), so a hand-edited file cannot poison the list.
 */
export function normalizeLocalBackend(raw: unknown, index = 0): LocalModelBackend | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const baseUrl = typeof r.baseUrl === 'string' ? r.baseUrl.trim() : '';
  if (!baseUrl) return null;
  const kind = KINDS.includes(r.kind as LocalModelBackend['kind'])
    ? (r.kind as LocalModelBackend['kind'])
    : 'ollama';
  const id =
    typeof r.id === 'string' && r.id.trim() ? r.id.trim() : `${kind}-${index}-${Date.now()}`;
  return {
    id,
    kind,
    label: typeof r.label === 'string' && r.label.trim() ? r.label.trim() : `${kind} instance`,
    baseUrl,
    enabled: r.enabled !== false,
    ignoreTls: r.ignoreTls === true,
    apiKey: typeof r.apiKey === 'string' && r.apiKey ? r.apiKey : null,
    customCaPem: typeof r.customCaPem === 'string' && r.customCaPem.trim() ? r.customCaPem : null,
  };
}

/** Coerce an untrusted persisted list, dropping unusable entries and dupes. */
export function normalizeLocalBackends(raw: unknown): LocalModelBackend[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: LocalModelBackend[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    const backend = normalizeLocalBackend(list[i], i);
    if (!backend || seen.has(backend.id)) continue;
    seen.add(backend.id);
    out.push(backend);
  }
  return out;
}

/** Reason a base URL is unusable, or null when it is fine. */
export function validateBackendUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return 'Enter a base URL.';
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return 'Not a valid URL (include http:// or https://).';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'Only http:// or https:// URLs are supported.';
  }
  if (!url.hostname) return 'The URL is missing a host.';
  return null;
}

/**
 * Default JSON request. Local instances are overwhelmingly plain http on
 * loopback, so `fetch` covers them; an `https` endpoint with a custom CA or
 * relaxed TLS falls back to a plain `https` request with a per-request agent
 * (undici's `fetch` cannot relax TLS or inject a per-host CA).
 */
export async function defaultJsonRequest(
  url: string,
  init: {
    ignoreTls?: boolean;
    customCaPem?: string | null;
    apiKey?: string | null;
    timeoutMs?: number;
  },
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.apiKey) headers.authorization = `Bearer ${init.apiKey}`;
  const isHttps = /^https:\/\//i.test(url);
  if (isHttps && (init.ignoreTls === true || init.customCaPem)) {
    return httpsJson(url, {
      headers,
      timeoutMs: init.timeoutMs,
      ignoreTls: init.ignoreTls === true,
      customCaPem: init.customCaPem ?? null,
    });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 1500);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Minimal https GET that either tolerates a self-signed certificate or trusts an
 * explicit PEM bundle. Only used after the user configured that instance.
 */
function httpsJson(
  url: string,
  init: {
    headers: Record<string, string>;
    timeoutMs?: number;
    ignoreTls: boolean;
    customCaPem: string | null;
  },
): Promise<{ ok: boolean; status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    void import('node:https').then(({ default: https }) => {
      const options: Record<string, unknown> = {
        headers: init.headers,
        rejectUnauthorized: !init.ignoreTls,
        timeout: init.timeoutMs ?? 1500,
      };
      // A user-supplied CA is only meaningful while validation is on; when the
      // user chose to ignore TLS, disabling validation is the whole policy.
      if (!init.ignoreTls && init.customCaPem) options.ca = init.customCaPem;
      const req = https.get(url, options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown = {};
          try {
            body = text ? JSON.parse(text) : {};
          } catch {
            body = {};
          }
          const status = res.statusCode ?? 0;
          resolve({ ok: status >= 200 && status < 300, status, body });
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    }, reject);
  });
}
