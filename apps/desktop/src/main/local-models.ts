/**
 * Local model detection (desktop-local).
 *
 * The desktop is a client: region node and inference are cloud-hosted per-region
 * stacks, so this probes **this machine's** local model servers. The health/model
 * semantics mirror what region node reports for its neighbors, but this module
 * has no code dependency on region-node or the sidecar.
 *
 * Default backend: Ollama at http://127.0.0.1:11434.
 * ComfyUI is present as a disabled placeholder for the upcoming preview.
 */

import type {
  LocalModelBackend,
  LocalModelBackendStatus,
  LocalModelRow,
  LocalModelsSnapshot,
} from '../shared/ipc.js';

export const DEFAULT_LOCAL_BACKENDS: LocalModelBackend[] = [
  {
    id: 'ollama-local',
    kind: 'ollama',
    label: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434',
    enabled: true,
  },
  {
    id: 'comfyui-local',
    kind: 'comfyui',
    label: 'ComfyUI',
    baseUrl: 'http://127.0.0.1:8188',
    enabled: false,
  },
];

/** Ollama's tags endpoint lists installed models. */
export function ollamaTagsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/tags`;
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

export type ProbeOptions = {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Probe one backend. Never throws: transport failure or timeout becomes
 * `unreachable`, so the settings UI can always render a status.
 */
export async function probeBackend(
  backend: LocalModelBackend,
  options: ProbeOptions = {},
): Promise<LocalModelBackendStatus> {
  const checkedAt = new Date().toISOString();
  if (!backend.enabled) {
    return { backend, health: 'disabled', models: [], checkedAt, detail: 'Preview — not wired yet' };
  }

  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1500;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (backend.kind !== 'ollama') {
      return {
        backend,
        health: 'disabled',
        models: [],
        checkedAt,
        detail: 'Backend type not supported yet',
      };
    }
    const res = await fetchFn(ollamaTagsUrl(backend.baseUrl), { signal: controller.signal });
    if (!res.ok) {
      return {
        backend,
        health: 'unreachable',
        models: [],
        checkedAt,
        detail: `HTTP ${res.status}`,
      };
    }
    const body = await res.json().catch(() => ({}));
    const models = parseOllamaModels(body);
    return { backend, health: 'healthy', models, checkedAt };
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'probe failed';
    return { backend, health: 'unreachable', models: [], checkedAt, detail };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe every backend concurrently. */
export async function probeLocalModels(
  backends: LocalModelBackend[] = DEFAULT_LOCAL_BACKENDS,
  options: ProbeOptions = {},
): Promise<LocalModelsSnapshot> {
  const statuses = await Promise.all(backends.map((b) => probeBackend(b, options)));
  return { backends: statuses };
}
