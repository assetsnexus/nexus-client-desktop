import { describe, expect, it } from 'vitest';
import {
  buildCompanionHash,
  parseCompanionHash,
  isCompanionHash,
  buildCompanionToolHash,
  parseCompanionToolHash,
  electSttOwner,
  sttOwnerMessage,
  COMPANION_HASH_PREFIX,
  COMPANION_WINDOW_TITLE_FALLBACK,
  companionLabelCandidates,
  companionToolLabel,
  companionToolWindowTitle,
  companionWindowTitle,
  isReportableCompanionLabel,
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
      roomTitle: 'Writers',
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

  it('round-trips the room name so a room companion is titled with the room', () => {
    const parsed = parseCompanionHash(
      buildCompanionHash({ contactId: 've-1', roomId: 'room-7', roomTitle: 'Writers', title: 'Aria' }),
    );
    expect(parsed?.roomTitle).toBe('Writers');
  });

  it('drops an id-shaped roomTitle from a hand-built hash', () => {
    const RAW_ID = '1792316062792-nm26u6zve';
    const parsed = parseCompanionHash(
      buildCompanionHash({ contactId: 've-1', roomId: 'room-7', roomTitle: RAW_ID }),
    );
    expect(parsed?.roomTitle).toBeNull();
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
      roomTitle: null,
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

describe('companion launch labels never carry a raw id', () => {
  const RAW_ID = '1792316062792-nm26u6zve';

  it('buildCompanionHash drops an id-shaped title (falls back to a live name)', () => {
    const hash = buildCompanionHash({ contactId: 've-1', title: RAW_ID });
    expect(hash.includes('title')).toBe(false);
    expect(parseCompanionHash(hash)?.title).toBeNull();
  });

  it('buildCompanionHash keeps a real title but drops a bad one ahead of it', () => {
    expect(parseCompanionHash(buildCompanionHash({ contactId: 've-1', title: 'Rune' }))?.title).toBe(
      'Rune',
    );
    // Only one title field exists, so an id-only title is simply omitted.
    expect(
      buildCompanionHash({ contactId: 've-1', title: RAW_ID }).includes(encodeURIComponent(RAW_ID)),
    ).toBe(false);
  });

  it('parseCompanionHash drops an id-shaped title from a hand-built hash', () => {
    const parsed = parseCompanionHash(`#companion?contactId=ve-1&title=${encodeURIComponent(RAW_ID)}`);
    expect(parsed?.contactId).toBe('ve-1');
    expect(parsed?.title).toBeNull();
  });

  it('buildCompanionToolHash drops an id-shaped agentName', () => {
    const hash = buildCompanionToolHash({ tool: 'gestures', contactId: 've-1', agentName: RAW_ID });
    expect(hash.includes('agentName')).toBe(false);
    expect(parseCompanionToolHash(hash)?.agentName).toBeNull();
  });

  it('buildCompanionToolHash keeps a real agentName', () => {
    const hash = buildCompanionToolHash({ tool: 'gestures', contactId: 've-1', agentName: 'Rune' });
    expect(parseCompanionToolHash(hash)?.agentName).toBe('Rune');
  });

  it('parseCompanionToolHash drops an id-shaped agentName from a hand-built hash', () => {
    const parsed = parseCompanionToolHash(
      `#companion-tool?tool=gestures&contactId=ve-1&agentName=${encodeURIComponent(RAW_ID)}`,
    );
    expect(parsed?.contactId).toBe('ve-1');
    expect(parsed?.agentName).toBeNull();
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

describe('companion window titles (one caption rule for main + renderer)', () => {
  it('composes the OS caption as `Nexus · <Name>`', () => {
    expect(companionWindowTitle('Aria')).toBe('Nexus · Aria');
  });

  it('falls back to the app-neutral literal when nothing human-readable exists', () => {
    expect(companionWindowTitle(null, undefined, '   ')).toBe(COMPANION_WINDOW_TITLE_FALLBACK);
  });

  it('never lets an id-shaped candidate become a caption', () => {
    expect(companionWindowTitle('1792316062792-nm26u6zve')).toBe(COMPANION_WINDOW_TITLE_FALLBACK);
    // A later real name still wins over an id-shaped first candidate.
    expect(companionWindowTitle('1792316062792-nm26u6zve', 'Aria')).toBe('Nexus · Aria');
  });

  it('orders candidates: room name first for a room companion', () => {
    expect(
      companionLabelCandidates({ roomId: 'room-1', roomTitle: 'Writers', title: 'Aria' })[0],
    ).toBe('Writers');
  });

  it('orders candidates: agent name first for a 1:1 companion', () => {
    expect(companionLabelCandidates({ roomId: null, roomTitle: null, title: 'Aria' })[0]).toBe('Aria');
  });

  it('appends extra live candidates after the launch hints', () => {
    expect(
      companionLabelCandidates({ roomId: null, roomTitle: null, title: null }, 'Live Name'),
    ).toEqual([null, null, 'Live Name']);
  });

  it('composes a tool caption as `<Tool> · <Agent>` and degrades to the bare tool', () => {
    expect(companionToolWindowTitle('motion-feed', 'Aria')).toBe('Motion feed · Aria');
    expect(companionToolWindowTitle('motion-feed', null)).toBe('Motion feed');
    expect(companionToolWindowTitle('motion-feed', '1792316062792-nm26u6zve')).toBe('Motion feed');
  });

  it('labels a tool by its human name, falling back to the raw id for an unknown tool', () => {
    expect(companionToolLabel('gestures')).toBe('Gesture tester');
    expect(companionToolLabel('mystery')).toBe('mystery');
  });

  describe('isReportableCompanionLabel', () => {
    it('accepts a real human name', () => {
      expect(isReportableCompanionLabel('Aria')).toBe(true);
    });

    it('rejects the in-app floor literal so it never becomes `Nexus · Companion`', () => {
      expect(isReportableCompanionLabel('Companion')).toBe(false);
    });

    it('rejects ids and blanks', () => {
      expect(isReportableCompanionLabel('1792316062792-nm26u6zve')).toBe(false);
      expect(isReportableCompanionLabel('   ')).toBe(false);
      expect(isReportableCompanionLabel(null)).toBe(false);
      expect(isReportableCompanionLabel(undefined)).toBe(false);
    });
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
