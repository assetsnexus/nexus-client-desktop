import { describe, expect, it, vi } from 'vitest';

// The meeting voice host imports `@nexus/chat-core` at module load; stub the two
// helpers it calls so the spec never touches a real region or WebSocket.
vi.mock('@nexus/chat-core', () => ({
  createLiveSttSession: vi.fn(async () => ({ token: 't', endpoints: [], modelId: 'm' })),
  connectLiveSttWebSocket: vi.fn(() => ({ send: vi.fn(), close: vi.fn(), ready: Promise.resolve() })),
  createSpeakTurnController: vi.fn(() => ({ speak: vi.fn(async () => undefined) })),
  transcribeOrNull: vi.fn(async () => ({ text: 'hello from mic' })),
}));

const { createMeetingVoiceHost, voiceSurfaceView } = await import('./meeting-voice.js');

type Capabilities = {
  realtimeAvailable: boolean;
  cloudSttAvailable: boolean;
  cloudTtsAvailable: boolean;
  localSttAvailable: boolean;
  localTtsAvailable: boolean;
};

function caps(patch: Partial<Capabilities> = {}): Capabilities {
  return {
    realtimeAvailable: false,
    cloudSttAvailable: false,
    cloudTtsAvailable: false,
    localSttAvailable: false,
    localTtsAvailable: false,
    ...patch,
  };
}

/** A minimal NexusChat double: only the members the host calls. */
function fakeChat(overrides: Record<string, unknown> = {}) {
  const ended: string[] = [];
  const turns = [
    { id: 'a1', role: 'assistant' as const, text: 'Sure, here is the answer.' },
  ];
  return {
    ended,
    chat: {
      startBrowserCall: vi.fn(async () => ({ callSid: 'CA1', agentId: 'agent-1' })),
      endCall: vi.fn(async ({ callSid }: { callSid: string }) => {
        ended.push(callSid);
        return true;
      }),
      getVoiceSurface: vi.fn(() => ({ muted: false, paused: false })),
      toggleMute: vi.fn(),
      pauseCall: vi.fn(),
      resumeCall: vi.fn(),
      sendMessage: vi.fn(async () => ({ ok: true as const })),
      getState: vi.fn(() => ({ turns })),
      createSpeakTurn: vi.fn(() => ({ speak: vi.fn(async () => undefined) })),
      ...overrides,
    },
  };
}

function fakeClient() {
  return { send: vi.fn(async () => ({ ok: true, data: {} })) };
}

/** A mic capture double that resolves a non-empty blob on stop. */
function fakeMic() {
  const cancels: number[] = [];
  return {
    cancels,
    start: vi.fn(async () => {
      let cancelled = false;
      return {
        stop: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }),
        cancel: () => {
          cancelled = true;
          cancels.push(1);
        },
        get cancelled() {
          return cancelled;
        },
      };
    }),
  };
}

describe('createMeetingVoiceHost', () => {
  it('starts a realtime WebRTC call when realtime is available', async () => {
    const { chat } = fakeChat();
    const { start } = fakeMic();
    const host = createMeetingVoiceHost({
      chat: chat as never,
      client: fakeClient() as never,
      capabilities: caps({ realtimeAvailable: true }),
      startMicCapture: start as never,
    });
    const surface = await host.session.start({ agentId: 'agent-1', roomId: 'room-1' });
    expect(surface.mode).toBe('realtime');
    expect(surface.status).toBe('live');
    expect(chat.startBrowserCall).toHaveBeenCalledOnce();
    // Ending the call ends the region leg.
    await host.dispose();
    expect(chat.endCall).toHaveBeenCalledWith({ agentId: 'agent-1', callSid: 'CA1' });
  });

  it('falls back to the pipeline when realtime fails', async () => {
    const { chat } = fakeChat({
      startBrowserCall: vi.fn(async () => {
        throw new Error('WebRTC blocked');
      }),
    });
    const { start } = fakeMic();
    const host = createMeetingVoiceHost({
      chat: chat as never,
      client: fakeClient() as never,
      capabilities: caps({ realtimeAvailable: true, cloudSttAvailable: true, cloudTtsAvailable: true }),
      sttModelId: 'openai/whisper-large-v3',
      startMicCapture: start as never,
    });
    const surface = await host.session.start({ agentId: 'agent-1' });
    expect(surface.mode).toBe('pipeline');
    expect(surface.status).toBe('live');
    expect(surface.fellBack).toBe(true);
    await host.dispose();
  });

  it('refuses to start when no mode is available and reports why', async () => {
    const { chat } = fakeChat();
    const host = createMeetingVoiceHost({
      chat: chat as never,
      client: fakeClient() as never,
      capabilities: caps(), // nothing available
      startMicCapture: fakeMic().start as never,
    });
    const surface = await host.session.start({ agentId: 'agent-1' });
    expect(surface.active).toBe(false);
    expect(surface.status).toBe('error');
    expect(surface.errorMessage).toMatch(/unavailable/i);
    await host.dispose();
  });

  it('mutes through the session and reports the new state', async () => {
    const { chat } = fakeChat();
    const host = createMeetingVoiceHost({
      chat: chat as never,
      client: fakeClient() as never,
      capabilities: caps({ realtimeAvailable: true }),
      startMicCapture: fakeMic().start as never,
    });
    await host.session.start({ agentId: 'agent-1' });
    const muted = host.session.toggleMute();
    expect(muted).toBe(true);
    expect(host.session.getSurface().muted).toBe(true);
    await host.dispose();
  });
});

describe('voiceSurfaceView', () => {
  it('renders honest status text per mode and status', () => {
    const base = {
      mode: 'realtime' as const,
      status: 'live' as const,
      active: true,
      muted: false,
      paused: false,
      fellBack: false,
      stt: null,
      tts: null,
      usedLocal: false,
      errorMessage: null,
    };
    expect(voiceSurfaceView(base).status).toBe('Live (realtime)');
    expect(voiceSurfaceView({ ...base, mode: 'pipeline' }).status).toBe('Live (STT/TTS)');
    expect(voiceSurfaceView({ ...base, status: 'connecting' }).status).toBe('Connecting…');
    expect(
      voiceSurfaceView({ ...base, status: 'error', errorMessage: 'mic denied' }).status,
    ).toBe('mic denied');
  });
});
