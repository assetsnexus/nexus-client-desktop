/**
 * Agent audio client-tool pack.
 *
 * Exposes the user's audio routing to the agent as a small, model-readable tool
 * set — the same "reusable SDK pack" pattern as the 3D character tools. The agent
 * can move its speech to another permitted speaker, broadcast to every permitted
 * speaker, or return to the primary. It can never reach a speaker the user did
 * not allow-list: {@link resolveOutputTargets} refuses anything unconfigured and
 * the handler surfaces that as a normal `ok:false` result the model can read.
 *
 * TRUST: this only ever *selects among devices the user already permitted*. It
 * does not grant new access, does not touch the microphone, and never authenticates.
 */

import {
  hasAgentOutputTargets,
  resolveOutputTargets,
  type AudioOutputTarget,
  type AudioSettings,
} from '../../shared/audio.js';

export type AudioToolDevice = { deviceId: string; label: string; available: boolean };

export type AudioToolDeps = {
  /** Current audio settings + device catalogue. */
  getSettings: () => AudioSettings;
  /** Selectable speakers (so the model can name a device id). */
  listOutputs: () => AudioToolDevice[];
  /** Where speech currently goes. */
  getTarget: () => AudioOutputTarget;
  /** Apply a new target; the caller performs the actual `setSinkId`/routing. */
  setTarget: (target: AudioOutputTarget) => void;
};

export type AudioToolDescriptor = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  availability: 'pinned' | 'discoverable';
};

export type AudioToolResult = {
  ok: boolean;
  name: string;
  message: string;
  data?: Record<string, unknown>;
};

const OUTPUT_TARGETS = ['primary', 'all'] as const;

/**
 * The static descriptors for the audio pack. Kept as a function so the tool list
 * is data-shaped (mirrors `buildCharacterToolDescriptors`) and testable.
 */
export function buildAudioToolDescriptors(): AudioToolDescriptor[] {
  return [
    {
      name: 'audio_list_outputs',
      description:
        'List the speakers this machine can play agent speech on, marking which are permitted and which is current.',
      parameters: { type: 'object', properties: {} },
      availability: 'discoverable',
    },
    {
      name: 'audio_set_output',
      description:
        'Route agent speech to a speaker. Use "primary" for the configured default, "all" to broadcast to every permitted speaker, or a specific device id from audio_list_outputs. A device the user has not permitted is refused.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'A device id, "primary" (default speaker), or "all" (every permitted speaker).',
          },
        },
        required: ['target'],
      },
      availability: 'pinned',
    },
  ];
}

/** Execute one audio tool call; always resolves (never throws) for the model. */
export function executeAudioTool(
  deps: AudioToolDeps,
  name: string,
  args: unknown,
): AudioToolResult {
  const tool = name.trim().replace(/\./g, '_');
  const callArgs = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const settings = deps.getSettings();

  if (tool === 'audio_list_outputs') {
    const permitted = new Set(resolveOutputTargets(settings, 'all'));
    const target = deps.getTarget();
    const outputs = deps.listOutputs().map((device) => ({
      ...device,
      permitted: permitted.has(device.deviceId) || device.deviceId === settings.output.primaryOutputId,
    }));
    return {
      ok: true,
      name: tool,
      message: outputs.length
        ? `Found ${outputs.length} speaker(s); current target "${target}".`
        : 'No output devices are visible; the OS default speaker is used.',
      data: { target, primaryOutputId: settings.output.primaryOutputId, outputs },
    };
  }

  if (tool === 'audio_set_output') {
    const raw = typeof callArgs.target === 'string' ? callArgs.target.trim() : '';
    if (!raw) {
      return { ok: false, name: tool, message: 'No target was provided.' };
    }
    if (!hasAgentOutputTargets(settings)) {
      return {
        ok: false,
        name: tool,
        message:
          'The user has not configured any speaker routing, so speech stays on the system default.',
      };
    }
    if (raw !== 'primary' && raw !== 'all') {
      const permitted = resolveOutputTargets(settings, raw);
      if (permitted.length === 0) {
        return {
          ok: false,
          name: tool,
          message: `Speaker "${raw}" is not permitted. Call audio_list_outputs to see allowed devices.`,
        };
      }
    }
    const resolved = resolveOutputTargets(settings, raw);
    deps.setTarget(raw);
    const label =
      raw === 'primary' ? 'the primary speaker' : raw === 'all' ? 'every permitted speaker' : raw;
    return {
      ok: true,
      name: tool,
      message: `Agent speech now routes to ${label}.`,
      data: { target: raw, devices: resolved },
    };
  }

  return { ok: false, name: tool, message: `Unknown audio tool "${name}".` };
}

/** Register the audio pack against a chat-style tool registry (descriptor + handler). */
export function registerAudioTools(
  deps: () => AudioToolDeps,
  register: (
    descriptor: AudioToolDescriptor,
    handler: (args: unknown) => unknown,
  ) => void,
): string[] {
  const descriptors = buildAudioToolDescriptors();
  for (const descriptor of descriptors) {
    register(descriptor, (args: unknown) => executeAudioTool(deps(), descriptor.name, args));
  }
  return descriptors.map((d) => d.name);
}

export { OUTPUT_TARGETS };
