import { describe, expect, it } from 'vitest';
import {
  buildCompanionHash,
  parseCompanionHash,
  isCompanionHash,
  electSttOwner,
  sttOwnerMessage,
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
      roomId: 'room-7',
      autoStart: true,
      mode: 'split' as const,
      alwaysOnTop: true,
    };
    expect(parseCompanionHash(buildCompanionHash(launch))).toEqual(launch);
  });

  it('round-trips a room launch so the companion can render the shared scene', () => {
    const parsed = parseCompanionHash(
      buildCompanionHash({ contactId: 've-1', roomId: 'room-7' }),
    );
    expect(parsed?.roomId).toBe('room-7');
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
      roomId: null,
      autoStart: true,
      mode: 'fullscreen',
      alwaysOnTop: false,
    });
  });

  it('round-trips the split mode', () => {
    const parsed = parseCompanionHash(buildCompanionHash({ contactId: 've-1', mode: 'split' }));
    expect(parsed?.mode).toBe('split');
  });

  it('round-trips alwaysOnTop (and defaults it off)', () => {
    expect(parseCompanionHash(buildCompanionHash({ contactId: 've-1' }))?.alwaysOnTop).toBe(false);
    expect(parseCompanionHash(buildCompanionHash({ contactId: 've-1', alwaysOnTop: true }))?.alwaysOnTop).toBe(
      true,
    );
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

describe('electSttOwner (single-owner speech-to-text)', () => {
  it('promotes a wake target and demotes the previous owner', () => {
    expect(electSttOwner({ current: 've-1', next: 've-2', reason: 'wake' })).toEqual({
      primaryContactId: 've-2',
      previousContactId: 've-1',
      reason: 'wake',
    });
  });

  it('picks the first owner when none held the mic', () => {
    expect(electSttOwner({ current: null, next: 've-1', reason: 'opened' })).toEqual({
      primaryContactId: 've-1',
      previousContactId: null,
      reason: 'opened',
    });
  });

  it('returns null for a redundant switch (no IPC, no call restart)', () => {
    expect(electSttOwner({ current: 've-1', next: 've-1', reason: 'focus' })).toBeNull();
    expect(electSttOwner({ current: null, next: null, reason: 'closed' })).toBeNull();
  });

  it('releases the mic when the owner closes', () => {
    expect(electSttOwner({ current: 've-1', next: null, reason: 'closed' })).toEqual({
      primaryContactId: null,
      previousContactId: 've-1',
      reason: 'closed',
    });
  });

  it('builds a per-window message that only the primary reads as true', () => {
    const election = { primaryContactId: 've-2', previousContactId: 've-1', reason: 'wake' as const };
    expect(sttOwnerMessage('ve-2', election, 4)).toEqual({
      contactId: 've-2',
      primary: true,
      reason: 'wake',
      token: 4,
    });
    expect(sttOwnerMessage('ve-1', election, 4).primary).toBe(false);
  });
});
