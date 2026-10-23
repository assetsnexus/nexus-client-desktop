import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  NexusChatApp,
  createNexusChat,
  createRegionCommandClient,
  findChatContact,
  type NexusChat,
  type SdkToHostMessage,
} from '@nexus/chat-react';
import '@nexus/chat-react/style.css';
import { bridge, type AuthState, type DesktopConnectionConfig, type ToolsConfig } from '../bridge.js';
import { DEFAULT_DESKTOP_TOOLS, AUDIO_TOOLS, localCommandTools } from '../tools/descriptors.js';
import { setToolAuditContext, resolveToolAuditContext } from '../tools/audit-context.js';
import { createIncomingWatcher, resolveSenderName } from '../notifications/incoming.js';
import { createWakeChatRouter } from '../wake/router.js';
import type { SessionState } from '../wake/session.js';
import { runDictation } from '../wake/dictation.js';
import { createUtteranceSource } from '../wake/utterance.js';
import { transcribeUtterance } from '../wake/transcribe.js';
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
    title: string;
    avatarUrl: string | null;
    agentId: string | null;
    virtualEmployeeId: string | null;
    conversationId: string | null;
    isAgent: boolean;
  } | null>(null);

  useEffect(() => {
    void bridge.getToolsConfig().then(setTools);
  }, []);

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
        title: contact.name,
        avatarUrl: contact.avatarUrl ?? null,
        agentId: contact.agentId ?? null,
        virtualEmployeeId: contact.virtualEmployeeId ?? null,
        conversationId: panel?.conversationId ?? state.conversationId ?? null,
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

  // Surface any transcript an earlier wake left behind under the `queue` policy.
  useEffect(() => {
    void bridge.wakeGetQueue().then(setQueued).catch(() => setQueued([]));
  }, []);

  useEffect(() => {
    if (!chat || !client) return;
    const router = createWakeChatRouter({
      getSettings: () => bridge.wakeGetSettings(),
      present: async (mode, target) => {
        setWakeMode(mode);
        const agentRow = chat.getState().contacts.find((c) => c.id === target.contactId) ?? null;
        setWakeAgent({
          name: target.agentName ?? agentRow?.name ?? 'Agent',
          avatarUrl: agentRow?.avatarUrl ?? null,
        });
        if (mode === 'companion') {
          // The companion window runs its own realtime voice session, so the
          // router must not open a second microphone capture.
          await bridge.companionOpen({
            contactId: target.contactId,
            conversationId: chat.getState().conversationId ?? null,
            agentId: target.agentId,
            title: target.agentName ?? null,
            avatarUrl: agentRow?.avatarUrl ?? null,
          });
          return { dictate: false };
        }
        if (mode === 'chat') await chat.openContact(target.contactId);
        return { dictate: true };
      },
      dictate: async (onPartial) => {
        const session = runDictation({
          source: createUtteranceSource(),
          onPartial,
          transcribe: (blob) =>
            transcribeUtterance(
              {
                client,
                listModels: () => chat.listAvailableModels(),
              },
              blob,
            ),
        });
        return session.done;
      },
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
      send: async ({ contactId, text }) => {
        const conversationId = chat.getState().conversationId ?? undefined;
        await chat.sendMessage(text, { contactId, conversationId });
      },
      enqueue: (entry) => {
        setQueued((prev) => {
          const next = enqueueUtterance(prev, entry);
          void bridge.wakeSetQueue(next).catch(() => undefined);
          return next;
        });
      },
      onSessionChange: (session) => setWakeSession(session),
      onError: (message) => console.warn('anx.wake.route failed', message),
    });
    wakeRouterRef.current = router;
    return () => {
      router.cancel();
      wakeRouterRef.current = null;
    };
  }, [chat, client]);

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
              title: activeVoice.title,
              avatarUrl: activeVoice.avatarUrl,
            }
          : activeContact
            ? {
                contactId: activeContact.contactId,
                conversationId: activeContact.conversationId,
                agentId: activeContact.agentId,
                virtualEmployeeId: activeContact.virtualEmployeeId,
                title: activeContact.title,
                avatarUrl: activeContact.avatarUrl,
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
      {wakeSession ? (
        <WakeOverlay
          session={wakeSession}
          mode={wakeMode}
          agent={wakeAgent}
          onSubmit={() => void wakeRouterRef.current?.submit()}
          onCancel={() => wakeRouterRef.current?.cancel()}
        />
      ) : null}
    </div>
  );
}
