/**
 * Desktop meeting voice host (Phase 11e).
 *
 * The shared `createMeetingVoiceSession` state machine (from `@nexus/meetings-
 * core`) decides *what* should happen; this module is the desktop's side-
 * effecting half — it wires the realtime WebRTC call and the classic STT → agent
 * → TTS pipeline onto the same `@nexus/chat-core` rails the portal and the 1:1
 * companion use, so a meeting Scene tab calls an agent exactly like a DM.
 *
 * Framework-free so it is unit-testable: the `NexusChat` facade + `CommandClient`
 * are passed in, and `getUserMedia` / WebRTC live behind `chat.startBrowserCall`.
 */

import {
  createMeetingVoiceSession,
  resolvePipelineEngines,
  type MeetingVoiceCapabilities,
  type MeetingVoiceMode,
  type MeetingVoiceSession,
  type MeetingVoiceSurface,
  type PipelineSessionHandle,
  type RealtimeSessionHandle,
  type VoiceEngine,
} from '@nexus/meetings-core';
import {
  connectLiveSttWebSocket,
  createLiveSttSession,
  createSpeakTurnController,
  transcribeOrNull,
  type CommandClient,
  type NexusChat,
} from '@nexus/chat-core';

/** Minimal mic-capture contract (satisfied by `startMicCapture`). */
export type MicCapture = {
  stop: () => Promise<Blob>;
  cancel: () => void;
};

export type MeetingVoiceHostOptions = {
  chat: NexusChat;
  client: CommandClient;
  /** Region realtime availability (from the local-voice manager capabilities). */
  capabilities: MeetingVoiceCapabilities;
  /** Cloud STT/TTS engines resolved from the region catalog (optional). */
  cloudStt?: VoiceEngine | null;
  cloudTts?: VoiceEngine | null;
  /** On-device engines installed on this machine (optional). */
  localStt?: VoiceEngine | null;
  localTts?: VoiceEngine | null;
  /**
   * Live STT model id (`tts_/stt_` capable) for the pipeline. When absent the
   * pipeline falls back to a batch transcription of the recorded blob.
   */
  sttModelId?: string | null;
  /** Fallback TTS model id for the pipeline (else the agent's contact TTS). */
  ttsModelId?: string | null;
  /** Mic capture factory (injected so tests never touch `getUserMedia`). */
  startMicCapture: (opts?: { onChunk?: (frame: ArrayBuffer) => void }) => Promise<MicCapture>;
  logger?: { warn?: (...args: unknown[]) => void; debug?: (...args: unknown[]) => void };
};

export type MeetingVoiceHost = {
  session: MeetingVoiceSession;
  /** Turn the mic loop on for the pipeline mode after the session is live. */
  beginPipelineCapture: () => Promise<void>;
  dispose: () => Promise<void>;
};

/**
 * Start a realtime WebRTC duplex session against `gpt-realtime` via the chat
 * rails (`chat.startBrowserCall` → `anx.inference.realtime.call.create`). The
 * remote audio auto-plays through the hidden `<audio>` element the session
 * creates, so the meeting hears the agent even without a VRM host.
 */
function realtimeStarter(chat: NexusChat, logger: MeetingVoiceHostOptions['logger']) {
  return async (input: {
    agentId: string;
    conversationId?: string | null;
    roomId?: string | null;
  }): Promise<RealtimeSessionHandle> => {
    const call = await chat.startBrowserCall({
      agentId: input.agentId,
      conversationId: input.conversationId ?? undefined,
      roomId: input.roomId ?? undefined,
    });
    return {
      stop: async () => {
        try {
          await chat.endCall({ agentId: input.agentId, callSid: call.callSid });
        } catch (err) {
          logger?.warn?.('meeting voice: endCall failed', err);
        }
      },
      setMuted: (muted: boolean) => {
        // `toggleMute` flips state; only call it when the target differs.
        const live = chat.getVoiceSurface?.()?.muted;
        if (live !== muted) chat.toggleMute?.();
      },
      setPaused: (paused: boolean) => {
        const surface = chat.getVoiceSurface?.();
        if (paused) chat.pauseCall?.();
        else if (surface?.paused) chat.resumeCall?.();
      },
    };
  };
}

/**
 * Classic pipeline: mic → STT → agent turn → TTS. Prefers the live STT socket
 * (partial transcripts) and falls back to a batch transcription of the recorded
 * blob; the agent reply is spoken through the same `createSpeakTurnController`
 * the DM voice mode uses.
 */
function pipelineStarter(
  opts: MeetingVoiceHostOptions,
  state: { capture: MicCapture | null; mic: MediaStream | null },
) {
  const { chat, client, sttModelId, ttsModelId, logger } = opts;
  return async (input: {
    agentId: string;
    conversationId?: string | null;
    roomId?: string | null;
    stt: VoiceEngine | null;
    tts: VoiceEngine | null;
    preferLocal: boolean;
  }): Promise<PipelineSessionHandle> => {
    let closed = false;
    let liveText = '';
    let socket: { send: (f: ArrayBuffer | Uint8Array) => void; close: () => void } | null = null;

    const stop = () => {
      closed = true;
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
      socket = null;
      state.capture?.cancel();
      state.capture = null;
    };

    // A local (on-device) STT engine is driven by the local runtime, not the
    // region live-STT socket; this host only knows the region rail today.
    const useLive = Boolean(sttModelId) && input.stt?.location !== 'local';
    if (useLive && sttModelId) {
      try {
        const session = await createLiveSttSession(client, { modelId: sttModelId });
        const endpoint = Array.isArray(session.endpoints) ? session.endpoints[0] : null;
        if (session.token && endpoint) {
          socket = connectLiveSttWebSocket({
            wsUrl: endpoint,
            token: session.token,
            modelId: session.modelId || sttModelId,
            onPartial: (text) => {
              liveText = text;
            },
            onFinal: (text) => {
              liveText = `${liveText} ${text}`.trim();
            },
            onError: (error) => logger?.warn?.('meeting voice: live STT error', error),
          });
        }
      } catch (err) {
        logger?.warn?.('meeting voice: live STT session failed; using batch', err);
      }
    }

    const capture = await opts.startMicCapture({
      onChunk: socket ? (frame) => socket?.send(frame) : undefined,
    });
    state.capture = capture;

    // One capture cycle: release the mic, transcribe, send, speak the reply.
    const runOnce = async (): Promise<void> => {
      if (closed || !state.capture) return;
      const active = state.capture;
      state.capture = null;
      const blob = await active.stop();
      socket?.close();
      socket = null;
      if (closed) return;
      try {
        let said = liveText.trim();
        if (!said && sttModelId) {
          const transcribed = await transcribeOrNull(client, { modelId: sttModelId, audioBlob: blob });
          said = (transcribed.text ?? '').trim();
        }
        if (!said) return;
        const result = await chat.sendMessage(said, {
          conversationId: input.conversationId ?? undefined,
          roomId: input.roomId ?? undefined,
          bypassFallback: true,
        });
        if (!result.ok) throw new Error(result.message || 'Could not send the transcript.');
        await speakReply();
      } catch (err) {
        logger?.warn?.('meeting voice: pipeline turn failed', err);
      } finally {
        // Re-arm the mic for the next utterance unless the call ended.
        if (!closed) {
          try {
            state.capture = await opts.startMicCapture({
              onChunk: socket ? (frame) => socket?.send(frame) : undefined,
            });
          } catch (err) {
            logger?.warn?.('meeting voice: mic re-arm failed', err);
          }
        }
      }
    };

    const speakReply = async (): Promise<void> => {
      const turns = chat.getState().turns;
      const lastAssistant = [...turns]
        .reverse()
        .find((t) => t.role === 'assistant' && t.text?.trim());
      const text = lastAssistant?.text?.trim();
      if (!text) return;
      const speak =
        typeof chat.createSpeakTurn === 'function'
          ? chat.createSpeakTurn({
              agentId: input.agentId,
              fallbackModelId: ttsModelId ?? undefined,
            })
          : createSpeakTurnController({
              client,
              agentId: input.agentId,
              fallbackModelId: ttsModelId ?? undefined,
            });
      await speak.speak(text);
    };

    // Kick off the first capture cycle; expose a handle that stops the loop.
    void runOnce();
    return {
      stop,
      setMuted: (muted: boolean) => {
        if (muted) state.capture?.cancel();
      },
    };
  };
}

/**
 * Build the desktop meeting voice host. Call `beginPipelineCapture()` after a
 * successful pipeline start to arm the mic loop (the pipeline starter arms the
 * first cycle itself; this is for hosts that want explicit control).
 */
export function createMeetingVoiceHost(opts: MeetingVoiceHostOptions): MeetingVoiceHost {
  const state: { capture: MicCapture | null; mic: MediaStream | null } = { capture: null, mic: null };
  // Fall back to a generic nexus cloud descriptor when a capability is present
  // but no explicit engine was supplied: the region commands are the transport,
  // so the descriptor only needs to name the protocol/location for resolution.
  const cloudStt =
    opts.cloudStt ??
    (opts.capabilities.cloudSttAvailable
      ? {
          kind: 'stt' as const,
          location: 'cloud' as const,
          id: opts.sttModelId ?? 'region-stt',
          label: 'Region STT',
          protocol: 'nexus' as const,
          baseUrl: null,
        }
      : null);
  const cloudTts =
    opts.cloudTts ??
    (opts.capabilities.cloudTtsAvailable
      ? {
          kind: 'tts' as const,
          location: 'cloud' as const,
          id: opts.ttsModelId ?? 'region-tts',
          label: 'Region TTS',
          protocol: 'nexus' as const,
          baseUrl: null,
        }
      : null);
  const session = createMeetingVoiceSession({
    capabilities: opts.capabilities,
    cloudStt,
    cloudTts,
    localStt: opts.localStt ?? null,
    localTts: opts.localTts ?? null,
    startRealtime: realtimeStarter(opts.chat, opts.logger),
    startPipeline: pipelineStarter(opts, state),
    logger: opts.logger,
  });

  return {
    session,
    async beginPipelineCapture() {
      const surface = session.getSurface();
      if (surface.mode !== 'pipeline' || surface.status !== 'live') return;
      if (state.capture) return;
      try {
        state.capture = await opts.startMicCapture();
      } catch (err) {
        opts.logger?.warn?.('meeting voice: mic capture failed', err);
      }
    },
    async dispose() {
      state.capture?.cancel();
      state.capture = null;
      await session.stop();
    },
  };
}

/** Convenience: the surface snapshot the voice bar renders, with fallback text. */
export function voiceSurfaceView(surface: MeetingVoiceSurface): {
  active: boolean;
  muted: boolean;
  status: string;
  errorMessage: string | null;
  fellBack: boolean;
  mode: MeetingVoiceMode | null;
} {
  const statusText =
    surface.status === 'connecting'
      ? 'Connecting…'
      : surface.status === 'live'
        ? surface.mode === 'realtime'
          ? 'Live (realtime)'
          : 'Live (STT/TTS)'
        : surface.status === 'paused'
          ? 'Paused'
          : surface.status === 'error'
            ? surface.errorMessage ?? 'Voice error'
            : 'Ready';
  return {
    active: surface.active,
    muted: surface.muted,
    status: statusText,
    errorMessage: surface.errorMessage,
    fellBack: surface.fellBack,
    mode: surface.mode,
  };
}

export { resolvePipelineEngines };
