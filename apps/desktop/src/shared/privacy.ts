/**
 * Privacy-dashboard classifier.
 *
 * Pure, framework-free mapping from the desktop's actual configuration to a
 * per-stage "where does this run" verdict, plus a hosting breakdown of the model
 * catalog. Kept out of the section component so the classification can be unit
 * tested without a DOM or any Electron wiring.
 *
 * The four hosting classes are canonical and shared with the chat clients
 * (`public_cloud | managed_cloud | private_cloud | edge_processing`); this module
 * only groups them for display.
 */

/** Where one configured pipeline stage runs. */
export type PipelineLocation = 'onDevice' | 'region' | 'publicCloud' | 'unknown';

export type PipelineStageView = {
  id: 'llm' | 'stt' | 'tts' | 'wake';
  /** Resolved location, or `null` when nothing is configured for the stage. */
  location: PipelineLocation | null;
  /** Optional human-readable detail (model id, engine name). */
  detail: string | null;
};

/** Hosting classes recognised by the catalog; anything else is `unknown`. */
export const HOSTING_CLASSES = [
  'public_cloud',
  'managed_cloud',
  'private_cloud',
  'edge_processing',
] as const;

export type HostingClass = (typeof HOSTING_CLASSES)[number];

export type HostingCount = { hosting: HostingClass; count: number };

export function isHostingClass(value: string): value is HostingClass {
  return (HOSTING_CLASSES as readonly string[]).includes(value);
}

/**
 * Count models per hosting class. A model listed under several classes is
 * counted once per class (a model genuinely available both self-hosted and in a
 * public cloud belongs to both columns), matching how the picker shows it.
 */
export function countHostingClasses(models: { availableHostingTypes?: string[] }[]): HostingCount[] {
  const tally = new Map<HostingClass, number>();
  for (const model of models) {
    for (const raw of model.availableHostingTypes ?? []) {
      if (!isHostingClass(raw)) continue;
      tally.set(raw, (tally.get(raw) ?? 0) + 1);
    }
  }
  return HOSTING_CLASSES.filter((h) => (tally.get(h) ?? 0) > 0).map((hosting) => ({
    hosting,
    count: tally.get(hosting) as number,
  }));
}

/** Inputs the classifier reads; all optional so a partial config is tolerated. */
export type PrivacyInputs = {
  /** Active chat model's hosting classes (empty when no model is selected). */
  chatModelHosting: string[];
  /** Region STT/TTS engine selection + whether an on-device model is available. */
  sttEngine?: 'cloud' | 'local';
  ttsEngine?: 'cloud' | 'local';
  localSttAvailable?: boolean;
  localTtsAvailable?: boolean;
  customSttEndpoint?: boolean;
  customTtsEndpoint?: boolean;
  /** Wake word: engine id when configured (e.g. `openwakeword`, `porcupine`). */
  wakeEngine?: string | null;
  /** True when wake/STT audio is streamed to region inference. */
  wakeUsesCloud?: boolean;
  /** True when the configured wake engine is absent. */
  wakeUnavailable?: boolean;
};

/**
 * Classify each pipeline stage. A selected `local` engine with no installed
 * model (and no custom endpoint) falls back to the region, so it reports
 * `region` — the honest answer, not the intent.
 */
export function classifyPipeline(input: PrivacyInputs): PipelineStageView[] {
  const llm = classifyHosting(input.chatModelHosting);

  const sttLocal = Boolean(input.localSttAvailable || input.customSttEndpoint);
  const ttsLocal = Boolean(input.localTtsAvailable || input.customTtsEndpoint);

  const stt: PipelineLocation | null =
    input.sttEngine == null ? null : input.sttEngine === 'local' && sttLocal ? 'onDevice' : 'region';
  const tts: PipelineLocation | null =
    input.ttsEngine == null ? null : input.ttsEngine === 'local' && ttsLocal ? 'onDevice' : 'region';

  const wake: PipelineLocation | null =
    input.wakeUnavailable || !input.wakeEngine
      ? null
      : input.wakeUsesCloud
        ? 'region'
        : 'onDevice';

  return [
    { id: 'llm', location: llm, detail: null },
    { id: 'stt', location: stt, detail: null },
    { id: 'tts', location: tts, detail: null },
    { id: 'wake', location: wake, detail: input.wakeEngine ?? null },
  ];
}

/**
 * Collapse a model's hosting classes into a single display verdict, preferring
 * the most private class the model can run on (self-hosted beats region beats
 * public cloud), because that is the answer to "can I keep this off the public
 * internet?".
 */
export function classifyHosting(hosting: string[]): PipelineLocation | null {
  if (!hosting.length) return null;
  if (hosting.includes('edge_processing')) return 'onDevice';
  if (hosting.includes('private_cloud')) return 'region';
  if (hosting.includes('managed_cloud')) return 'region';
  if (hosting.includes('public_cloud')) return 'publicCloud';
  return 'unknown';
}
