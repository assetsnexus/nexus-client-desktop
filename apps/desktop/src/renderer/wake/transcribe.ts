/**
 * Wake dictation transcription (renderer).
 *
 * Resolves a speech-to-text model from the caller's subscription (preferring
 * Whisper, exactly like the chat composer) and turns a captured audio blob into
 * text. Kept separate so the model-resolution policy is unit-testable and so the
 * heavy `@nexus/chat-core` STT path is imported lazily.
 *
 * TRUST: audio is sent to the region inference workload the user is entitled to,
 * under their own token — the same path a manual dictation uses. Nothing is sent
 * before a wake has already fired and the user has an authenticated session.
 */

export type TranscribeDeps = {
  /** List entitled models (the caller passes `chat.listAvailableModels`). */
  listModels: () => Promise<{ models: Array<Record<string, unknown>> }>;
  /** The region command client (for the STT create/poll workload). */
  client: unknown;
};

/** Candidate model ids, best-first: prefer an explicit Whisper model. */
export function rankSttModels(models: Array<Record<string, unknown>>): string[] {
  const ids: string[] = [];
  for (const model of models) {
    const caps = Array.isArray(model.capabilities)
      ? model.capabilities.map((c) => String(c).toLowerCase())
      : [];
    const isStt = caps.some((cap) => cap.includes('audio_input') || cap === 'stt' || cap === 'audio');
    if (!isStt) continue;
    const id = String(model.id || model.modelRef || '').trim();
    if (id) ids.push(id);
  }
  // Whisper first (best local/region speech model), then the rest in order.
  return ids.sort((a, b) => {
    const aw = a.toLowerCase().includes('whisper') ? 0 : 1;
    const bw = b.toLowerCase().includes('whisper') ? 0 : 1;
    return aw - bw;
  });
}

/**
 * Resolve an STT model id and transcribe a captured blob. Returns null when no
 * model is entitled or nothing was recognised; throws only on a hard transport
 * failure so the caller can distinguish "no speech" from "could not transcribe".
 */
export async function transcribeUtterance(
  deps: TranscribeDeps,
  blob: Blob,
): Promise<string | null> {
  const catalog = await deps.listModels();
  const [modelId] = rankSttModels(catalog.models ?? []);
  if (!modelId) return null;
  const { transcribeOrNull } = await import('@nexus/chat-core');
  const result = await transcribeOrNull(deps.client as never, { modelId, audioBlob: blob });
  const text = result.text?.trim();
  return text ? text : null;
}
