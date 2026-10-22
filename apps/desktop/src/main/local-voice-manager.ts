/**
 * Desktop-local speech model manager (Phase 11e, main process).
 *
 * Owns the whole lifecycle of on-device STT/TTS: catalog (from the region +
 * built-in fallback), downloads to disk, the idle engine lifecycle that frees
 * VRAM when nobody is talking, and the RAM/VRAM probe the settings UI shows.
 *
 * All the interesting pure logic lives in `@nexus/local-voice`; this module only
 * wires it to Electron (paths + `app.getPath`), the region command sender, and
 * the real filesystem / fetch. It never runs a model in a unit test: the engine
 * runtime is injected.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { get as httpsGet } from 'node:https';
import { freemem, totalmem } from 'node:os';
import { app } from 'electron';
import {
  DEFAULT_LOCAL_VOICE_SETTINGS,
  buildDownloadPlan,
  createVoiceLifecycle,
  fitsOnDisk,
  freePercent,
  idlePolicyFromSettings,
  mergeVoiceCatalog,
  modelDirName,
  normalizeLocalVoiceSettings,
  parseLocalVoiceCatalog,
  probeResources,
  runDownloadPlan,
  validateLocalVoiceSettings,
  type DownloadFsAdapter,
  type LocalVoiceModel,
  type LocalVoiceSettings as CoreSettings,
  type ProbeRunners,
  type VoiceLifecycle,
} from '@nexus/local-voice';
import type {
  LocalVoiceEngineRow,
  LocalVoiceModelRow,
  LocalVoiceResourceSnapshot,
  LocalVoiceSettings,
  LocalVoiceSettingsPatch,
  LocalVoiceState,
} from '../shared/ipc.js';
import {
  createDefaultEngineRuntime,
  type LocalVoiceEngineRuntime,
} from './local-voice-engines.js';

export type LocalVoiceManagerOptions = {
  getSender: () => Promise<{
    send: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
  }>;
  /** Overridable for tests. */
  dataDir?: string;
  settingsPath?: string;
  /** Injected so tests never shell out for VRAM. */
  probeRunners?: ProbeRunners;
  /** Injected engine loader (spawns a process in production). */
  engineRuntime?: LocalVoiceEngineRuntime;
  /**
   * Map a bare engine binary name to a concrete path (the app-managed
   * `whisper-server` when installed). Lets the idle lifecycle spawn a runner the
   * app downloaded, without a manual PATH install.
   */
  resolveBinary?: (binary: string) => string;
  now?: () => number;
};

export type LocalVoiceManager = ReturnType<typeof createLocalVoiceManager>;

/** Unwrap an `anx.*` command response's payload. */
function unwrap(result: unknown): Record<string, unknown> {
  const r = result as { data?: Record<string, unknown>; responseObject?: Record<string, unknown> } & Record<
    string,
    unknown
  >;
  if (r && typeof r === 'object') {
    if (r.data && typeof r.data === 'object') return r.data;
    if (r.responseObject && typeof r.responseObject === 'object') {
      return (r.responseObject as Record<string, unknown>).data as Record<string, unknown> ??
        r.responseObject;
    }
  }
  return (r ?? {}) as Record<string, unknown>;
}

function defaultProbeRunners(): ProbeRunners {
  return {
    totalmem,
    freemem,
    platform: process.platform,
    run: async (command, args) => runExecFile(command, args),
  };
}

function runExecFile(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 3000 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

export function createLocalVoiceManager(options: LocalVoiceManagerOptions) {
  const userData = options.dataDir ?? app.getPath('userData');
  const modelsDir = join(userData, 'voice-models');
  const settingsPath = options.settingsPath ?? join(userData, 'local-voice.json');
  const now = options.now ?? (() => Date.now());

  const engineRuntime =
    options.engineRuntime ??
    createDefaultEngineRuntime({ modelsDir, resolveBinary: options.resolveBinary });

  let lifecycle: VoiceLifecycle | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  // Seed from the FULL built-in catalog (speech + VAD + wake detectors). Using
  // only `BUILTIN_VOICE_MODELS` here hid the detector rows until a manual
  // "Refresh catalog" happened to succeed, so the wake picker reported "no wake
  // models" even though they ship built in.
  let catalog: LocalVoiceModel[] = mergeVoiceCatalog([]);
  const downloads = new Map<string, AbortController>();
  const downloadState = new Map<
    string,
    { percent: number | null; installedBytes: number; state: 'downloading' | 'installed' | 'error'; error?: string }
  >();

  function readSettings(): LocalVoiceSettings {
    if (!existsSync(settingsPath)) return { ...DEFAULT_LOCAL_VOICE_SETTINGS };
    try {
      const raw = JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown;
      return normalizeLocalVoiceSettings(raw) as LocalVoiceSettings;
    } catch {
      return { ...DEFAULT_LOCAL_VOICE_SETTINGS };
    }
  }

  function writeSettings(value: LocalVoiceSettings): void {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(value, null, 2), 'utf8');
  }

  function coreSettings(settings: LocalVoiceSettings): CoreSettings {
    return settings as unknown as CoreSettings;
  }

  // --- installed models on disk -------------------------------------------------

  function isInstalled(model: LocalVoiceModel): boolean {
    if (!model.files.length) return false;
    const dir = join(modelsDir, modelDirName(model));
    // Every file (or its .part) presence check: installed means all final files.
    return model.files.every((f) => existsSync(join(dir, f.name)));
  }

  function installedBytes(model: LocalVoiceModel): number {
    const dir = join(modelsDir, modelDirName(model));
    let total = 0;
    for (const f of model.files) {
      const final = join(dir, f.name);
      if (existsSync(final)) {
        total += f.sizeBytes ?? 0;
      } else {
        const part = `${final}.part`;
        if (existsSync(part)) {
          try {
            total += readFileSync(part).byteLength;
          } catch {
            /* ignore */
          }
        }
      }
    }
    return total;
  }

  function modelRow(model: LocalVoiceModel): LocalVoiceModelRow {
    const dl = downloadState.get(model.id);
    const installed = isInstalled(model);
    return {
      id: model.id,
      kind: model.kind,
      label: model.label,
      source: model.source,
      downloadUrl: model.downloadUrl,
      sourceUrl: model.sourceUrl,
      sizeBytes: model.sizeBytes,
      vramGiB: model.vramGiB,
      runtime: model.runtime,
      licenseKeys: model.licenseKeys,
      installState: installed ? 'installed' : (dl?.state ?? 'not_installed'),
      installedBytes: dl?.installedBytes ?? installedBytes(model),
      downloadPercent: installed ? 100 : (dl?.percent ?? null),
      error: dl?.error ?? null,
    };
  }

  // --- engines lifecycle --------------------------------------------------------

  function ensureLifecycle(): VoiceLifecycle {
    if (lifecycle) return lifecycle;
    const settings = readSettings();
    const runtimes = engineRuntime.list();
    lifecycle = createVoiceLifecycle({
      engines: runtimes.map((r) => ({
        id: r.id,
        kind: r.kind,
        load: () => r.load(),
        unload: () => r.unload(),
      })),
      policy: idlePolicyFromSettings(coreSettings(settings)),
      now,
    });
    return lifecycle;
  }

  function engineRows(): LocalVoiceEngineRow[] {
    const lc = ensureLifecycle();
    return lc.snapshot().map((s) => ({
      id: s.id,
      kind: s.kind,
      state: s.state,
      lastUsedAtMs: s.lastUsedAtMs,
      unloadAtMs: s.unloadAtMs,
      error: s.error,
    }));
  }

  /** Rebuild the lifecycle against changed settings (models / timeout). */
  function rebuildLifecycle(): void {
    void lifecycle?.releaseAll();
    lifecycle = null;
  }

  function startIdleTimer(): void {
    if (idleTimer) return;
    idleTimer = setInterval(() => {
      void ensureLifecycle().tick();
    }, 15_000);
    // Do not hold the process open just for the idle sweep.
    idleTimer.unref?.();
  }

  function stopIdleTimer(): void {
    if (idleTimer) {
      clearInterval(idleTimer);
      idleTimer = null;
    }
  }

  // --- resources ----------------------------------------------------------------

  async function resources(): Promise<LocalVoiceResourceSnapshot> {
    const runners: ProbeRunners = options.probeRunners ?? defaultProbeRunners();
    const snap = await probeResources(runners);
    return {
      ram: snap.ram,
      vram: snap.vram,
      vramReason: snap.vramReason,
      checkedAt: snap.checkedAt,
    };
  }

  // --- catalog ------------------------------------------------------------------

  async function loadRegionCatalog(): Promise<LocalVoiceModel[]> {
    try {
      const sender = await options.getSender();
      const result = await sender.send('anx.inference.stt.models.list', { modality: 'both' });
      const data = unwrap(result);
      const rows = Array.isArray(data.models) ? data.models : [];
      // The handler embeds a `download` descriptor per row; surface it flat so
      // the core parser can read it.
      const flat = rows.map((row) => {
        const r = row as Record<string, unknown>;
        const download = (r.download ?? null) as Record<string, unknown> | null;
        if (!download) return r;
        return {
          ...r,
          downloadUrl: download.downloadUrl ?? r.downloadUrl,
          downloadFiles: download.files ?? r.downloadFiles,
          sourceUrl: download.sourceUrl ?? r.sourceUrl,
          sizeBytes: download.sizeBytes ?? r.sizeBytes,
          vramGiB: download.vramGiB ?? r.vramGiB,
          runtime: download.runtime ?? r.runtime,
          licenseKeys: download.licenseKeys ?? r.licenseKeys,
        };
      });
      return parseLocalVoiceCatalog(flat, {});
    } catch {
      return [];
    }
  }

  async function refreshCatalog(): Promise<LocalVoiceModel[]> {
    const region = await loadRegionCatalog();
    catalog = mergeVoiceCatalog(region);
    return catalog;
  }

  // --- downloads ----------------------------------------------------------------

  function fsAdapter(): DownloadFsAdapter {
    return {
      sizeOf: async (p) => {
        try {
          return statSync(p).size;
        } catch {
          return 0;
        }
      },
      appendChunk: async (p, chunk) => {
        const { appendFileSync } = await import('node:fs');
        appendFileSync(p, chunk);
      },
      resetPartial: async (p) => {
        try {
          rmSync(p, { force: true });
        } catch {
          /* ignore */
        }
      },
      commit: async (from, to) => {
        const { renameSync } = await import('node:fs');
        renameSync(from, to);
      },      remove: async (p) => {
        try {
          rmSync(p, { force: true });
        } catch {
          /* ignore */
        }
      },
      ensureDir: async (p) => {
        mkdirSync(p, { recursive: true });
      },
    };
  }

  /**
   * HTTPS GET with certificate validation relaxed, used only when the user
   * explicitly acknowledged a self-signed endpoint. Streams the body so the
   * downloader can still report progress and resume.
   */
  function relaxedTlsFetch(
    url: string,
    init: { headers: Record<string, string>; signal?: AbortSignal },
  ): Promise<{
    ok: boolean;
    status: number;
    contentLength: number | null;
    acceptedRange: boolean;
    body: AsyncIterable<Uint8Array> | null;
  }> {
    return new Promise((resolve, reject) => {
      const req = httpsGet(
        url,
        { headers: init.headers, rejectUnauthorized: false, signal: init.signal },
        (res) => {
          const status = res.statusCode ?? 0;
          const len = res.headers['content-length'];
          const contentRange = res.headers['content-range'];
          const acceptedRange =
            status === 206 || (typeof contentRange === 'string' && contentRange.startsWith('bytes'));
          async function* body(): AsyncGenerator<Uint8Array> {
            for await (const chunk of res) yield chunk as Uint8Array;
          }
          resolve({
            ok: status >= 200 && status < 300,
            status,
            contentLength: len ? Number(len) : null,
            acceptedRange,
            body: body(),
          });
        },
      );
      req.on('error', reject);
    });
  }

  async function realFetch(
    url: string,
    init: { headers: Record<string, string>; signal?: AbortSignal; relaxTls?: boolean },
  ): Promise<{
    ok: boolean;
    status: number;
    contentLength: number | null;
    acceptedRange: boolean;
    body: AsyncIterable<Uint8Array> | null;
  }> {
    // Node's global fetch follows redirects (HuggingFace uses them). For a
    // self-signed host the user explicitly acknowledged the risk, so we relax
    // TLS for that request only via a per-request https agent (undici can't
    // relax TLS, so a plain http(s) request is used when relaxation is asked).
    if (init.relaxTls && /^https:\/\//i.test(url)) {
      return relaxedTlsFetch(url, init);
    }
    const res = await fetch(url, { headers: init.headers, signal: init.signal, redirect: 'follow' });
    const len = res.headers.get('content-length');
    const contentRange = res.headers.get('content-range');
    const acceptedRange =
      res.status === 206 || (contentRange != null && contentRange.startsWith('bytes'));
    async function* body() {
      const reader = res.body?.getReader();
      if (!reader) return;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) yield value;
      }
    }
    return {
      ok: res.ok,
      status: res.status,
      contentLength: len ? Number(len) : null,
      acceptedRange,
      body: res.body ? body() : null,
    };
  }

  async function install(modelId: string): Promise<void> {
    const model = catalog.find((m) => m.id === modelId);
    if (!model) {
      downloadState.set(modelId, { state: 'error', percent: null, installedBytes: 0, error: 'Unknown model' });
      return;
    }
    if (!model.files.length) {
      downloadState.set(modelId, {
        state: 'error',
        percent: null,
        installedBytes: 0,
        error: 'This model has no downloadable artifact (configure a custom endpoint instead).',
      });
      return;
    }
    const controller = new AbortController();
    downloads.set(modelId, controller);
    downloadState.set(modelId, { state: 'downloading', percent: 0, installedBytes: 0 });
    const plan = buildDownloadPlan(model, {
      existingBytes: await existingBytesFor(model),
    });
    const result = await runDownloadPlan({
      plan,
      targetDir: modelsDir,
      fs: fsAdapter(),
      fetchFn: realFetch,
      sha256: async (p) => {
        try {
          return createHash('sha256').update(readFileSync(p)).digest('hex');
        } catch {
          return null;
        }
      },
      signal: controller.signal,
      // Only relax TLS when the user explicitly acknowledged it for a custom
      // (self-hosted) source; public repo downloads always validate certs.
      relaxTls: model.source === 'custom' && readSettings().ignoreTlsForCustom,
      onProgress: (e) => {
        downloadState.set(modelId, {
          state: 'downloading',
          percent: e.percent,
          installedBytes: e.totalBytesWritten,
        });
      },
    });
    downloads.delete(modelId);
    if (result.ok) {
      downloadState.set(modelId, { state: 'installed', percent: 100, installedBytes: plan.totalBytes ?? 0 });
    } else if (result.cancelled) {
      downloadState.set(modelId, {
        state: 'error',
        percent: null,
        installedBytes: installedBytes(model),
        error: 'Cancelled',
      });
    } else {
      downloadState.set(modelId, {
        state: 'error',
        percent: null,
        installedBytes: installedBytes(model),
        error: result.error ?? 'download failed',
      });
    }
  }

  async function existingBytesFor(model: LocalVoiceModel): Promise<Record<string, number>> {
    const dir = join(modelsDir, modelDirName(model));
    const out: Record<string, number> = {};
    for (const f of model.files) {
      const rel = `${modelDirName(model)}/${f.name}`;
      const final = join(dir, f.name);
      const { statSync } = await import('node:fs');
      try {
        out[rel] = statSync(final).size;
      } catch {
        try {
          out[rel] = statSync(`${final}.part`).size;
        } catch {
          out[rel] = 0;
        }
      }
    }
    return out;
  }

  async function state(): Promise<LocalVoiceState> {
    if (!catalog.length) catalog = mergeVoiceCatalog([]);
    const settings = readSettings();
    return {
      settings,
      resources: await resources(),
      models: catalog.map(modelRow),
      engines: engineRows(),
      modelsDir,
    };
  }

  return {
    async getState(): Promise<LocalVoiceState> {
      return state();
    },

    async setSettings(patch: LocalVoiceSettingsPatch): Promise<LocalVoiceState> {
      const next = normalizeLocalVoiceSettings({ ...readSettings(), ...patch }) as LocalVoiceSettings;
      writeSettings(next);
      // The idle timeout / selected models changed → rebuild the engine set.
      stopIdleTimer();
      rebuildLifecycle();
      if (next.enabled) startIdleTimer();
      return state();
    },

    async refreshCatalog(): Promise<LocalVoiceState> {
      await refreshCatalog();
      return state();
    },

    async install(modelId: string): Promise<LocalVoiceState> {
      await install(modelId);
      return state();
    },

    async cancelInstall(modelId: string): Promise<LocalVoiceState> {
      downloads.get(modelId)?.abort();
      return state();
    },

    async remove(modelId: string): Promise<LocalVoiceState> {
      const model = catalog.find((m) => m.id === modelId);
      if (model) {
        const dir = join(modelsDir, modelDirName(model));
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
      downloadState.delete(modelId);
      return state();
    },

    async probeResources(): Promise<LocalVoiceResourceSnapshot> {
      return resources();
    },

    /** Validate the persisted settings (used by the renderer before saving). */
    validate(patch: LocalVoiceSettingsPatch) {
      const next = normalizeLocalVoiceSettings({ ...readSettings(), ...patch }) as LocalVoiceSettings;
      return validateLocalVoiceSettings(coreSettings(next));
    },

    /** Disk-fit hint for a model against currently free space (best-effort). */
    async canInstall(modelId: string): Promise<boolean> {
      const model = catalog.find((m) => m.id === modelId);
      if (!model) return false;
      try {
        const st = statfsSync(modelsDir);
        return fitsOnDisk(model, st.bavail * st.bsize);
      } catch {
        return true;
      }
    },

    /** The directory models install into (for the wake host to read bytes from). */
    modelsDirectory(): string {
      return modelsDir;
    },

    /** Look up a catalog model by id (for the wake host to resolve file names). */
    findModel(modelId: string): LocalVoiceModel | null {
      return catalog.find((m) => m.id === modelId) ?? null;
    },

    /**
     * Every catalog model. Lets the wake STT resolver auto-select an installed
     * speech model when the user never picked one explicitly, and lets the UI
     * build readiness checklists without a second IPC round-trip.
     */
    listModels(): LocalVoiceModel[] {
      return [...catalog];
    },

    /** True when every file of a model is present on disk (wake STT readiness). */
    isInstalled(modelId: string): boolean {
      const model = catalog.find((m) => m.id === modelId);
      return model ? isInstalled(model) : false;
    },

    /** The user's chosen local STT model id, or null (wake STT target selection). */
    selectedSttModelId(): string | null {
      return readSettings().sttModelId;
    },

    /** The configured custom STT endpoint, if any (wake STT target selection). */
    customSttEndpoint(): LocalVoiceSettings['customSttEndpoint'] {
      return readSettings().customSttEndpoint;
    },

    /** Free a local engine's VRAM immediately (settings toggle / unload all). */
    async unloadEngines(): Promise<LocalVoiceState> {
      await ensureLifecycle().releaseAll();
      return state();
    },

    /**
     * Voice capabilities the desktop can offer right now (Phase 11e): whether a
     * local STT/TTS engine is installed, plus whether a region realtime model is
     * reachable. Cloud STT/TTS availability is derived from the region catalog.
     */
    async voiceCapabilities(): Promise<{
      realtimeAvailable: boolean;
      cloudSttAvailable: boolean;
      cloudTtsAvailable: boolean;
      localSttAvailable: boolean;
      localTtsAvailable: boolean;
    }> {
      const settings = readSettings();
      const installed = catalog.filter((m) => m.files.length && isInstalled(m));
      const localSttAvailable = installed.some((m) => m.kind === 'stt');
      const localTtsAvailable = installed.some((m) => m.kind === 'tts');
      // A configured custom endpoint also counts as a local engine.
      const customStt = Boolean(settings.customSttEndpoint?.baseUrl);
      const customTts = Boolean(settings.customTtsEndpoint?.baseUrl);
      const hasCloudStt = catalog.some((m) => m.source === 'region' && m.kind === 'stt');
      const hasCloudTts = catalog.some((m) => m.source === 'region' && m.kind === 'tts');
      return {
        realtimeAvailable: hasCloudStt || hasCloudTts,
        cloudSttAvailable: hasCloudStt,
        cloudTtsAvailable: hasCloudTts,
        localSttAvailable: localSttAvailable || customStt,
        localTtsAvailable: localTtsAvailable || customTts,
      };
    },

    /** Called once at startup and on app quit. */
    start(): void {
      if (readSettings().enabled && !idleTimer) startIdleTimer();
    },
    async dispose(): Promise<void> {
      stopIdleTimer();
      await lifecycle?.releaseAll();
      lifecycle = null;
    },

    /** Exposed for tests. */
    _internals: { freePercent: freePercent },
  };
}
