/**
 * Occupant binding for a popped-out companion in a multi-agent room.
 *
 * A companion popped out of a group/meeting room renders every agent of the room
 * together, but its character / lip-sync host must be bound to *this* companion's
 * agent. Occupants are keyed by the participant id the region returns, which may
 * be the agent id or the VE id rather than the contact id — so the resolver must
 * try every known alias before falling back to the first seat. Pure, so it is
 * covered without mounting Three.js.
 */
import { describe, expect, it } from 'vitest';
import { resolveFocusOccupantId } from './scene-occupants.js';

const seats = [{ id: 'agent-1' }, { id: 've-2' }, { id: 'agent-3' }];

describe('resolveFocusOccupantId', () => {
  it('matches an occupant by the seat id', () => {
    expect(resolveFocusOccupantId(seats, ['ve-2'])).toBe('ve-2');
  });

  it('matches when only a later alias (agent id / VE id) is the participant id', () => {
    // The contact id is not a seat; the agent id is. Without the alias scan this
    // would bind the wrong (first) avatar.
    expect(resolveFocusOccupantId(seats, ['contact-x', 'agent-1'])).toBe('agent-1');
  });

  it('ignores empty, null, and undefined aliases', () => {
    expect(resolveFocusOccupantId(seats, [null, undefined, '', 'agent-3'])).toBe('agent-3');
  });

  it('falls back to the first seat when no alias matches', () => {
    expect(resolveFocusOccupantId(seats, ['nope'])).toBe('agent-1');
    expect(resolveFocusOccupantId(seats, [])).toBe('agent-1');
    expect(resolveFocusOccupantId(seats)).toBe('agent-1');
  });

  it('returns null for an empty roster', () => {
    expect(resolveFocusOccupantId([], ['agent-1'])).toBeNull();
  });
});
