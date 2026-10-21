/**
 * Local STT/TTS model catalog (@nexus/local-voice).
 *
 * The region/inference model catalog is the source of truth for *which* speech
 * models exist and *where to download them* (`anx.inference.stt.models.list`
 * rows carry a public download URL — HuggingFace, GitHub releases, …). This
 * module normalizes those untrusted rows into a stable, serializable shape the
 * desktop settings UI and download manager consume, and tolerates partial rows
 * so a catalog that grows new fields never breaks the client.
 *
 * It also carries the **custom endpoint** descriptor: a user may point at their
 * own self-hosted server by selecting an API protocol from the system catalog
 * while supplying their own URL — including self-signed TLS endpoints, which
 * they must explicitly acknowledge (see `ignoreTls`).
 */

import type { VoiceEngineKind, VoiceEngineProtocol } from './protocol.js';

export type LocalVoiceModelSource = 'region' | 'custom';

/** One downloadable speech model as the desktop sees it. */
export type LocalVoiceModel = {
  /** Stable id (`catalog:<regionId>` or `custom:<slug>`). */
  id: string;
  kind: VoiceEngineKind;
  source: LocalVoiceModelSource;
  /** Display label from the region catalog. */
  label: string;
  /** Provider model key (e.g. `edge/whisper-large-v3-turbo`). */
  modelRef: string | null;
  /** Public download URL (HuggingFace etc.); null when the row omitted it. */
  downloadUrl: string | null;
  /** Expected on-disk size in bytes (for the progress bar + free-space check). */
  sizeBytes: number | null;
  /** Approximate VRAM needed if the engine runs on GPU. */
  vramGiB: number | null;
  /** Runtime/quantization hint (e.g. `ggml-q5_1`, `onnx`, `ct2`). */
  runtime: string | null;
  /** Files to fetch; a single entry means "the whole artifact". */
  files: LocalVoiceModelFile[];
  /** License/id for attribution + compatibility display. */
  licenseKeys: string[];
  /** Dataset checksum when published (verifies a resumed download). */
  sha256: string | null;
};

export type LocalVoiceModelFile = {
  /** Relative path inside the model directory. */
  name: string;
  url: string;
  sizeBytes: number | null;
  sha256: string | null;
};

export type ParseCatalogOptions = {
  /** Region id, retained for forward-compatible labeling. */
  regionId?: string;
};

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : [];
}

/** Best-effort modality classification, mirroring the region's audio rows. */
export function classifyVoiceKind(row: Record<string, unknown>): VoiceEngineKind | null {
  const category = String(row.category ?? '').toLowerCase();
  if (category === 'tts' || category.includes('text_to_speech')) return 'tts';
  if (category === 'stt' || category.includes('speech_to_text')) return 'stt';
  const caps = strArray(row.capabilities).map((c) => c.toLowerCase());
  const hasTts = caps.some((c) => c === 'tts' || c.startsWith('tts') || c === 'speech');
  const hasStt = caps.some((c) => c === 'stt' || c.startsWith('stt') || c === 'transcribe');
  if (hasTts && !hasStt) return 'tts';
  if (hasStt && !hasTts) return 'stt';
  // Region rows that declare a duplex/realtime transport: prefer tts (speaks).
  const transport = String(row.modalityTransport ?? '').toLowerCase();
  if (transport.startsWith('tts')) return 'tts';
  if (transport.startsWith('stt')) return 'stt';
  return null;
}

function parseFiles(row: Record<string, unknown>, fallbackUrl: string | null): LocalVoiceModelFile[] {
  const raw = Array.isArray(row.files) ? row.files : [];
  const files: LocalVoiceModelFile[] = [];
  for (const f of raw) {
    if (typeof f === 'string' && fallbackUrl) {
      files.push({ name: f, url: fallbackUrl, sizeBytes: null, sha256: null });
      continue;
    }
    if (!f || typeof f !== 'object') continue;
    const r = f as Record<string, unknown>;
    const url = str(r.url) ?? fallbackUrl;
    const name = str(r.name) ?? str(r.path);
    if (!url || !name) continue;
    files.push({ name, url, sizeBytes: num(r.sizeBytes ?? r.size), sha256: str(r.sha256 ?? r.checksum) });
  }
  if (!files.length && fallbackUrl) {
    files.push({ name: 'model', url: fallbackUrl, sizeBytes: null, sha256: null });
  }
  return files;
}

/**
 * Normalize one region catalog row. Returns null when the row is not a
 * downloadable STT/TTS model (never throws on a malformed row).
 */
export function parseLocalVoiceModel(
  row: unknown,
  _opts: ParseCatalogOptions = {},
): LocalVoiceModel | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const kind = classifyVoiceKind(r);
  if (!kind) return null;
  const downloadUrl = str(r.downloadUrl ?? r.download_url ?? r.weightsUrl ?? r.url);
  const modelRef = str(r.externalModelId ?? r.modelRef ?? r.registryKey ?? r.id ?? r._id);
  const id = str(r.id ?? r._id) ?? modelRef;
  if (!id) return null;
  const files = parseFiles(r, downloadUrl);
  const label = str(r.displayName ?? r.label ?? r.name) ?? modelRef ?? id;
  return {
    id: `catalog:${id}`,
    kind,
    source: 'region',
    label,
    modelRef,
    downloadUrl,
    sizeBytes: num(r.sizeBytes ?? r.downloadBytes ?? r.size),
    vramGiB: num(r.vramGiB ?? r.vramRequiredGib ?? r.selfHostVramGib),
    runtime: str(r.runtime ?? r.quantization ?? r.format),
    files,
    licenseKeys: strArray(r.licenseKeys ?? r.licenses),
    sha256: str(r.sha256 ?? r.checksum),
  };
}

export function parseLocalVoiceCatalog(
  rows: unknown,
  opts: ParseCatalogOptions = {},
): LocalVoiceModel[] {  const list = Array.isArray(rows) ? rows : [];
  const out: LocalVoiceModel[] = [];
  const seen = new Set<string>();
  for (const row of list) {
    const model = parseLocalVoiceModel(row, opts);
    if (!model || seen.has(model.id)) continue;
    // A downloadable row must actually have a URL, else it cannot be installed.
    if (model.files.length === 0) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}
/** Total bytes a model needs on disk (sum of files, or the declared size). */
export function modelDownloadBytes(model: LocalVoiceModel): number | null {
  const fromFiles = model.files.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0);
  if (fromFiles > 0) return fromFiles;
  return model.sizeBytes;
}

/** Whether a model can be installed on a machine with `freeBytes` free. */
export function fitsOnDisk(model: LocalVoiceModel, freeBytes: number | null): boolean {
  const need = modelDownloadBytes(model);
  if (need == null || freeBytes == null) return true;
  // Keep a small headroom so extraction/dedup does not fill the disk.
  return freeBytes > need * 1.1;
}

/**
 * A custom (self-hosted) endpoint descriptor. The user picks an API protocol
 * from the system catalog and supplies their own URL; a self-signed endpoint is
 * allowed only when `ignoreTls` is acknowledged.
 */
export type CustomVoiceEndpoint = {
  id: string;
  kind: VoiceEngineKind;
  label: string;
  protocol: VoiceEngineProtocol;
  baseUrl: string;
  ignoreTls: boolean;
  apiKey?: string | null;
};

export function customEndpointToModel(endpoint: CustomVoiceEndpoint): LocalVoiceModel {
  return {
    id: `custom:${endpoint.id}`,
    kind: endpoint.kind,
    source: 'custom',
    label: endpoint.label,
    modelRef: null,
    downloadUrl: null,
    sizeBytes: null,
    vramGiB: null,
    runtime: endpoint.protocol,
    files: [],
    licenseKeys: [],
    sha256: null,
  };
}
