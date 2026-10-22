import { describe, expect, it } from 'vitest';
import {
  MAX_QUEUED_UTTERANCES,
  appendTranscript,
  dequeueUtterance,
  enqueueUtterance,
  matchSubmitPhrase,
  resolveAgentByName,
  resolveUnsent,
  stripAgentAddress,
  type QueuedUtterance,
} from './transcript.js';

describe('matchSubmitPhrase', () => {
  it('strips a trailing submit phrase and reports the match', () => {
    expect(matchSubmitPhrase('order a pizza submit', ['submit'])).toEqual({
      text: 'order a pizza',
      submitted: true,
      matched: 'submit',
    });
  });

  it('is case-insensitive and tolerates trailing punctuation', () => {
    expect(matchSubmitPhrase('do the thing SUBMIT!', ['submit']).submitted).toBe(true);
    expect(matchSubmitPhrase('do the thing submit.', ['submit']).submitted).toBe(true);
    expect(matchSubmitPhrase('do the thing Submit,', ['submit']).text).toBe('do the thing');
  });

  it('matches multi-word phrases and prefers the longest', () => {
    const out = matchSubmitPhrase('stop talking answer now', ['now', 'answer now']);
    expect(out.submitted).toBe(true);
    expect(out.matched).toBe('answer now');
    expect(out.text).toBe('stop talking');
  });

  it('does not match inside a word', () => {
    expect(matchSubmitPhrase('presubmit this', ['submit']).submitted).toBe(false);
    expect(matchSubmitPhrase('submitter', ['submit']).submitted).toBe(false);
  });

  it('does not match a phrase in the middle of a sentence', () => {
    expect(matchSubmitPhrase('submit the report tomorrow', ['submit']).submitted).toBe(false);
  });

  it('treats a bare submit phrase as an empty submit', () => {
    expect(matchSubmitPhrase('submit', ['submit'])).toEqual({
      text: '',
      submitted: true,
      matched: 'submit',
    });
  });

  it('returns the text unchanged when nothing matches or no phrases are set', () => {
    expect(matchSubmitPhrase('just talking', ['submit'])).toEqual({
      text: 'just talking',
      submitted: false,
      matched: null,
    });
    expect(matchSubmitPhrase('say submit', []).submitted).toBe(false);
  });
});

describe('stripAgentAddress', () => {
  it('removes a leading name with punctuation', () => {
    expect(stripAgentAddress('Bob, do this', 'Bob')).toBe('do this');
    expect(stripAgentAddress('Bob: do this', 'Bob')).toBe('do this');
    expect(stripAgentAddress('Bob do this', 'Bob')).toBe('do this');
  });

  it('is case-insensitive and anchored to the start', () => {
    expect(stripAgentAddress('bob do this', 'Bob')).toBe('do this');
    expect(stripAgentAddress('ask bob about it', 'Bob')).toBeNull();
  });

  it('returns null when the name is absent or bare', () => {
    expect(stripAgentAddress('hello there', 'Bob')).toBeNull();
    expect(stripAgentAddress('Bob', 'Bob')).toBeNull();
  });
});

describe('resolveAgentByName', () => {
  const agents = [
    { contactId: 'bob', name: 'Bob' },
    { contactId: 'bobsmith', name: 'Bob Smith' },
  ];

  it('routes a name-addressed utterance and strips the address', () => {
    expect(resolveAgentByName('Bob, do this', agents)).toEqual({
      agentId: 'bob',
      agentName: 'Bob',
      text: 'do this',
    });
  });

  it('prefers the longest matching name', () => {
    expect(resolveAgentByName('Bob Smith, file it', agents)!.agentId).toBe('bobsmith');
  });

  it('returns null when no agent is addressed', () => {
    expect(resolveAgentByName('just do it', agents)).toBeNull();
    expect(resolveAgentByName('', agents)).toBeNull();
    expect(resolveAgentByName('Bob, do it', [])).toBeNull();
  });

  it('ignores a bare name with no instruction', () => {
    expect(resolveAgentByName('Bob', agents)).toBeNull();
  });
});

describe('appendTranscript', () => {
  it('joins bursts with a single space', () => {
    expect(appendTranscript('first part', 'second part')).toBe('first part second part');
  });

  it('never doubles a space when the buffer already ends in whitespace', () => {
    expect(appendTranscript('first part ', 'second')).toBe('first part second');
  });

  it('seeds an empty buffer and ignores empty additions', () => {
    expect(appendTranscript('', '  hello  ')).toBe('hello');
    expect(appendTranscript('kept', '   ')).toBe('kept');
  });
});

describe('resolveUnsent', () => {
  it('sends only on an explicit submit request', () => {
    expect(resolveUnsent({ buffer: 'ship it', policy: 'discard', submitted: true })).toEqual({
      action: 'send',
      text: 'ship it',
    });
  });

  it('discards an unsubmitted buffer under the discard policy', () => {
    expect(resolveUnsent({ buffer: 'maybe later', policy: 'discard', submitted: false })).toEqual({
      action: 'discard',
      text: 'maybe later',
    });
  });

  it('queues an unsubmitted buffer under the queue policy', () => {
    expect(resolveUnsent({ buffer: 'maybe later', policy: 'queue', submitted: false })).toEqual({
      action: 'queue',
      text: 'maybe later',
    });
  });

  it('never sends an empty buffer', () => {
    expect(resolveUnsent({ buffer: '   ', policy: 'queue', submitted: true })).toEqual({
      action: 'discard',
      text: '',
    });
  });
});

describe('queue helpers', () => {
  const entry = (id: string): QueuedUtterance => ({
    id,
    agentId: 'a',
    agentName: 'A',
    text: id,
    at: 1,
    phrase: 'Hey',
  });

  it('appends and replaces by id', () => {
    const q = enqueueUtterance([], entry('1'));
    expect(q.map((e) => e.id)).toEqual(['1']);
    const q2 = enqueueUtterance(q, { ...entry('1'), text: 'updated' });
    expect(q2).toHaveLength(1);
    expect(q2[0]!.text).toBe('updated');
  });

  it('caps the queue at the max, dropping the oldest', () => {
    let q: QueuedUtterance[] = [];
    for (let i = 0; i < MAX_QUEUED_UTTERANCES + 5; i++) q = enqueueUtterance(q, entry(String(i)));
    expect(q).toHaveLength(MAX_QUEUED_UTTERANCES);
    expect(q[0]!.id).toBe('5');
  });

  it('removes by id', () => {
    const q = [entry('1'), entry('2')];
    expect(dequeueUtterance(q, '1').map((e) => e.id)).toEqual(['2']);
  });
});
