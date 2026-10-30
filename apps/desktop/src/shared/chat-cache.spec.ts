import { describe, expect, it } from 'vitest';
import {
  CHAT_CACHE_MAX_MIB_CHOICES,
  DEFAULT_CHAT_CACHE_MAX_BYTES,
  normalizeChatCacheSettings,
  selectChatCacheRetained,
  BYTES_PER_MIB,
} from './chat-cache.js';

describe('chat cache settings', () => {
  it('defaults to 100 MiB and offers it as a choice', () => {
    expect(DEFAULT_CHAT_CACHE_MAX_BYTES).toBe(100 * BYTES_PER_MIB);
    expect(CHAT_CACHE_MAX_MIB_CHOICES).toContain(100);
    // 0 is always offered so the user can disable the bound.
    expect(CHAT_CACHE_MAX_MIB_CHOICES).toContain(0);
  });

  it('normalizes garbage back to the default and accepts 0 (unbounded)', () => {
    expect(normalizeChatCacheSettings(null)).toEqual({ maxBytes: DEFAULT_CHAT_CACHE_MAX_BYTES });
    expect(normalizeChatCacheSettings({ maxBytes: 'nope' })).toEqual({
      maxBytes: DEFAULT_CHAT_CACHE_MAX_BYTES,
    });
    expect(normalizeChatCacheSettings({ maxBytes: -5 }).maxBytes).toBe(
      DEFAULT_CHAT_CACHE_MAX_BYTES,
    );
    expect(normalizeChatCacheSettings({ maxBytes: 0 })).toEqual({ maxBytes: 0 });
    expect(normalizeChatCacheSettings({ maxBytes: 50 * BYTES_PER_MIB }).maxBytes).toBe(
      50 * BYTES_PER_MIB,
    );
  });
});

describe('selectChatCacheRetained', () => {
  const entry = (key: string, touched: number, bytes: number) => ({ key, touched, bytes });

  it('keeps everything when the bound is disabled (0)', () => {
    const rows = [entry('a', 1, 10), entry('b', 2, 20)];
    const { kept, evicted, bytes } = selectChatCacheRetained(rows, 0);
    expect(kept).toHaveLength(2);
    expect(evicted).toBe(0);
    expect(bytes).toBe(30);
  });

  it('evicts the least-recently-touched first', () => {
    const rows = [entry('old', 1, 60), entry('mid', 2, 60), entry('new', 3, 60)];
    const { kept, evicted } = selectChatCacheRetained(rows, 120);
    // Budget = 120 → the two newest survive.
    expect(kept.map((r) => r.key).sort()).toEqual(['mid', 'new']);
    expect(evicted).toBe(1);
  });

  it('always keeps the freshly-written key even when it alone exceeds the bound', () => {
    const rows = [entry('big', 5, 500), entry('small', 1, 10)];
    const { kept } = selectChatCacheRetained(rows, 50, { keepKeys: ['big'] });
    expect(kept.map((r) => r.key)).toContain('big');
  });

  it('is deterministic for ties', () => {
    const rows = [entry('a', 1, 30), entry('b', 1, 30)];
    const first = selectChatCacheRetained(rows, 40).kept.map((r) => r.key);
    const second = selectChatCacheRetained(rows, 40).kept.map((r) => r.key);
    expect(first).toEqual(second);
  });
});
