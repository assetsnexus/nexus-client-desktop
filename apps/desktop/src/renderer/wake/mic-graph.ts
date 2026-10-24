/**
 * The app's shared microphone stream graph.
 *
 * One instance for the whole renderer so wake detection, dictation and the level
 * meter subscribe to **one** `getUserMedia` stream per device instead of each
 * opening their own. Module-scope because the graph must outlive any component.
 */

import { createMicStreamGraph, type MicStreamGraph } from '@nexus/voice-capture/mic';

let singleton: MicStreamGraph | null = null;

export function micGraph(): MicStreamGraph {
  if (!singleton) singleton = createMicStreamGraph();
  return singleton;
}
