import { describe, expect, it } from 'vitest';
import {
  annotateTranscriptTokens,
  firstMatchingPhraseIndex,
  normalizePhraseText,
  transcriptAddressesPhrase,
} from './wake-phrase.js';

describe('normalizePhraseText', () => {
  it('lowercases and strips punctuation + diacritics', () => {
    expect(normalizePhraseText('  José,  Hello!! ').text).toBe('jose hello');
  });

  it('returns no tokens for an empty/punctuation-only string', () => {
    expect(normalizePhraseText('  ...  ').tokens).toEqual([]);
  });
});

describe('transcriptAddressesPhrase', () => {
  it('matches a single-word phrase inside a sentence', () => {
    expect(transcriptAddressesPhrase('Bob, do this', 'bob')).toBe(true);
  });

  it('does not match a substring buried inside a word', () => {
    expect(transcriptAddressesPhrase('a bobcat appeared', 'bob')).toBe(false);
  });

  it('matches a multi-word phrase as a contiguous sequence', () => {
    expect(transcriptAddressesPhrase('hey bob are you there', 'hey bob')).toBe(true);
  });

  it('does not match a multi-word phrase split apart', () => {
    expect(transcriptAddressesPhrase('hey there bob', 'hey bob')).toBe(false);
  });

  it('is case-insensitive and punctuation-tolerant', () => {
    expect(transcriptAddressesPhrase('HEY, Bob!', 'hey bob')).toBe(true);
  });

  it('never matches an empty phrase', () => {
    expect(transcriptAddressesPhrase('anything', '   ')).toBe(false);
  });
});

describe('firstMatchingPhraseIndex', () => {
  it('prefers the longest matching phrase', () => {
    // Both "bob" and "hey bob" match; the two-word phrase must win.
    expect(firstMatchingPhraseIndex('hey bob please', ['bob', 'hey bob'])).toBe(1);
  });

  it('returns -1 when nothing matches', () => {
    expect(firstMatchingPhraseIndex('hello world', ['bob', 'alice'])).toBe(-1);
  });
});

describe('annotateTranscriptTokens', () => {
  it('preserves original casing/punctuation and flags matched words', () => {
    expect(annotateTranscriptTokens('Hey Bob, do this', ['hey bob'])).toEqual([
      { text: 'Hey', wake: true },
      { text: 'Bob,', wake: true },
      { text: 'do', wake: false },
      { text: 'this', wake: false },
    ]);
  });

  it('highlights every word of a multi-word phrase', () => {
    const tokens = annotateTranscriptTokens('please hey jarvis now', ['hey jarvis']);
    expect(tokens.filter((t) => t.wake).map((t) => t.text)).toEqual(['hey', 'jarvis']);
  });

  it('highlights a substring word only when it is a whole word', () => {
    expect(annotateTranscriptTokens('a bobcat appeared', ['bob']).some((t) => t.wake)).toBe(false);
  });

  it('drops punctuation-only words from the visible caption', () => {
    const tokens = annotateTranscriptTokens('hello -- world', ['bob']);
    expect(tokens.map((t) => t.text)).toEqual(['hello', 'world']);
  });

  it('flags nothing when no phrase matches', () => {
    const tokens = annotateTranscriptTokens('good morning', ['hey jarvis']);
    expect(tokens.every((t) => !t.wake)).toBe(true);
  });

  it('returns [] for empty input', () => {
    expect(annotateTranscriptTokens('   ', ['bob'])).toEqual([]);
  });
});
