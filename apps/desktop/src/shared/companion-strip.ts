/**
 * Dictation-strip gate for a companion window.
 *
 * The companion shows the live STT preview + composer only when all three
 * conditions hold, and each has failed at least once:
 *
 *  - `dictate` — the wake asked *this* companion to be its dictation surface.
 *    A voice-mode presentation, or a demotion, clears it so the strip can never
 *    offer a second capture beside the realtime call.
 *  - `sttPrimary` — this window won the single-owner election. Every companion
 *    keeps rendering its avatar, but only the primary may capture.
 *  - not on a live call — the call owns the microphone.
 *
 * Kept out of {@link CompanionView} so the wake → strip contract is testable
 * without mounting the 3D stage (and so the condition cannot drift between the
 * component and its tests).
 */
export function showsDictationStrip(input: {
  /** The wake presented this window in dictation mode. */
  dictate: boolean;
  /** This window currently owns speech-to-text. */
  sttPrimary: boolean;
  /** A realtime voice call is running in this window. */
  voiceActive: boolean;
}): boolean {
  return input.dictate && !input.voiceActive && input.sttPrimary;
}
