import { describe, expect, it } from 'vitest';
import {
  avatarIdSlug,
  avatarKindFromFileName,
  avatarLabelFromFileName,
  isSupportedAvatarFileName,
  localAvatarFileNameFromPath,
  localAvatarUrl,
  mappedAvatarId,
  normalizeContactMappings,
  normalizeLocalAvatarRecord,
  normalizeLocalAvatarsConfig,
  pruneContactMappings,
  removeLocalAvatar,
  type LocalAvatarRecord,
} from './local-avatars.js';

function record(over: Partial<LocalAvatarRecord> = {}): LocalAvatarRecord {
  return {
    id: 'aria',
    label: 'Aria',
    kind: 'vrm',
    filePath: '/data/avatar-library/aria.vrm',
    fileName: 'Aria.vrm',
    sizeBytes: 1024,
    addedAt: 1,
    ...over,
  };
}

describe('avatar file-name helpers', () => {
  it('recognises .vrm and .glb case-insensitively and nothing else', () => {
    expect(avatarKindFromFileName('Aria.VRM')).toBe('vrm');
    expect(avatarKindFromFileName('robot.glb')).toBe('glb');
    expect(avatarKindFromFileName('notes.txt')).toBeNull();
    expect(avatarKindFromFileName('avatar.fbx')).toBeNull();
    expect(isSupportedAvatarFileName('  x.vrm ')).toBe(true);
    expect(isSupportedAvatarFileName('')).toBe(false);
  });

  it('derives a label from the file name and a filesystem-safe id', () => {
    expect(avatarLabelFromFileName('My Avatar (final).VRM')).toBe('My Avatar (final)');
    expect(avatarLabelFromFileName('.vrm')).toBe('Avatar');
    expect(avatarLabelFromFileName('')).toBe('Avatar');
    expect(avatarIdSlug('My Avatar (final).VRM')).toBe('my-avatar-final');
    expect(avatarIdSlug('###')).toBe('avatar');
  });
});

describe('normalizeLocalAvatarRecord', () => {
  it('keeps a well-formed record', () => {
    expect(normalizeLocalAvatarRecord(record())).toEqual(record());
  });

  it('drops records without an id / path / supported extension', () => {
    expect(normalizeLocalAvatarRecord(null)).toBeNull();
    expect(normalizeLocalAvatarRecord({})).toBeNull();
    expect(normalizeLocalAvatarRecord({ id: 'x', filePath: '' })).toBeNull();
    // A path that is not a model file cannot be offered as an avatar.
    expect(normalizeLocalAvatarRecord({ id: 'x', filePath: '/tmp/notes.txt' })).toBeNull();
  });

  it('back-fills a label and file name from the path and clamps numbers', () => {
    const out = normalizeLocalAvatarRecord({
      id: 'aria',
      filePath: '/lib/aria.vrm',
      sizeBytes: -4,
      addedAt: 'nope',
    });
    expect(out).toMatchObject({ label: 'aria', fileName: 'aria.vrm', sizeBytes: 0, addedAt: 0 });
  });

  it('accepts a .glb path detected by extension even without a kind field', () => {
    expect(normalizeLocalAvatarRecord({ id: 'r', filePath: '/lib/r.glb' })?.kind).toBe('glb');
  });
});

describe('normalizeLocalAvatarsConfig', () => {
  it('keeps the first of duplicate ids and drops junk mappings', () => {
    const config = normalizeLocalAvatarsConfig({
      avatars: [record(), record({ label: 'Shadow' })],
      contactMappings: { 'c1': 'aria', '  ': 'aria', 'c2': 5 },
    });
    expect(config.avatars).toHaveLength(1);
    expect(config.avatars[0]!.label).toBe('Aria');
    expect(config.contactMappings).toEqual({ c1: 'aria' });
  });

  it('returns an empty config for anything that is not an object', () => {
    expect(normalizeLocalAvatarsConfig(undefined)).toEqual({ avatars: [], contactMappings: {} });
    expect(normalizeContactMappings([1, 2])).toEqual({});
  });
});

describe('mappings', () => {
  const config = { avatars: [record()], contactMappings: { 'agent-a': 'aria', 'agent-b': 'gone' } };

  it('resolves a mapping only when the target is still in the library', () => {
    expect(mappedAvatarId(config, 'agent-a')).toBe('aria');
    expect(mappedAvatarId(config, 'agent-b')).toBeNull();
    expect(mappedAvatarId(config, null)).toBeNull();
  });

  it('prunes dangling mappings', () => {
    const { config: pruned, changed } = pruneContactMappings(config);
    expect(changed).toBe(true);
    expect(pruned.contactMappings).toEqual({ 'agent-a': 'aria' });
  });

  it('removing an avatar drops the mappings that pointed at it', () => {
    const next = removeLocalAvatar(config, 'aria');
    expect(next.avatars).toEqual([]);
    expect(next.contactMappings).toEqual({});
    // A no-op removal returns the same object (so the store can skip a write).
    expect(removeLocalAvatar(next, 'missing')).toBe(next);
  });
});

describe('serve URLs', () => {
  it('builds a scheme URL per kind', () => {
    expect(localAvatarUrl({ id: 'aria', kind: 'vrm' })).toBe('nexus-avatar://avatar/aria.vrm');
    expect(localAvatarUrl({ id: 'bot2', kind: 'glb' })).toBe('nexus-avatar://avatar/bot2.glb');
  });

  it('accepts only a single-segment model path', () => {
    expect(localAvatarFileNameFromPath('/aria.vrm')).toBe('aria.vrm');
    expect(localAvatarFileNameFromPath('/aria.glb')).toBe('aria.glb');
    expect(localAvatarFileNameFromPath('/../secret.vrm')).toBeNull();
    expect(localAvatarFileNameFromPath('/nested/aria.vrm')).toBeNull();
    expect(localAvatarFileNameFromPath('/notes.txt')).toBeNull();
    expect(localAvatarFileNameFromPath('/')).toBeNull();
  });
});
