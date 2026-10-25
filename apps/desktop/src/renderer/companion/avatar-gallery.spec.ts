import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildAvatarChoices,
  createCompanionAvatarStore,
  cyclePictureIndex,
  isAvatarModelKind,
  isPictureAssetKind,
  latestTranscriptPreview,
  parseProfilePictures,
  pictureChoices,
  resolveAvatarSelection,
  resolveCarouselChoice,
  resolveCompanionStage,
  selectionToPresence,
  type CompanionAvatarAsset,
} from './avatar-gallery.js';

const contact = { id: 've-1', name: 'Aria', avatarUrl: 'https://cdn/a.png' };

function asset(over: Partial<CompanionAvatarAsset>): CompanionAvatarAsset {
  return { id: 'asset-1', kind: 'vrm', url: 'https://cdn/model.vrm', ...over };
}

describe('companion avatar gallery — choices', () => {
  it('puts the profile image first and the configured VRM next', () => {
    const choices = buildAvatarChoices({
      contact,
      presence: { v: 1, vrmUrl: 'https://cdn/agent.vrm', vrmAssetId: 'asset-9', vrmValidationStatus: 'verified' },
    });
    expect(choices.map((c) => c.id)).toEqual(['image:ve-1', 'presence:vrm']);
    expect(choices[0]).toMatchObject({ kind: 'image', url: 'https://cdn/a.png' });
    expect(choices[1]).toMatchObject({
      kind: 'vrm',
      url: 'https://cdn/agent.vrm',
      assetId: 'asset-9',
      validationStatus: 'verified',
    });
  });

  it('adds usable catalog VRMs and skips gesture packs, pictures and empty urls', () => {
    const assets: CompanionAvatarAsset[] = [
      asset({ id: 'm1', url: 'https://cdn/m1.vrm', name: 'M1' }),
      asset({ id: 'pic', kind: 'picture', url: 'https://cdn/pic.png' }),
      asset({ id: 'gesture', kind: 'vrma', url: 'https://cdn/wave.vrma' }),
      asset({ id: 'manifest', kind: 'manifest', url: 'https://cdn/gestures.manifest.json' }),
      asset({ id: 'none', url: null }),
      asset({ id: 'm2', url: 'https://cdn/m2.vrm', name: 'M2' }),
    ];
    const choices = buildAvatarChoices({ contact, presence: null, assets });
    // Only real avatar VRMs become model tiles — gesture packs never do.
    expect(choices.filter((c) => c.kind === 'vrm').map((c) => c.id)).toEqual(['vrm:m1', 'vrm:m2']);
    expect(choices.find((c) => c.id === 'vrm:m1')?.label).toBe('M1');
    expect(choices.some((c) => c.url?.endsWith('.vrma'))).toBe(false);
    expect(choices.some((c) => c.url?.endsWith('.manifest.json'))).toBe(false);
  });

  it('surfaces catalog portraits as switchable image choices', () => {
    const assets: CompanionAvatarAsset[] = [
      asset({ id: 'p1', kind: 'picture', url: 'https://cdn/portrait.png', name: 'Portrait' }),
    ];
    const choices = buildAvatarChoices({ contact: null, assets });
    expect(choices).toEqual([
      { id: 'image:p1', kind: 'image', label: 'Portrait', url: 'https://cdn/portrait.png' },
    ]);
  });

  it('collapses duplicate model urls', () => {
    const choices = buildAvatarChoices({
      contact,
      presence: { v: 1, vrmUrl: 'https://cdn/same.vrm' },
      assets: [asset({ id: 'dup', url: 'https://cdn/same.vrm' })],
    });
    expect(choices.filter((c) => c.kind === 'vrm')).toHaveLength(1);
  });

  it('rejects blob:/data: model URLs (never persisted)', () => {
    const choices = buildAvatarChoices({
      contact,
      presence: { v: 1, vrmUrl: 'blob:https://x/abc' },
      assets: [asset({ id: 'b', url: 'data:model/vrm;base64,AAAA' })],
    });
    expect(choices.some((c) => c.kind === 'vrm')).toBe(false);
  });

  it('returns just the image when there is no model, and nothing without any avatar', () => {
    expect(buildAvatarChoices({ contact }).map((c) => c.kind)).toEqual(['image']);
    expect(buildAvatarChoices({ contact: { id: 'x', name: 'X' } })).toEqual([]);
    expect(buildAvatarChoices({ contact: null })).toEqual([]);
  });

  it('classifies avatar model kinds (only vrm is an avatar; gestures are not)', () => {
    expect(isAvatarModelKind('vrm')).toBe(true);
    expect(isAvatarModelKind(undefined)).toBe(true); // legacy row, region default
    expect(isAvatarModelKind('VRM')).toBe(true);
    expect(isAvatarModelKind('vrma')).toBe(false); // gesture animation pack
    expect(isAvatarModelKind('manifest')).toBe(false); // gesture manifest
    expect(isAvatarModelKind('picture')).toBe(false);
  });

  it('classifies picture kinds', () => {
    expect(isPictureAssetKind('picture')).toBe(true);
    expect(isPictureAssetKind('image')).toBe(true);
    expect(isPictureAssetKind('portrait')).toBe(true);
    expect(isPictureAssetKind('vrm')).toBe(false);
    expect(isPictureAssetKind(undefined)).toBe(false);
  });
});

describe('companion avatar gallery — selection & fallback', () => {
  it('prefers a stored choice when it still exists', () => {
    const choices = buildAvatarChoices({ contact, presence: { v: 1, vrmUrl: 'https://cdn/agent.vrm' } });
    const resolved = resolveAvatarSelection(choices, 'image:ve-1');
    expect(resolved?.choice.kind).toBe('image');
    expect(resolved?.imageUrl).toBe('https://cdn/a.png');
    expect(resolved?.vrmUrl).toBeNull();
  });

  it('falls back to the first VRM when nothing is stored', () => {
    const choices = buildAvatarChoices({ contact, presence: { v: 1, vrmUrl: 'https://cdn/agent.vrm' } });
    const resolved = resolveAvatarSelection(choices, null);
    expect(resolved?.choice.kind).toBe('vrm');
    expect(resolved?.vrmUrl).toBe('https://cdn/agent.vrm');
    expect(resolved?.imageUrl).toBeNull();
  });

  it('falls back to the image when the stored VRM disappeared', () => {
    const choices = buildAvatarChoices({ contact });
    const resolved = resolveAvatarSelection(choices, 'presence:vrm');
    expect(resolved?.choice.kind).toBe('image');
  });

  it('returns null with no choices', () => {
    expect(resolveAvatarSelection([], null)).toBeNull();
  });
});

describe('companion avatar gallery — presence patch', () => {
  it('writes vrmUrl/vrmAssetId/vrmValidationStatus for a VRM choice', () => {
    const choices = buildAvatarChoices({
      contact: null,
      presence: { v: 1, vrmUrl: 'https://cdn/a.vrm', vrmAssetId: 'a1', vrmValidationStatus: 'verified' },
    });
    const resolved = resolveAvatarSelection(choices, 'presence:vrm');
    const doc = selectionToPresence(null, resolved);
    expect(doc.vrmUrl).toBe('https://cdn/a.vrm');
    expect(doc.vrmAssetId).toBe('a1');
    // Required, or the character kit blocks the fetch (missing_validation_status).
    expect(doc.vrmValidationStatus).toBe('verified');
  });

  it('carries the catalog validation status through a catalog selection', () => {
    const choices = buildAvatarChoices({
      contact: null,
      assets: [asset({ id: 'cat', url: 'https://cdn/cat.vrm', validationStatus: 'verified' })],
    });
    const resolved = resolveAvatarSelection(choices, 'vrm:cat');
    expect(resolved?.vrmValidationStatus).toBe('verified');
    expect(selectionToPresence(null, resolved).vrmValidationStatus).toBe('verified');
  });

  it('clears the VRM fields (including validation) for an image choice', () => {
    const choices = buildAvatarChoices({ contact });
    const resolved = resolveAvatarSelection(choices, 'image:ve-1');
    const doc = selectionToPresence(
      { v: 1, vrmUrl: 'https://cdn/old.vrm', vrmAssetId: 'old', vrmValidationStatus: 'verified' },
      resolved,
    );
    expect(doc.vrmUrl).toBeNull();
    expect(doc.vrmAssetId).toBeNull();
    expect(doc.vrmValidationStatus).toBeNull();
  });
});

describe('companion avatar gallery — pref store', () => {
  beforeEach(() => {
    // A tiny localStorage stand-in for the node test environment.
    const map = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: () => null,
      length: 0,
    } as unknown as Storage;
  });

  it('round-trips a pref per contact and tolerates junk', () => {
    const store = createCompanionAvatarStore('test');
    expect(store.get('ve-1')).toBeNull();
    store.set('ve-1', { mode: 'image', choiceId: 'image:ve-1' });
    expect(store.get('ve-1')).toEqual({ mode: 'image', choiceId: 'image:ve-1' });
    expect(store.get('ve-2')).toBeNull();
    localStorage.setItem('test:companion-avatar:v1:ve-3', '{"mode":"nope"}');
    expect(store.get('ve-3')).toBeNull();
  });
});

describe('latestTranscriptPreview', () => {
  it('returns the newest non-empty turn, trimmed and truncated', () => {
    expect(latestTranscriptPreview([{ role: 'user', text: '  hi   there ' }])).toBe('hi there');
    expect(latestTranscriptPreview([{ role: 'user', text: 'old' }, { role: 'assistant', text: 'new' }])).toBe('new');
    expect(latestTranscriptPreview([{ role: 'assistant', text: 'x'.repeat(200) }], 20)).toHaveLength(20);
    expect(latestTranscriptPreview([{ role: 'user', text: '   ' }])).toBe('');
    expect(latestTranscriptPreview([])).toBe('');
  });
});

describe('profile picture parsing (multi-picture region field)', () => {
  it('keeps fetchable urls and drops inline/empty/duplicate entries', () => {
    const parsed = parseProfilePictures([
      { url: 'https://cdn/a.png', primary: true, face: 'happy', label: 'A' },
      { url: 'blob:https://x/abc' },
      { url: 'data:image/png;base64,AAAA' },
      { url: '   ' },
      { url: 'https://cdn/a.png' },
      { url: '/public-files/b.png', addedAt: '2026-01-01T00:00:00.000Z' },
      'nope',
      null,
    ]);
    expect(parsed.map((p) => p.url)).toEqual(['https://cdn/a.png', '/public-files/b.png']);
    expect(parsed[0]).toMatchObject({ primary: true, face: 'happy', label: 'A' });
    expect(parsed[1]).toMatchObject({ addedAt: '2026-01-01T00:00:00.000Z' });
  });

  it('returns an empty list for a non-array / missing field', () => {
    expect(parseProfilePictures(undefined)).toEqual([]);
    expect(parseProfilePictures(null)).toEqual([]);
    expect(parseProfilePictures('https://cdn/a.png')).toEqual([]);
  });
});

describe('multi-picture carousel choices', () => {
  const multi = {
    id: 've-1',
    name: 'Aria',
    avatarUrl: 'https://cdn/primary.png',
    profilePictures: [
      { url: 'https://cdn/primary.png', primary: true },
      { url: 'https://cdn/alt.png', face: 'wink', label: 'Alt' },
    ],
  };

  it('expands profilePictures into ordered image tiles with the primary first', () => {
    const choices = buildAvatarChoices({ contact: multi });
    expect(choices.map((c) => c.id)).toEqual(['image:ve-1:0', 'image:ve-1:1']);
    expect(choices.map((c) => c.url)).toEqual(['https://cdn/primary.png', 'https://cdn/alt.png']);
    expect(choices.map((c) => c.pictureIndex)).toEqual([0, 1]);
    expect(choices[1]).toMatchObject({ pictureFace: 'wink', label: 'Alt' });
  });

  it('does not add a duplicate canonical tile when pictures exist', () => {
    const choices = buildAvatarChoices({ contact: multi });
    expect(choices.some((c) => c.id === 'image:ve-1')).toBe(false);
  });

  it('keeps the single canonical tile when profilePictures is absent', () => {
    const choices = buildAvatarChoices({ contact: { id: 've-1', name: 'Aria', avatarUrl: 'https://cdn/a.png' } });
    expect(choices).toEqual([
      { id: 'image:ve-1', kind: 'image', label: 'Profile image', url: 'https://cdn/a.png' },
    ]);
  });

  it('pictureChoices only returns the agent own pictures, not catalog portraits', () => {
    const choices = buildAvatarChoices({
      contact: multi,
      assets: [asset({ id: 'portrait', kind: 'picture', url: 'https://cdn/portrait.png' })],
    });
    expect(pictureChoices(choices).map((c) => c.pictureIndex)).toEqual([0, 1]);
  });

  it('resolveCarouselChoice clamps out-of-range indices and returns null for <2 pictures', () => {
    const choices = buildAvatarChoices({ contact: multi });
    expect(resolveCarouselChoice(choices, 1)?.pictureIndex).toBe(1);
    expect(resolveCarouselChoice(choices, 9)?.pictureIndex).toBe(0);
    expect(resolveCarouselChoice(choices, null)?.pictureIndex).toBe(0);
    const single = buildAvatarChoices({ contact: { id: 've-1', name: 'Aria', avatarUrl: 'https://cdn/a.png' } });
    expect(resolveCarouselChoice(single, 0)).toBeNull();
  });

  it('cyclePictureIndex wraps forward and backward', () => {
    const choices = buildAvatarChoices({ contact: multi });
    expect(cyclePictureIndex(choices, 0)).toBe(1);
    expect(cyclePictureIndex(choices, 1)).toBe(0);
    expect(cyclePictureIndex(choices, 0, -1)).toBe(1);
  });
});

describe('avatar show-mode toggle (3D vs picture)', () => {
  const contact = {
    id: 've-1',
    name: 'Aria',
    avatarUrl: 'https://cdn/primary.png',
    profilePictures: [
      { url: 'https://cdn/primary.png', primary: true },
      { url: 'https://cdn/alt.png' },
    ],
  };

  it('mode:image shows the carousel picture at the stored index', () => {
    const choices = buildAvatarChoices({
      contact,
      presence: { v: 1, vrmUrl: 'https://cdn/agent.vrm' },
    });
    const resolved = resolveCompanionStage(choices, {
      mode: 'image',
      choiceId: 'presence:vrm',
      pictureIndex: 1,
    });
    expect(resolved?.choice.kind).toBe('image');
    expect(resolved?.imageUrl).toBe('https://cdn/alt.png');
    expect(resolved?.vrmUrl).toBeNull();
  });

  it('mode:vrm shows the stored 3D model even when a picture was chosen before', () => {
    const choices = buildAvatarChoices({
      contact,
      presence: { v: 1, vrmUrl: 'https://cdn/agent.vrm' },
    });
    const resolved = resolveCompanionStage(choices, { mode: 'vrm', choiceId: 'presence:vrm' });
    expect(resolved?.choice.kind).toBe('vrm');
    expect(resolved?.vrmUrl).toBe('https://cdn/agent.vrm');
    expect(resolved?.imageUrl).toBeNull();
  });

  it('mode:vrm falls back to a picture when the agent has no 3D model', () => {
    const choices = buildAvatarChoices({ contact });
    const resolved = resolveCompanionStage(choices, { mode: 'vrm', choiceId: 'presence:vrm' });
    expect(resolved?.choice.kind).toBe('image');
  });

  it('mode:image falls back to a model when the agent has no picture', () => {
    const choices = buildAvatarChoices({
      contact: { id: 've-9', name: 'NoPic' },
      presence: { v: 1, vrmUrl: 'https://cdn/only.vrm' },
    });
    const resolved = resolveCompanionStage(choices, { mode: 'image', choiceId: 'image:ve-9' });
    expect(resolved?.choice.kind).toBe('vrm');
  });

  it('returns null with no choices and defers to resolveAvatarSelection without a pref', () => {
    expect(resolveCompanionStage([], { mode: 'image', choiceId: 'x' })).toBeNull();
    const choices = buildAvatarChoices({ contact, presence: { v: 1, vrmUrl: 'https://cdn/a.vrm' } });
    expect(resolveCompanionStage(choices, null)?.choice.kind).toBe('vrm');
  });

  it('persists the mode + carousel index per contact (and tolerates junk indices)', () => {
    const store = createCompanionAvatarStore('test2');
    store.set('ve-1', { mode: 'image', choiceId: 'image:ve-1:1', pictureIndex: 1 });
    expect(store.get('ve-1')).toEqual({ mode: 'image', choiceId: 'image:ve-1:1', pictureIndex: 1 });
    localStorage.setItem('test2:companion-avatar:v1:ve-2', '{"mode":"image","choiceId":"i","pictureIndex":"x"}');
    expect(store.get('ve-2')).toEqual({ mode: 'image', choiceId: 'i' });
  });
});

describe('latestTranscriptPreview', () => {
  it('returns the newest non-empty turn, trimmed and truncated', () => {
    expect(latestTranscriptPreview([{ role: 'user', text: '  hi   there ' }])).toBe('hi there');
    expect(latestTranscriptPreview([{ role: 'user', text: 'old' }, { role: 'assistant', text: 'new' }])).toBe('new');
    expect(latestTranscriptPreview([{ role: 'assistant', text: 'x'.repeat(200) }], 20)).toHaveLength(20);
    expect(latestTranscriptPreview([{ role: 'user', text: '   ' }])).toBe('');
    expect(latestTranscriptPreview([])).toBe('');
  });
});