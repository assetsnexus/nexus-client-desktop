import { describe, expect, it } from 'vitest';
import {
  createIncomingWatcher,
  resolveSenderName,
  selectIncomingMessages,
  type ObservableMessage,
} from './incoming.js';

const msg = (
  id: string,
  role: ObservableMessage['role'],
  content: string,
): ObservableMessage => ({ id, role, content });

describe('selectIncomingMessages', () => {
  it('returns a completed assistant message once', () => {
    const seen = new Set<string>();
    const messages = [msg('m1', 'assistant', 'Hi there')];
    expect(selectIncomingMessages({ messages, streaming: false, seen })).toEqual(messages);
    // Second pass: already seen, nothing returned.
    expect(selectIncomingMessages({ messages, streaming: false, seen })).toEqual([]);
  });

  it('waits for streaming to finish', () => {
    const seen = new Set<string>();
    const messages = [msg('m1', 'assistant', 'partial')];
    expect(selectIncomingMessages({ messages, streaming: true, seen })).toEqual([]);
    // The id is not marked seen while streaming, so it fires once complete.
    expect(selectIncomingMessages({ messages, streaming: false, seen })).toHaveLength(1);
  });

  it('ignores user and system messages', () => {
    const seen = new Set<string>();
    const messages = [
      msg('u1', 'user', 'hello'),
      msg('s1', 'system', 'notice'),
      msg('a1', 'assistant', 'reply'),
    ];
    const out = selectIncomingMessages({ messages, streaming: false, seen });
    expect(out.map((m) => m.id)).toEqual(['a1']);
  });

  it('ignores empty content', () => {
    const seen = new Set<string>();
    const messages = [msg('a1', 'assistant', '   '), msg('a2', 'assistant', '')];
    expect(selectIncomingMessages({ messages, streaming: false, seen })).toEqual([]);
  });

  it('returns multiple new messages in order', () => {
    const seen = new Set<string>();
    const messages = [
      msg('a1', 'assistant', 'one'),
      msg('a2', 'assistant', 'two'),
    ];
    expect(
      selectIncomingMessages({ messages, streaming: false, seen }).map((m) => m.id),
    ).toEqual(['a1', 'a2']);
  });

  it('skips a message with no id', () => {
    const seen = new Set<string>();
    const messages = [msg('', 'assistant', 'anon')];
    expect(selectIncomingMessages({ messages, streaming: false, seen })).toEqual([]);
  });
});

describe('resolveSenderName', () => {
  it('prefers the agent name', () => {
    expect(resolveSenderName({ agentName: 'Ada', conversationTitle: 'Support' })).toBe('Ada');
  });

  it('falls back to the conversation title', () => {
    expect(resolveSenderName({ agentName: '  ', conversationTitle: 'Support' })).toBe('Support');
  });

  it('returns null when nothing is known', () => {
    expect(resolveSenderName({})).toBeNull();
  });
});

describe('createIncomingWatcher', () => {
  const base = { conversationId: 'c1', streaming: false, historyLoading: false };

  it('absorbs the initial batch and only reports later messages', () => {
    const watcher = createIncomingWatcher();
    // First observation establishes the baseline: history is already loaded.
    expect(
      watcher.observe({
        ...base,
        messages: [msg('h1', 'assistant', 'old'), msg('h2', 'assistant', 'older')],
      }),
    ).toEqual([]);
    // A genuinely new message afterwards fires.
    const out = watcher.observe({
      ...base,
      messages: [
        msg('h1', 'assistant', 'old'),
        msg('h2', 'assistant', 'older'),
        msg('n1', 'assistant', 'fresh'),
      ],
    });
    expect(out.map((m) => m.id)).toEqual(['n1']);
  });

  it('does not notify while history is paging in', () => {
    const watcher = createIncomingWatcher();
    watcher.observe({ ...base, historyLoading: true, messages: [msg('h1', 'assistant', 'old')] });
    // History arrives while still loading — must stay silent.
    expect(
      watcher.observe({
        ...base,
        historyLoading: true,
        messages: [msg('h1', 'assistant', 'old'), msg('h2', 'assistant', 'older')],
      }),
    ).toEqual([]);
    // Once loading ends, the baseline settles and nothing historical fires.
    expect(
      watcher.observe({
        ...base,
        historyLoading: false,
        messages: [msg('h1', 'assistant', 'old'), msg('h2', 'assistant', 'older')],
      }),
    ).toEqual([]);
    // A new message after that does fire.
    expect(
      watcher.observe({
        ...base,
        messages: [
          msg('h1', 'assistant', 'old'),
          msg('h2', 'assistant', 'older'),
          msg('n1', 'assistant', 'fresh'),
        ],
      }).map((m) => m.id),
    ).toEqual(['n1']);
  });

  it('re-baselines when the conversation changes', () => {
    const watcher = createIncomingWatcher();
    watcher.observe({ ...base, messages: [msg('a1', 'assistant', 'first conv')] });
    // Switching conversation must not notify for its (different) history.
    expect(
      watcher.observe({
        ...base,
        conversationId: 'c2',
        messages: [msg('b1', 'assistant', 'second conv history')],
      }),
    ).toEqual([]);
  });

  it('reset() drops the baseline', () => {
    const watcher = createIncomingWatcher();
    watcher.observe({ ...base, messages: [msg('a1', 'assistant', 'x')] });
    watcher.reset();
    // After reset the first observation re-baselines silently.
    expect(
      watcher.observe({ ...base, messages: [msg('a1', 'assistant', 'x')] }),
    ).toEqual([]);
  });
});