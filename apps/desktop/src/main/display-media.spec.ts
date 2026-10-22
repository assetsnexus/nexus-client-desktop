import { describe, expect, it } from 'vitest';
import { pickDisplaySource, type DisplaySourceLike } from './display-media.js';

const screen = (id: string): DisplaySourceLike => ({ id, name: id });
const win = (id: string): DisplaySourceLike => ({ id, name: id });

describe('pickDisplaySource', () => {
  it('returns null for an empty list', () => {
    expect(pickDisplaySource([])).toBeNull();
  });

  it('prefers a screen source over windows even when windows come first', () => {
    const picked = pickDisplaySource([win('window:1'), screen('screen:0'), win('window:2')]);
    expect(picked?.id).toBe('screen:0');
  });

  it('falls back to the first source when no screen is present', () => {
    const picked = pickDisplaySource([win('window:1'), win('window:2')]);
    expect(picked?.id).toBe('window:1');
  });

  it('handles a single source', () => {
    expect(pickDisplaySource([screen('screen:2')])?.id).toBe('screen:2');
  });
});
