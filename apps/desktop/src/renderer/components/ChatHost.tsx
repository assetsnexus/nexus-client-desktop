import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  NexusChatApp,
  createNexusChat,
  createRegionCommandClient,
  findChatContact,
  blobToInlineAudio,
  type ChatIdentitySession,
  type NexusChat,
  type SdkToHostMessage,
} from '@nexus/chat-react';
import '@nexus/chat-react/style.css';
import { runDictation, encodeWavBlob, type Transcriber } from '@nexus/voice-capture';
import {
  bridge,
  callBridge,
  hasBridgeMethod,
  onBridge,
  type AuthState,
  type CompanionAction,
  type CompanionSessionView,
  type DesktopConnectionConfig,
  type ToolsConfig,
} from '../bridge.js';
import { DEFAULT_DESKTOP_TOOLS, AUDIO_TOOLS, localCommandTools } from '../tools/descriptors.js';
import { resolveOrgLogoUrl } from '../../shared/org-logo.js';
import { setToolAuditContext, resolveToolAuditContext } from '../tools/audit-context.js';
import { createIncomingWatcher, resolveSenderName } from '../notifications/incoming.js';
import { resolveCompanionLabelOrNull } from '../../shared/companion-label.js';
import { createWakeChatRouter } from '../wake/router.js';
import type { SessionState } from '../wake/session.js';
import { createPreviewUtteranceSource } from '../wake/utterance.js';
import { pickWakeTranscriber } from '../wake/stt-transcriber.js';
import { drainWakePreRoll } from '../wake/pre-roll.js';
import { startWakeTurnRecording } from '../wake/turn-recorder.js';
import { setWakeCapturing, wakeDirector } from '../wake/director-host.js';
import { WakeOverlay } from './WakeOverlay.js';
import { WakeQueueBanner } from './WakeQueueBanner.js';
import {
  dequeueUtterance,
  enqueueUtterance,
  dictationTranscribesInCloud,
  type QueuedUtterance,
  type WakeActivationMode,
} from '../../shared/wake.js';

type ChatIdentity = Parameters<typeof createRegionCommandClient>[0]['identity'];

/**
 * Hosts the reusable Nexus chat SPA in the renderer.
 *
 * Region transport is the browser-side client from `@nexus/chat-react`; the
 * token comes from the main process (never the URL). VRM/voice come along for
 * free because the SPA lazily imports the character packages.
 */
export function ChatHost({
  auth,
  connection,
  wakeActivation,
}: {
  auth: Extract<AuthState, { status: 'signed_in' }>;
  connection: DesktopConnectionConfig | null;
  /** A wake routed from the shell; a new token means a new activation to run. */
  wakeActivation?: { phrase: string; agentId: string | null; token: number } | null;
}) {
  const [chat, setChat] = useState<NexusChat | null>(null);
  const [client, setClient] = useState<ReturnType<typeof createRegionCommandClient> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tools, setTools] = useState<ToolsConfig | null>(null);
  /**
   * Every stored identity for the active account, so the chat sidebar can fan
   * the conversation list out over the private context and each org membership
   * (portal identity chips). Empty until the main process answers; the sidebar
   * then renders the single-identity list, which is the same component.
   */
  const [identities, setIdentities] = useState<ChatIdentitySession[]>([]);
  const [activeVoice, setActiveVoice] = useState<{
    contactId: string | null;
    title: string;
    avatarUrl: string | null;
    agentId: string | null;
  } | null>(null);
  // The open agent conversation, so the header can offer "Open in companion
  // mode" for any agent — not only while a call is live.
  const [activeContact, setActiveContact] = useState<{
    contactId: string;
    /** Region-resolved human label; `null` when only a raw id is known. */
    title: string | null;
    avatarUrl: string | null;
    agentId: string | null;
    virtualEmployeeId: string | null;
    conversationId: string | null;
    /**
     * The group room the conversation lives in, when it is a room panel. Popping
     * a room's agent into a companion passes this through so the companion
     * renders the room's **shared** multi-agent scene, not a lone avatar.
     */
    roomId: string | null;
    isAgent: boolean;
  } | null>(null);

  useEffect(() => {
    void bridge.getToolsConfig().then(setTools);
  }, []);

  /**
   * Identity list for the chat sidebar. Re-read whenever the auth object changes
   * (org/account switch replaces `auth`), so the chips and the per-identity list
   * fan-out follow the switch without a window reload.
   *
   * `identityChatSessions` carries tokens but no org branding, so the membership
   * list supplies each org's display name + logo (the portal resolves the same
   * pair). A membership failure degrades to initials rather than empty chips.
   */
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      bridge.identityChatSessions(),
      bridge.identityListMemberships().catch(() => []),
    ])
      .then(([rows, memberships]) => {
        if (cancelled) return;
        const orgById = new Map(
          memberships.filter((m) => m.orgId).map((m) => [m.orgId as string, m]),
        );
        const base = connection?.gatewayUrl ?? connection?.regionUrl ?? null;
        setIdentities(
          rows.map((row) => {
            const org = row.orgId ? orgById.get(row.orgId) : undefined;
            return {
              key: row.key,
              // Prefer the membership's human org name over a business email.
              label: org?.orgName || row.label,
              userId: row.userId,
              orgId: row.orgId,
              role: row.role,
              deviceId: row.deviceId,
              token: row.token,
              avatarUrl: row.avatarUrl,
              orgLogo: resolveOrgLogoUrl(org?.orgLogo, base),
            };
          }),
        );
      })
      .catch(() => {
        if (!cancelled) setIdentities([]);
      });
    return () => {
      cancelled = true;
    };
  }, [auth, connection?.gatewayUrl, connection?.regionUrl]);

  const apiBaseUrl = connection?.regionUrl ?? '';
  const identity = useMemo<ChatIdentity>(
    () => ({
      token: auth.token,
      userId: auth.identity.userId ?? null,
      orgId: auth.identity.orgId ?? null,
      role: auth.identity.role ?? null,
      deviceId: auth.identity.deviceId ?? null,
    }),
    [auth],
  );

  const registeredTools = useMemo(
    () => [...DEFAULT_DESKTOP_TOOLS, ...AUDIO_TOOLS, ...localCommandTools(tools?.localCommands ?? [])],
    [tools],
  );

  // Keep the client-tool audit correlation fresh. Every tool call forwarded to
  // main carries the agent + conversation of the active panel, so the audit UI
  // can trace a call back to its conversation. Audit metadata only.
  useEffect(() => {
    if (!chat) return;
    const sync = (state: ReturnType<NexusChat['getState']>) => {
      setToolAuditContext(resolveToolAuditContext(state));
    };
    sync(chat.getState());
    return chat.subscribe(sync);
  }, [chat]);

  // Track the open conversation so the header can offer "Open in companion mode"
  // for the current agent at any time (not just during a live call).
  useEffect(() => {
    if (!chat) return;
    const sync = (state: ReturnType<NexusChat['getState']>) => {
      const panel = state.panels[state.activePanelIndex];
      // `panel.contactId` can be a VE id / alias rather than the contact's own
      // `id`, so resolve through the shared identity matcher (id, VE id, alias).
      const contact = findChatContact(state.contacts, panel?.contactId ?? state.selectedAgentId);
      if (!contact || (contact.type !== 'agent' && contact.type !== 'asset_agent')) {
        setActiveContact(null);
        return;
      }
      setActiveContact({
        contactId: contact.id,
        // Prefer the region-resolved panel label (`displayTitle`/`agentName`) and
        // fall back to the contact's already region-resolved `name`; an id shape
        // is dropped by the shared label rule so a raw id never rides the popout.
        title: resolveCompanionLabelOrNull(panel?.displayTitle, panel?.agentName, contact.name),
        avatarUrl: contact.avatarUrl ?? null,
        agentId: contact.agentId ?? null,
        virtualEmployeeId: contact.virtualEmployeeId ?? null,
        conversationId: panel?.conversationId ?? state.conversationId ?? null,
        // A panel bound to a group room carries the room id; the companion uses
        // it to render every agent of the room in one shared scene.
        roomId: panel?.roomId ?? null,
        isAgent: true,
      });
    };
    sync(chat.getState());
    return chat.subscribe(sync);
  }, [chat]);
  useEffect(() => {
    if (!apiBaseUrl) return;
    let cancelled = false;
    try {
      const nextClient = createRegionCommandClient({ apiBaseUrl, identity });
      const nextChat = createNexusChat({
        client: nextClient,
        features: { adminPanels: false },
        publicFilesBaseUrl: apiBaseUrl,
      });
      if (!cancelled) {
        setClient(nextClient);
        setChat(nextChat);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to start chat');
    }
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, identity]);

  // Report inbound assistant messages to the main process, which raises an OS
  // notification when the window is unattended. The watcher owns the "is this
  // new?" logic (including history paging), so this effect stays a thin pipe.
  useEffect(() => {
    if (!chat) return;
    const watcher = createIncomingWatcher();
    const report = (state: ReturnType<NexusChat['getState']>) => {
      const panel = state.panels[state.activePanelIndex];
      const contact = findChatContact(state.contacts, panel?.contactId ?? state.selectedAgentId);
      const incoming = watcher.observe({
        conversationId: panel?.conversationId ?? state.conversationId ?? null,
        messages: state.messages,
        streaming: state.streaming,
        historyLoading: Boolean(state.history?.loading || state.history?.loadingMore),
      });
      if (incoming.length === 0) return;
      const senderName = resolveSenderName({
        agentName: contact?.name ?? null,
        conversationTitle: null,
      });
      for (const message of incoming) {
        void bridge.notifyIncoming({
          messageId: message.id,
          conversationId: panel?.conversationId ?? state.conversationId ?? null,
          contactId: panel?.contactId ?? null,
          agentId: contact?.agentId ?? null,
          senderName,
          preview: message.content,
          title: senderName,
        });
      }
    };
    // Establish the baseline for whatever is already on screen.
    report(chat.getState());
    return chat.subscribe(report);
  }, [chat]);

  // Wake activation: main raises the window and forwards the phrase + mapped
  // agent. Depending on the configured activation mode we either open the chat,
  // show the compact overlay, or open the companion window — then capture one
  // utterance and hold the transcript for review. A wake carries no authority.
  const wakeRouterRef = useRef<ReturnType<typeof createWakeChatRouter> | null>(null);
  const [wakeSession, setWakeSession] = useState<SessionState | null>(null);
  const [wakeMode, setWakeMode] = useState<WakeActivationMode>('chat');
  const [wakeAgent, setWakeAgent] = useState<{ name: string; avatarUrl: string | null } | null>(null);
  const [queued, setQueued] = useState<QueuedUtterance[]>([]);
  /** The agent the live wake session is addressed to, for the companion link. */
  const [wakeTarget, setWakeTarget] = useState<{
    contactId: string;
    agentId: string | null;
    agentName: string | null;
    avatarUrl: string | null;
  } | null>(null);
  /**
   * Mirrors `WakeSettings.companionOnWake` so the widget checkbox reflects and
   * persists the one-click "open in companion + voice mode" link. Loaded on
   * mount and whenever a wake session opens.
   */
  const [companionOnWake, setCompanionOnWake] = useState(false);
  /**
   * Bumped once per activation, so the widget can tell a *new* wake from a state
   * update on the current one (the session object changes on every emit, so it
   * cannot serve as a reset key).
   */
  const [wakeSessionToken, setWakeSessionToken] = useState(0);
  /** Engine label for the active capture's transcript ("On-device" / "Region inference"). */
  const [wakeEngineLabel, setWakeEngineLabel] = useState<string | null>(null);
  /**
   * Per-turn refs the router's `sendAudio` / `batchProgress` read. Set when a
   * capture starts and cleared when the turn ends.
   */
  const activeRecorderRef = useRef<Awaited<ReturnType<typeof startWakeTurnRecording>> | null>(null);
  const activeBatchBlobRef = useRef<Blob | null>(null);
  /** The conversation id resolved for the active wake (for the companion payload). */
  const conversationIdRef = useRef<string | null>(null);

  // Surface any transcript an earlier wake left behind under the `queue` policy.
  useEffect(() => {
    void bridge.wakeGetQueue().then(setQueued).catch(() => setQueued([]));
  }, []);

  /**
   * Encode the recorder's batch so far into the WAV blob "send as voice" uses.
   * Called after each burst so the button is available as soon as audio exists.
   */
  const publishBatchSnapshot = useCallback(
    (recorder: Awaited<ReturnType<typeof startWakeTurnRecording>>): void => {
      const batch = recorder.snapshot();
      activeBatchBlobRef.current =
        batch && batch.pcm.length ? encodeWavBlob(batch.pcm, batch.sampleRate) : null;
    },
    [],
  );

  /** Finish the turn's audio recording and clear the per-turn refs. */
  const endTurnRecording = useCallback((): void => {
    const recorder = activeRecorderRef.current;
    if (!recorder) return;
    activeRecorderRef.current = null;
    const batch = recorder.finish();
    // Keep the finished blob so the review surface can still "send as voice".
    activeBatchBlobRef.current =
      batch && batch.pcm.length ? encodeWavBlob(batch.pcm, batch.sampleRate) : activeBatchBlobRef.current;
  }, []);

  /**
   * Capture one wake utterance with dual-mode capture: a live STT preview from
   * the preferred engine (local GPU first, then region cloud) streamed into the
   * field, plus a parallel audio batch recorded for the whole turn. The wake-turn
   * recorder is stored in a ref so `sendAudio` can deliver it as a voice message.
   */
  const captureOneUtterance = useCallback(
    async (chatInstance: NexusChat, clientInstance: unknown, onPartial: (text: string) => void) => {
      // The capture mode is read fresh each turn so a settings change applies to
      // the next wake without a reload. Defaults to `both` (never crash on a
      // settings read failure).
      const captureMode = await bridge
        .wakeGetSettings()
        .then((s) => s.captureMode)
        .catch(() => 'both' as const);
      const wantLive = captureMode !== 'batch';
      const wantBatch = captureMode !== 'live';

      // The audio batch must span the *whole* turn, but the router calls `dictate`
      // once per burst. Start it on the first burst (seeded with the pre-roll so
      // the utterance is not clipped) and let it keep running while the session
      // listens for the next burst; the session's terminal outcome ends it.
      let recorder = activeRecorderRef.current;
      if (wantBatch && !recorder) {
        recorder = await startWakeTurnRecording(drainWakePreRoll());
        activeRecorderRef.current = recorder;
      }
      // The live-preview source records no batch of its own (the turn recorder
      // owns the audio), so the two never duplicate capture work.
      const source = createPreviewUtteranceSource({ recordBatch: false });

      const phrases = () => wakeDirector().getState().activePhrases;
      const transcriber: Transcriber = await pickWakeTranscriber({
        phrases,
        cloud: {
          client: clientInstance,
          listModels: () => chatInstance.listAvailableModels(),
        },
      });
      setWakeEngineLabel(wantLive ? (transcriber.id === 'local' ? 'On-device' : 'Region inference') : null);

      // Gate wake detection for the whole capture (listening → transcribing) so
      // the agent's own name spoken inside the instruction is not a new wake.
      setWakeCapturing(true);
      try {
        const session = runDictation({
          source,
          // `batch` mode records the audio without streaming a live preview; the
          // final transcript still lands so the field is usable either way.
          ...(wantLive ? { onPartial } : {}),
          transcribePcm: (pcm, sampleRate) =>
            transcriber.transcribe({ blob: new Blob(), pcm, sampleRate, phrases: phrases() }),
          transcribe: (blob) => transcriber.transcribe({ blob, phrases: phrases() }),
        });
        const text = await session.done;
        // Publish a snapshot so the widget can already offer "send as voice" for
        // what was recorded, while the session may still listen for another burst.
        if (recorder) publishBatchSnapshot(recorder);
        return text;
      } finally {
        setWakeCapturing(false);
      }
    },
    [publishBatchSnapshot],
  );

  useEffect(() => {
    if (!chat || !client) return;
    const router = createWakeChatRouter({
      getSettings: () => bridge.wakeGetSettings(),
      present: async (mode, target) => {
        // Companion-first needs the live `companionPresent` channel to hand a
        // wake to an open companion window. On a preload that predates it the
        // companion can still be opened (a fresh window reload), but it cannot
        // mirror the live dictation session — so fall back to the visible widget
        // (which owns the capture) rather than blanking it with a surface that
        // can render nothing. A restart restores companion-first.
        if (mode === 'companion' && !hasBridgeMethod(bridge, 'companionPresent')) {
          mode = 'widget';
        }
        setWakeMode(mode);
        // Every presentation is a new activation: bump the token so the widget
        // resets any frozen edit from a previous wake.
        setWakeSessionToken((n) => n + 1);
        companionPoseRef.current = null;
        const agentRow = chat.getState().contacts.find((c) => c.id === target.contactId) ?? null;
        // The wake widget's agent label: a human name only, never an id shape.
        const agentName = resolveCompanionLabelOrNull(target.agentName, agentRow?.name);
        const avatarUrl = agentRow?.avatarUrl ?? null;
        setWakeAgent({ name: agentName ?? 'Agent', avatarUrl });
        // Remember the session's address so the widget can offer "open companion
        // + voice" for exactly this agent.
        setWakeTarget({ contactId: target.contactId, agentId: target.agentId, agentName, avatarUrl });
        // Resume the agent's most recent thread instead of always allocating a
        // new conversation, so a wake lands where the user last spoke. `openLatest`
        // falls back to creating one when there is no active thread.
        const contactRef = chat.getState().contacts.find((c) => c.id === target.contactId) ?? {
          id: target.contactId,
        };
        let conversationId: string | null = chat.getState().conversationId ?? null;
        try {
          const opened = await chat.openLatest(contactRef as never);
          conversationId = opened.conversationId || conversationId;
        } catch {
          // Fall back to whatever thread is already open; a hard failure is
          // surfaced by the send step rather than blocking the wake.
        }
        if (mode === 'companion') {
          if (conversationId) conversationIdRef.current = conversationId;
          // Read the one-click "companion + voice" link: it decides whether the
          // companion runs its own realtime call (voice mode) or becomes the
          // *dictation* surface (this renderer owns the session and mirrors it).
          const voiceMode = await bridge
            .wakeGetSettings()
            .then((s) => s.companionOnWake)
            .catch(() => false);
          // Hand the activation to the already-open companion without a reload
          // (so a live realtime call survives); only open a window when none
          // exists. `dictate` tells the companion which surface it is.
          // `callBridge` falls back to "no live companion" on a preload that
          // predates the channel, so the wake degrades to `companionOpen`.
          const presented = await callBridge(
            bridge,
            'companionPresent',
            false,
            {
              contactId: target.contactId,
              conversationId,
              agentId: target.agentId,
              phrase: target.phrase,
              dictate: !voiceMode,
              token: Date.now(),
            },
          );
          if (!presented) {
            await bridge.companionOpen({
              contactId: target.contactId,
              conversationId,
              agentId: target.agentId,
              title: resolveCompanionLabelOrNull(target.agentName),
              avatarUrl: agentRow?.avatarUrl ?? null,
              // A realtime call only auto-starts in voice mode; dictation mode
              // opens in the STT preview with voice a toggle.
              autoStart: voiceMode,
            });
          }
          // Voice mode owns the capture (the call); dictation mode runs the
          // session here and mirrors it into the companion strip.
          return { dictate: !voiceMode };
        }
        return { dictate: true };
      },
      dictate: (onPartial) => captureOneUtterance(chat, client, onPartial),
      sendAudio: async ({ contactId, browserContext }) => {
        const blob = activeBatchBlobRef.current;
        if (!blob || blob.size === 0) return false;
        const audio = await blobToInlineAudio(blob, 'voice-message.wav');
        const result = await chat.sendMessage('Voice message', {
          conversationId: chat.getState().conversationId ?? undefined,
          contactId,
          attachments: [audio],
          ...(browserContext ? { browserContext } : {}),
          bypassFallback: true,
        });
        return result.ok;
      },
      batchProgress: () =>
        activeRecorderRef.current?.progress() ?? { durationMs: 0, chunks: 0 },
      companionTurnContext,
      listAgents: () => chat.getState().contacts.map((c) => ({ contactId: c.id, name: c.name })),
      /**
       * Whether dictation transcribes in the cloud. Uses the same capability
       * source as the meeting bar: a `local` STT engine only truly runs on-device
       * when a model is installed (or a custom local endpoint is set).
       */
      transcriptionIsCloud: async () => {
        const local = await bridge
          .localVoiceGetState()
          .then((s) => ({
            engine: s.settings.sttEngine,
            localAvailable: s.models.some(
              (m) => m.kind === 'stt' && m.installState === 'installed',
            ),
            custom: Boolean(s.settings.customSttEndpoint?.baseUrl),
          }))
          .catch(() => ({ engine: 'cloud' as const, localAvailable: false, custom: false }));
        return dictationTranscribesInCloud({
          sttEngine: local.engine,
          localSttAvailable: local.localAvailable,
          customSttEndpoint: local.custom,
        });
      },
      send: async ({ contactId, text, browserContext }) => {
        const conversationId = chat.getState().conversationId ?? undefined;
        await chat.sendMessage(text, {
          contactId,
          conversationId,
          ...(browserContext ? { browserContext } : {}),
        });
      },
      enqueue: (entry) => {
        setQueued((prev) => {
          const next = enqueueUtterance(prev, entry);
          void bridge.wakeSetQueue(next).catch(() => undefined);
          return next;
        });
      },
      onSessionChange: (session) => {
        setWakeSession(session);
        // A terminal session ends the turn: stop the audio recording so its
        // handle is released, keeping the finished blob for "send as voice".
        if (
          session &&
          (session.status === 'submitted' ||
            session.status === 'discarded' ||
            session.status === 'queued' ||
            session.status === 'error')
        ) {
          endTurnRecording();
          setWakeCapturing(false);
        }
        // A brand-new session (idle→listening) must not inherit the previous
        // turn's audio.
        if (!session) {
          setWakeEngineLabel(null);
        }
      },
      onError: (message) => console.warn('anx.wake.route failed', message),
    });
    wakeRouterRef.current = router;
    return () => {
      router.cancel();
      wakeRouterRef.current = null;
    };
  }, [chat, client, captureOneUtterance, endTurnRecording]);

  // Latest wake target, read by the companion-action relay without re-subscribing
  // on every session state change.
  const wakeTargetRef = useRef(wakeTarget);
  wakeTargetRef.current = wakeTarget;

  /**
   * Pose the companion reported with its latest control (Deliverable 4). Read at
   * send time so a plain chat / widget turn carries no pose, while a companion
   * turn carries where the avatar stood when the user sent it.
   */
  const companionPoseRef = useRef<Record<string, unknown> | null>(null);
  const companionTurnContext = useCallback((): Record<string, unknown> | undefined => {
    const target = wakeTargetRef.current;
    if (!target) return undefined;
    return companionPoseRef.current ?? undefined;
  }, []);

  /**
   * Mirror the live wake session into the companion window so it can render the
   * STT preview + composer. The session itself stays here (this window owns the
   * shared mic graph and pre-roll); the companion is a *view* of it, so both
   * surfaces observe one capture rather than opening a second.
   */
  useEffect(() => {
    if (wakeMode !== 'companion' || !wakeTarget) return;
    const view: CompanionSessionView = {
      contactId: wakeTarget.contactId,
      status: wakeSession?.status ?? 'idle',
      preview: wakeSession?.preview ?? '',
      buffer: wakeSession?.buffer ?? '',
      cloudTranscription: wakeSession?.cloudTranscription ?? false,
      batchDurationMs: wakeSession?.batchDurationMs ?? 0,
      batchAvailable: wakeSession?.batchAvailable ?? false,
      sendingAudio: wakeSession?.sendingAudio ?? false,
      message: wakeSession?.message ?? null,
      engineLabel: wakeEngineLabel,
      agentName: wakeTarget.agentName,
    };
    void callBridge(bridge, 'companionPushSession', false, view);
  }, [wakeMode, wakeTarget, wakeSession, wakeEngineLabel]);

  /**
   * The companion's composer (submit / cancel / send-as-voice / edit) is relayed
   * back into the session that owns the capture. Subscribed via `onBridge` so a
   * preload that predates the channel yields a no-op unsubscribe instead of
   * throwing inside this effect (which would blank the window).
   */
  useEffect(() => {
    const off = onBridge<CompanionAction>(bridge, 'onCompanionActionRelay', (action) => {
      const target = wakeTargetRef.current;
      if (!target || action.contactId !== target.contactId) return;
      // Deliverable 4: remember the companion's reported pose so the turn this
      // control submits carries it. Cleared when a non-edit control carries none,
      // so a stale walk position never leaks onto a later turn.
      if (action.browserContext && action.browserContext.source === 'companion_pose') {
        companionPoseRef.current = action.browserContext;
      } else if (action.action !== 'edit') {
        companionPoseRef.current = null;
      }
      if (action.action === 'submit') void wakeRouterRef.current?.submit();
      else if (action.action === 'cancel') wakeRouterRef.current?.cancel();
      else if (action.action === 'sendAudio') void wakeRouterRef.current?.submitAudio();
      else if (action.action === 'edit') wakeRouterRef.current?.setBuffer(action.text ?? '');
    });
    return () => off();
  }, []);

  // Load the "companion + voice on wake" preference so the widget checkbox
  // reflects it, and re-read it whenever a wake session surfaces (the user may
  // have changed it in Settings).
  useEffect(() => {
    if (!wakeSession) return;
    void bridge
      .wakeGetSettings()
      .then((s) => setCompanionOnWake(s.companionOnWake))
      .catch(() => undefined);
  }, [wakeSession]);

  /**
   * Open the wake session's agent in the immersive companion window in voice
   * mode (the companion's realtime voice session owns listening). Used by the
   * widget's "Open now" button; the router does the same inline when
   * `companionOnWake` is on and the wake fires.
   */
  const openWakeCompanion = useCallback(
    async (target: { contactId: string; agentId: string | null; agentName: string | null; avatarUrl: string | null }) => {
      if (!chat) return;
      // Hand the live wake session to the companion (it renders the STT preview +
      // composer straight away) instead of starting a separate realtime call:
      // voice mode is a toggle the user opts into, not the wake default.
      const presented = await callBridge(bridge, 'companionPresent', false, {
        contactId: target.contactId,
        conversationId: conversationIdRef.current,
        agentId: target.agentId,
        phrase: wakeSession?.target.phrase ?? null,
        dictate: true,
        token: Date.now(),
      });
      if (presented) return;
      await bridge.companionOpen({
        contactId: target.contactId,
        conversationId: conversationIdRef.current,
        agentId: target.agentId,
        title: resolveCompanionLabelOrNull(target.agentName),
        avatarUrl: target.avatarUrl ?? null,
        // Open in dictation, not an auto-started call (the companion's voice
        // toggle turns the call on when the user wants it).
        autoStart: false,
      });
    },
    [chat, wakeSession?.target.phrase],
  );

  /**
   * Persist the one-click companion link. The router reads the settings fresh on
   * the next wake, so saving is enough to change future behaviour.
   */
  const toggleCompanionOnWake = useCallback((next: boolean) => {
    setCompanionOnWake(next);
    void bridge
      .wakeGetSettings()
      .then((s) => bridge.wakeSetSettings({ ...s, companionOnWake: next }))
      .then((written) => setCompanionOnWake(written.companionOnWake))
      .catch(() => undefined);
  }, []);

  /**
   * Route an activation handed down by the shell. `token` is the effect key so a
   * repeated wake (same phrase/agent) is not swallowed as an identical value.
   */
  const routeToken = wakeActivation?.token ?? 0;
  const routePhrase = wakeActivation?.phrase ?? '';
  const routeAgentId = wakeActivation?.agentId ?? null;
  useEffect(() => {
    if (!routeAgentId || !routeToken) return;
    void wakeRouterRef.current?.route({
      agentId: routeAgentId,
      contactId: routeAgentId,
      agentName: null,
      phrase: routePhrase,
    });
  }, [routeToken, routeAgentId, routePhrase]);

  const dismissQueued = useCallback((id: string) => {
    setQueued((prev) => {
      const next = dequeueUtterance(prev, id);
      void bridge.wakeSetQueue(next).catch(() => undefined);
      return next;
    });
  }, []);

  const submitQueued = useCallback(
    async (entry: QueuedUtterance) => {
      if (!chat) return;
      if (entry.agentId) await chat.openContact(entry.agentId);
      const conversationId = chat.getState().conversationId ?? undefined;
      await chat.sendMessage(entry.text, {
        contactId: entry.agentId ?? undefined,
        conversationId,
      });
      dismissQueued(entry.id);
    },
    [chat, dismissQueued],
  );

  // Open the current agent conversation (or the live voice call) in the small
  // companion window. Declared before the loading/error early-returns so the
  // hook order is stable across renders.
  const openCompanion = useCallback(
    (which: 'agent' | 'voice') => {
      const target =
        which === 'voice' && activeVoice?.contactId
          ? {
              contactId: activeVoice.contactId,
              conversationId: chat?.getState().conversationId ?? null,
              agentId: activeVoice.agentId,
              // A human name only — an id-shaped title is dropped (the companion
              // resolves the live contact name), so a raw id is never the popout
              // window's label.
              title: resolveCompanionLabelOrNull(activeVoice.title),
              avatarUrl: activeVoice.avatarUrl,
            }
          : activeContact
            ? {
                contactId: activeContact.contactId,
                conversationId: activeContact.conversationId,
                agentId: activeContact.agentId,
                virtualEmployeeId: activeContact.virtualEmployeeId,
                title: resolveCompanionLabelOrNull(activeContact.title),
                avatarUrl: activeContact.avatarUrl,
                // Room panels open the shared multi-agent scene; 1:1 DMs leave
                // this null for the single-avatar stage.
                roomId: activeContact.roomId,
              }
            : null;
      if (!target) return;
      void bridge.companionOpen(target);
    },
    [activeContact, activeVoice, chat],
  );

  // The header slot is a stable component identity (React would otherwise
  // remount the header controls on every render). It reads the live state
  // through refs so the button always opens the currently visible agent.
  const companionStateRef = useRef({ activeContact, activeVoice, openCompanion });
  companionStateRef.current = { activeContact, activeVoice, openCompanion };
  const CompanionHeaderActions = useMemo(
    () =>
      function CompanionHeaderActions() {
        const { activeContact: contact, activeVoice: voice, openCompanion: open } =
          companionStateRef.current;
        if (voice?.contactId) {
          return (
            <button
              type="button"
              className="nexus-chat__btn"
              aria-label="Immersive view"
              title="Open the live call in the immersive companion window"
              onClick={() => open('voice')}
            >
              Immersive view
            </button>
          );
        }
        if (!contact) return null;
        return (
          <button
            type="button"
            className="nexus-chat__btn"
            aria-label="Open in companion mode"
            title="Open in companion mode — small avatar window with voice chat"
            onClick={() => open('agent')}
          >
            Companion mode
          </button>
        );
      },
    [],
  );

  if (error) {
    return <p style={{ padding: 24, color: '#f2a1a1' }}>{error}</p>;
  }
  if (!apiBaseUrl) {
    return <p style={{ padding: 24, color: '#9aa7b5' }}>Configure a region node in settings.</p>;
  }
  if (!chat) {
    return <p style={{ padding: 24, color: '#9aa7b5' }}>Starting chat…</p>;
  }

  return (
    <div style={{ height: '100%', minHeight: 0, position: 'relative' }}>
      {queued.length ? (
        <WakeQueueBanner
          entries={queued}
          onSend={(entry) => void submitQueued(entry)}
          onDismiss={dismissQueued}
        />
      ) : null}
      <NexusChatApp
        chat={chat}
        client={client ?? undefined}
        identities={identities}
        features={{ adminPanels: false }}
        tools={registeredTools}
        slots={{
          // Mirror the companion affordance into the chat header, immediately
          // left of the built-in Config button, instead of floating it over the
          // thread. The slot lives inside `NexusChatApp`, so it sits with the
          // rest of the header controls at any window size.
          headerActions: CompanionHeaderActions,
        }}
        onPostToHost={(msg: SdkToHostMessage) => {
          // Renderer-side host messages (open external links, device register).
          const m = msg as unknown as {
            type?: string;
            url?: string;
            active?: boolean;
            title?: string;
            avatarUrl?: string | null;
            contactId?: string | null;
            agentId?: string | null;
          };
          if (m.type === 'openExternal' && typeof m.url === 'string') {
            void bridge.openExternal(m.url);
          }
          if (m.type === 'voiceState') {
            // Track the live voice session so the host can offer the popout.
            if (m.active && m.contactId) {
              setActiveVoice({
                contactId: m.contactId,
                title: m.title ?? '',
                avatarUrl: m.avatarUrl ?? null,
                agentId: m.agentId ?? null,
              });
            } else if (!m.active) {
              setActiveVoice(null);
            }
          }
        }}
      />
      {/* In companion mode the agent's own window is the surface (its STT preview
          + composer strip are fed by this session), so the widget must not linger
          here as an empty duplicate. The session keeps running regardless — it is
          what the companion strip mirrors. */}
      {wakeSession && wakeMode !== 'companion' ? (
        <WakeOverlay
          session={wakeSession}
          sessionToken={wakeSessionToken}
          mode={wakeMode}
          agent={wakeAgent}
          companionOnWake={companionOnWake}
          onToggleCompanion={toggleCompanionOnWake}
          onEdit={(text) => wakeRouterRef.current?.setBuffer(text)}
          onOpenCompanion={
            wakeTarget ? () => void openWakeCompanion(wakeTarget) : undefined
          }
          onSubmit={() => void wakeRouterRef.current?.submit()}
          onCancel={() => wakeRouterRef.current?.cancel()}
          engineLabel={wakeEngineLabel}
          onSendAudio={() => void wakeRouterRef.current?.submitAudio()}
        />
      ) : null}
    </div>
  );
}
