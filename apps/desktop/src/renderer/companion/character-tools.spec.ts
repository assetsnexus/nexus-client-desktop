import { describe, expect, it, vi } from 'vitest';

import {
  buildCharacterToolDescriptors,
  characterToolAvailability,
  executeCharacterTool,
  isImmediateCharacterToolName,
  normalizeToolName,
  registerCharacterTools,
  type CharacterToolHostLike,
  type CharacterToolSchema,
} from './character-tools';

const SCHEMAS: CharacterToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'character.play_gesture',
      description: 'Play a gesture',
      parameters: { type: 'object', properties: { gesture: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'character.set_mood',
      description: 'Set mood',
      parameters: { type: 'object', properties: { mood: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'character.walk',
      description: 'Walk to a point',
      parameters: { type: 'object', properties: { x: { type: 'number' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scene.list_objects',
      description: 'List scene objects',
      parameters: { type: 'object', properties: {} },
    },
  },
];

function makeHost(): CharacterToolHostLike & { calls: Array<[string, string, unknown]> } {
  const calls: Array<[string, string, unknown]> = [];
  return {
    calls,
    applyToolCall: (name, args) => {
      calls.push(['apply', name, args]);
      return { ok: true, name, message: `applied ${name}` };
    },
    runToolCall: (name, args) => {
      calls.push(['run', name, args]);
      return { ok: true, name, message: `ran ${name}` };
    },
  };
}

describe('normalizeToolName', () => {
  it('rewrites dotted names to underscored', () => {
    expect(normalizeToolName('character.play_gesture')).toBe('character_play_gesture');
  });

  it('passes through already-normalized names and trims', () => {
    expect(normalizeToolName('  character_walk ')).toBe('character_walk');
  });

  it('tolerates non-strings', () => {
    expect(normalizeToolName(undefined as unknown as string)).toBe('');
  });});

describe('isImmediateCharacterToolName', () => {
  it('classifies transform tools as immediate', () => {
    expect(isImmediateCharacterToolName('character_walk')).toBe(true);
    expect(isImmediateCharacterToolName('character.turn_to')).toBe(true);
    expect(isImmediateCharacterToolName('scene_get_object')).toBe(true);
  });

  it('classifies timeline tools as deferred', () => {
    expect(isImmediateCharacterToolName('character_play_gesture')).toBe(false);
    expect(isImmediateCharacterToolName('character_set_mood')).toBe(false);
    expect(isImmediateCharacterToolName('character_wait')).toBe(false);
  });
});

describe('characterToolAvailability', () => {
  it('pins everyday tools and keeps catalog tools discoverable', () => {
    expect(characterToolAvailability('character_play_gesture')).toBe('pinned');
    expect(characterToolAvailability('scene_list_objects')).toBe('discoverable');
    expect(characterToolAvailability('character_list_gestures')).toBe('discoverable');
  });
});

describe('buildCharacterToolDescriptors', () => {
  it('normalizes names, keeps schemas and marks availability', () => {
    const descriptors = buildCharacterToolDescriptors(SCHEMAS);
    expect(descriptors.map((d) => d.name)).toEqual([
      'character_play_gesture',
      'character_set_mood',
      'character_walk',
      'scene_list_objects',
    ]);
    expect(descriptors[3].availability).toBe('discoverable');
    expect(descriptors[0].availability).toBe('pinned');
    expect(descriptors[2].parameters).toEqual({
      type: 'object',
      properties: { x: { type: 'number' } },
    });
  });

  it('drops malformed entries and fills a default description/parameters', () => {
    const descriptors = buildCharacterToolDescriptors([
      { function: { name: '', description: 'x', parameters: {} } } as CharacterToolSchema,
      { function: { name: 'character_blink', description: '', parameters: undefined as never } },
    ]);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0].name).toBe('character_blink');
    expect(descriptors[0].description).toBe('Character tool character_blink');
    expect(descriptors[0].parameters).toEqual({ type: 'object', properties: {} });
  });
});

describe('executeCharacterTool', () => {
  it('routes every tool through the director so the motion feed sees it', async () => {
    const host = makeHost();
    const result = await executeCharacterTool(host, 'character.walk', { x: 2 });
    expect(result.ok).toBe(true);
    expect(host.calls).toEqual([['run', 'character_walk', { x: 2 }]]);
  });

  it('routes gesture/face tools through the director timeline path', async () => {
    const host = makeHost();
    await executeCharacterTool(host, 'character.play_gesture', { gesture: 'wave' });
    expect(host.calls).toEqual([['run', 'character_play_gesture', { gesture: 'wave' }]]);
  });

  it('coerces non-object args to an empty record', async () => {
    const host = makeHost();
    await executeCharacterTool(host, 'character_jump', null);
    expect(host.calls[0]).toEqual(['run', 'character_jump', {}]);
  });

  it('falls back to the synchronous controller path without a director', async () => {
    const calls: Array<[string, unknown]> = [];
    const host: CharacterToolHostLike = {
      applyToolCall: (name, args) => {
        calls.push([name, args]);
        return { ok: true, name, message: `applied ${name}` };
      },
    };
    const result = await executeCharacterTool(host, 'character_walk', { x: 1 });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([['character_walk', { x: 1 }]]);
  });

  it('returns a readable failure with no host mounted', async () => {
    const result = await executeCharacterTool(null, 'character_walk', {});
    expect(result).toEqual({
      ok: false,
      name: 'character_walk',
      message: 'no 3D companion host mounted',
    });
  });

  it('reports missing capability rather than throwing', async () => {
    const result = await executeCharacterTool(
      { applyToolCall: undefined },
      'character.play_gesture',
      {},
    );
    expect(result.ok).toBe(false);
    expect(result.message).toBe('host cannot run timeline tools');
  });

  it('captures thrown errors as a failed result', async () => {
    const host: CharacterToolHostLike = {
      applyToolCall: vi.fn(() => {
        throw new Error('boom');
      }),
    };
    const result = await executeCharacterTool(host, 'character_walk', {});
    expect(result).toEqual({ ok: false, name: 'character_walk', message: 'boom' });
  });
});

describe('registerCharacterTools', () => {
  it('registers each descriptor and executes against the live host getter', async () => {
    const host = makeHost();
    const registered: Array<{
      name: string;
      availability: string;
      run: (args: unknown) => unknown;
    }> = [];
    const names = registerCharacterTools(SCHEMAS, () => host, (descriptor, handler) => {
      registered.push({
        name: descriptor.name,
        availability: descriptor.availability,
        run: handler as (args: unknown) => unknown,
      });
    });

    expect(names).toHaveLength(4);
    expect(registered.map((r) => r.name)).toEqual(names);

    await registered[0].run({ gesture: 'clap' });
    await registered[2].run({ x: 1 });
    expect(host.calls).toEqual([
      ['run', 'character_play_gesture', { gesture: 'clap' }],
      ['run', 'character_walk', { x: 1 }],
    ]);
  });

  it('degrades gracefully when the host is not mounted at call time', async () => {
    const registered: Array<(args: unknown) => unknown> = [];
    registerCharacterTools(SCHEMAS, () => null, (_d, handler) =>
      registered.push(handler as (args: unknown) => unknown),
    );
    const result = (await registered[0]({})) as { ok: boolean; message: string };
    expect(result.ok).toBe(false);
    expect(result.message).toBe('no 3D companion host mounted');
  });
});
