/**
 * Companion 3D client-tool pack.
 *
 * Maps the character-kit `CHARACTER_SKILL.allTools()` schema set (character_*,
 * locomotion + scene) into `ChatToolDescriptor`s the desktop chat registry can
 * execute against a live `CompanionHost`. This is the reusable "3D scene tools"
 * pack the companion/agent-chat surface links per agent.
 *
 * Split of responsibilities (matches character-kit internals):
 * - **immediate** tools (walk / turn / stop / jump / teleport / approach /
 *   turn_to / scene_*) go through `controller.applyToolCall` — they mutate the
 *   rig transform right away;
 * - **deferred** tools (gesture / face / sequence / wait / cancel) go through
 *   `director.runToolCall` so they ride the action feed and respect generation
 *   cancellation.
 *
 * Pure + host-shaped so it is unit-testable without Three.js.
 */

export type CharacterToolHostLike = {
  applyToolCall?: (name: string, args: Record<string, unknown>) => ToolResultLike;
  runToolCall?: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<ToolResultLike> | ToolResultLike;
  setMood?: (mood: string, source?: string, detail?: string) => boolean;
};

/**
 * Stage host the companion binds to: the tool-execution surface plus the action
 * feed and gesture catalogue the debug panels read. Both the flat
 * `CompanionHost` and the single-avatar scene façade satisfy it.
 */
export type CompanionStageHost = CharacterToolHostLike & {
  playGesture?: (
    id: string,
    loop?: boolean,
    source?: string,
    detail?: string,
  ) => unknown;
  pausePresence?: (reason?: string) => void;
  resumePresence?: () => void;
  listLoadedGestures?: () => Array<{
    id: string;
    durationMs: number | null;
    loop: boolean;
    overlay: boolean;
    description?: string;
  }>;
  listGestures?: () => string[];
  onAction?: (listener: (ev: unknown) => void) => () => void;
  /**
   * OS-global cursor feed: push a gaze NDC and route gaze through the external
   * feed so the avatar follows the pointer outside the window.
   */
  setPointerNdc?: (x: number, y: number) => void;
  setExternalPointerEnabled?: (on: boolean) => void;
  /**
   * Gaze cone (head/neck turn) in degrees. Widen for a companion that tracks the
   * cursor across a whole screen; the tight library default reads as barely moving.
   */
  setGazeLimits?: (limits: {
    headYawMaxDeg?: number;
    headPitchMaxDeg?: number;
    eyeYawMaxDeg?: number;
    eyePitchMaxDeg?: number;
  }) => unknown;
  /** Click nod (configurable gesture) enable / pick. */
  setClickAck?: (opts: { enabled?: boolean; gesture?: string }) => unknown;
  /**
   * Hard-reset the avatar to its idle rest pose: halts any clip still holding
   * weight and snaps the skeleton back to a relaxed stance. Wired to the scene
   * context menu's "Reset pose" escape hatch and safe to call at any time.
   */
  resetPose?: (reason?: string) => void;
  /**
   * Analog locomotion input (WASD keys / a virtual stick). `x`/`z` are
   * strafe/forward in `[-1, 1]`, `jump` is a rising-edge pulse. `null` clears the
   * input (e.g. on window blur) so a held key does not keep the rig walking after
   * focus is lost. Wired to the companion window's keyboard handler.
   */
  setMoveInput?: (input: { x?: number; z?: number; yaw?: number; jump?: boolean } | null) => void;
  /** Max stick speed (m/s): walk gait by default, run while Shift is held. */
  setAnalogSpeed?: (speed: number) => void;
  /** Current ground pose + facing, for the outbound turn metadata (Deliverable 4). */
  getPoseFeedback?: (nearbyRadiusM?: number) => Record<string, unknown> | null;
  /** Read-only gaze snapshot (head vs eye aim, limits) for live debugging. */
  getGazeDebugState?: () => Record<string, unknown> | null;
  /** Per-bone angle (deg) off rest, keyed by VRM bone name, for live gesture audits. */
  getBonePoseDeg?: () => Record<string, number> | null;
};

export type ToolResultLike = {
  ok: boolean;
  name: string;
  message: string;
  data?: Record<string, unknown>;
};

export type CharacterToolDescriptor = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /**
   * `pinned` for the everyday tools (gesture / mood / locomotion); `discoverable`
   * for the long tail (scene inspection, lists) so 20+ schemas do not ride every
   * send.
   */
  availability: 'pinned' | 'discoverable';
};

/** Shape of one `CHARACTER_SKILL.allTools()` entry (OpenAI function schema). */
export type CharacterToolSchema = {
  type?: string;
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

/**
 * Tools that mutate the rig transform synchronously. Everything else is
 * deferred through the director (gestures, faces, sequences, waits, cancels).
 */
const IMMEDIATE_TOOLS = new Set([
  'character_walk',
  'character_turn',
  'character_stop',
  'character_jump',
  'character_teleport',
  'character_approach',
  'character_turn_to',
  'scene_list_objects',
  'scene_overview',
  'scene_get_object',
]);

/** Inspection / catalogue tools that should not be pinned on every send. */
const DISCOVERABLE_TOOLS = new Set([
  'scene_list_objects',
  'scene_overview',
  'scene_get_object',
  'scene_move_object',
  'scene_glow_object',
  'character_list_gestures',
  'character_list_expressions',
  'character_list_moods',
  'character_list_clothes',
]);

export function isImmediateCharacterToolName(name: string): boolean {
  return IMMEDIATE_TOOLS.has(normalizeToolName(name));
}

export function characterToolAvailability(name: string): 'pinned' | 'discoverable' {
  return DISCOVERABLE_TOOLS.has(normalizeToolName(name)) ? 'discoverable' : 'pinned';
}

/** `character.play_gesture` → `character_play_gesture` (and pass through). */
export function normalizeToolName(name: string): string {
  return typeof name === 'string' ? name.trim().replace(/\./g, '_') : '';
}

/** Build the descriptor list from a character-kit schema array. */
export function buildCharacterToolDescriptors(
  schemas: readonly CharacterToolSchema[],
): CharacterToolDescriptor[] {
  return schemas
    .map((schema) => {
      const fn = schema?.function;
      const name = normalizeToolName(fn?.name);
      if (!name) return null;
      const description = typeof fn.description === 'string' ? fn.description.trim() : '';
      return {
        name,
        description: description || `Character tool ${name}`,
        parameters: (fn.parameters ?? { type: 'object', properties: {} }) as Record<string, unknown>,
        availability: characterToolAvailability(name),
      } satisfies CharacterToolDescriptor;
    })
    .filter((d): d is CharacterToolDescriptor => d !== null);
}

/**
 * Execute one character tool call against a live host. Returns a model-readable
 * `ToolResultLike`; an `ok:false` result is passed through unchanged so the model
 * can read the failure message.
 *
 * Everything is routed through `host.runToolCall` (the AnimationDirector): it
 * dispatches immediate transform ops to the controller synchronously, runs
 * gestures/faces/sequences on the timeline, records every op on the motion feed,
 * and awaits locomotion arrival so a walk result reports the real pose. Only a
 * host without a director falls back to the synchronous `applyToolCall` path.
 */
export async function executeCharacterTool(
  host: CharacterToolHostLike | null | undefined,
  name: string,
  args: unknown,
): Promise<ToolResultLike> {
  const toolName = normalizeToolName(name);
  const callArgs = isRecord(args) ? args : {};
  if (!host) {
    return { ok: false, name: toolName, message: 'no 3D companion host mounted' };
  }
  try {
    if (host.runToolCall) {
      return await host.runToolCall(toolName, callArgs);
    }
    if (isImmediateCharacterToolName(toolName)) {
      if (!host.applyToolCall) {
        return { ok: false, name: toolName, message: 'host cannot apply transform tools' };
      }
      return host.applyToolCall(toolName, callArgs);
    }
    return { ok: false, name: toolName, message: 'host cannot run timeline tools' };
  } catch (err) {
    return {
      ok: false,
      name: toolName,
      message: err instanceof Error ? err.message : 'character tool failed',
    };
  }
}

/**
 * Register every tool in the pack against a host-shaped registry. Returns the
 * registered names so the caller can unregister / assert.
 *
 * `register` mirrors the chat-core `registerTool` signature (descriptor +
 * handler).
 */
export function registerCharacterTools(
  schemas: readonly CharacterToolSchema[],
  host: () => CharacterToolHostLike | null,
  register: (descriptor: CharacterToolDescriptor, handler: (args: unknown) => unknown) => void,
): string[] {
  const descriptors = buildCharacterToolDescriptors(schemas);
  for (const descriptor of descriptors) {
    register(descriptor, (args: unknown) => executeCharacterTool(host(), descriptor.name, args));
  }
  return descriptors.map((d) => d.name);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
