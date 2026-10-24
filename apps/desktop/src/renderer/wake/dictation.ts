/**
 * Wake dictation (renderer).
 *
 * The end-of-speech policy, partial-preview cadence and capture lifecycle now
 * live in the reusable `@nexus/voice-capture` SDK so other clients share them.
 * This module is the desktop's thin re-export for the renderer's existing
 * imports (enrolment, the settings live test).
 *
 * TRUST: the transcript is an ordinary *user* message and carries no authority.
 * A wake word is not authentication and never approves anything.
 */

export {
  runDictation,
  type DictationCapture,
  type DictationOptions,
  type DictationSession,
  type DictationState,
  type UtteranceSource,
} from '@nexus/voice-capture';
