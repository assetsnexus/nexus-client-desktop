import { describe, expect, it } from 'vitest';
import {
  buildCompanionHash,
  parseCompanionHash,
  isCompanionHash,
  COMPANION_HASH_PREFIX,
} from './companion.js';

describe('buildCompanionHash / parseCompanionHash', () => {
  it('round-trips a full launch', () => {
    const launch = {
      contactId: 've-1',
      conversationId: 'conv-9',
      agentId: 'agent-3',
      virtualEmployeeId: 've-1',
      title: 'Aria',
      avatarUrl: 'https://x/avatar.png',
      autoStart: true,
      mode: 'split' as const,
    };
    expect(parseCompanionHash(buildCompanionHash(launch))).toEqual(launch);
  });

  it('keeps only the required field and defaults autoStart to true', () => {
    const parsed = parseCompanionHash(buildCompanionHash({ contactId: 've-1' }));
    expect(parsed).toEqual({
      contactId: 've-1',
      conversationId: null,
      agentId: null,
      virtualEmployeeId: null,
      title: null,
      avatarUrl: null,
      autoStart: true,
      mode: 'fullscreen',
    });
  });

  it('round-trips the split mode', () => {
    const parsed = parseCompanionHash(buildCompanionHash({ contactId: 've-1', mode: 'split' }));
    expect(parsed?.mode).toBe('split');
  });

  it('round-trips autoStart:false', () => {
    const parsed = parseCompanionHash(buildCompanionHash({ contactId: 've-1', autoStart: false }));
    expect(parsed?.autoStart).toBe(false);
  });

  it('drops empty / whitespace optional fields', () => {
    const hash = buildCompanionHash({ contactId: 've-1', title: '   ', conversationId: '' });
    expect(hash.includes('title')).toBe(false);
    expect(hash.includes('conversationId')).toBe(false);
  });

  it('encodes values that need escaping', () => {
    const parsed = parseCompanionHash(buildCompanionHash({ contactId: 'a b&c', title: 'x/y' }));
    expect(parsed?.contactId).toBe('a b&c');
    expect(parsed?.title).toBe('x/y');
  });
});

describe('parseCompanionHash rejection', () => {
  it('returns null for the plain app route, other routes, and empty hashes', () => {
    expect(parseCompanionHash('')).toBeNull();
    expect(parseCompanionHash('#')).toBeNull();
    expect(parseCompanionHash('#chat')).toBeNull();
    expect(parseCompanionHash('#scene?clusterId=1')).toBeNull();
  });

  it('returns null when contactId is missing', () => {
    expect(parseCompanionHash(`#${COMPANION_HASH_PREFIX}?title=x`)).toBeNull();
  });

  it('isCompanionHash mirrors parse', () => {
    expect(isCompanionHash(buildCompanionHash({ contactId: 'x' }))).toBe(true);
    expect(isCompanionHash('#chat')).toBe(false);
  });
});
