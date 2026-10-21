import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  VoiceLayout,
  createNexusChat,
  createRegionCommandClient,
  findChatContact,
  type ChatContact,
  type ChatTurn,
  type NexusChat,
} from '@nexus/chat-react';
import '@nexus/chat-react/style.css';
import {
  bridge,
  type AuthState,
  type CompanionLaunch,
  type CompanionMode,
  type DesktopConnectionConfig,
} from '../bridge.js';

type ChatIdentity = Parameters<typeof createRegionCommandClient>[0]['identity'];

const shell: CSSProperties = {
  height: '100vh',
  display: 'flex',
  flexDirection: 'column',
  background: '#0b0f14',
  color: '#e8eef4',
  fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
};

const bar: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 12px',
  borderBottom: '1px solid #1e2731',
  background: '#0f141a',
  flexShrink: 0,
};

const btn: CSSProperties = {
  padding: '5px 10px',
  borderRadius: 8,
  border: '1px solid #3a4654',
  background: '#1c2430',
  color: '#e8eef4',
  cursor: 'pointer',
  fontSize: 12,
};

const btnActive: CSSProperties = {
  ...btn,
  border: '1px solid #3f6cb0',
  background: '#2f5c9e',
  color: '#fff',
};

/**
 * Immersive companion window body (Phase 7a).
 *
 * One agent, full-bleed: the 3D/VRM avatar with live voice, like a video call.
 * The window owns its own chat session; only the conversation address comes in
 * via the URL hash, and the token is read from the main process as usual.
 */
export function CompanionView({ launch }: { launch: CompanionLaunch }) {
  const [auth, setAuth] = useState<AuthState>({ status: 'signed_out' });
  const [connection, setConnection] = useState<DesktopConnectionConfig | null>(null);
  const [chat, setChat] = useState<NexusChat | null>(null);
  const [contact, setContact] = useState<ChatContact | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Phase 11e: one realtime voice session, two presentation modes.
  const [mode, setMode] = useState<CompanionMode>(launch.mode ?? 'fullscreen');

  useEffect(() => {
    void bridge.getConnectionConfig().then(setConnection);
    void bridge.getAuthState().then(setAuth);
  }, []);

  const apiBaseUrl = connection?.regionUrl ?? '';
  const identity = useMemo<ChatIdentity | null>(
    () =>
      auth.status === 'signed_in'
        ? {
            token: auth.token,
            userId: auth.identity.userId ?? null,
            orgId: auth.identity.orgId ?? null,
            role: auth.identity.role ?? null,
            deviceId: auth.identity.deviceId ?? null,
          }
        : null,
    [auth],
  );

  // Build the chat, hydrate the contact, and pull turns as the session streams.
  useEffect(() => {
    if (!apiBaseUrl || !identity) return;
    let cancelled = false;
    const client = createRegionCommandClient({ apiBaseUrl, identity });
    const nextChat = createNexusChat({
      client,
      features: { adminPanels: false },
      publicFilesBaseUrl: apiBaseUrl,
    });
    setChat(nextChat);
    const unsubscribe = nextChat.subscribe(() => {
      const state = nextChat.getState();
      setTurns(state.turns);
      setStreaming(Boolean(state.streaming));
    });

    void (async () => {
      try {
        await nextChat.loadContacts();
        if (cancelled) return;
        const fromState = findChatContact(nextChat.getState().contacts, launch.contactId);
        setContact(
          fromState ?? {
            id: launch.contactId,
            name: launch.title ?? launch.contactId,
            type: 'agent',
            virtualEmployeeId: launch.virtualEmployeeId ?? undefined,
            agentId: launch.agentId ?? undefined,
            avatarUrl: launch.avatarUrl ?? undefined,
          },
        );
        // Resume the existing thread when we know it; otherwise open the latest.
        if (launch.conversationId) {
          await nextChat.reopenConversation(launch.conversationId);
        } else {
          await nextChat.openContact(launch.contactId);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'could not open the agent');
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [apiBaseUrl, identity, launch.contactId, launch.conversationId, launch.title, launch.virtualEmployeeId, launch.agentId, launch.avatarUrl]);

  return (
    <div style={shell}>
      <header style={bar}>
        <strong style={{ fontSize: 13 }}>{launch.title ?? contact?.name ?? 'Companion'}</strong>
        <span style={{ flex: 1 }} />
        {(
          [
            ['fullscreen', 'Full 3D'],
            ['split', 'Split'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            style={mode === id ? btnActive : btn}
            onClick={() => setMode(id)}
          >
            {label}
          </button>
        ))}
        <button type="button" style={btn} onClick={() => void bridge.companionClose(launch.contactId)}>
          Close
        </button>
      </header>
      <div style={{ flex: 1, minHeight: 0 }}>
        {error ? (
          <p style={{ padding: 24, color: '#f2a1a1' }}>{error}</p>
        ) : !identity ? (
          <p style={{ padding: 24, color: '#9aa7b5' }}>Sign in from the main window.</p>
        ) : !chat ? (
          <p style={{ padding: 24, color: '#9aa7b5' }}>Starting companion…</p>
        ) : (
          <VoiceLayout
            chat={chat}
            contact={contact}
            turns={turns}
            streaming={streaming}
            view={mode === 'fullscreen' ? 'avatar' : 'background'}
            // Full 3D = avatar-only stage; Split = chat beside the 3D stage.
            initialLayout={mode === 'fullscreen' ? 'avatar' : 'split'}
            splitAxis="horizontal"
            autoStart={launch.autoStart !== false}
          />
        )}
      </div>
    </div>
  );
}
