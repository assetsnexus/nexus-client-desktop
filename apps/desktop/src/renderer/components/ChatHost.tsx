import { useEffect, useMemo, useState } from 'react';
import {
  NexusChatApp,
  createNexusChat,
  createRegionCommandClient,
  type NexusChat,
  type SdkToHostMessage,
} from '@nexus/chat-react';
import '@nexus/chat-react/style.css';
import { bridge, type AuthState, type DesktopConnectionConfig, type ToolsConfig } from '../bridge.js';
import { DEFAULT_DESKTOP_TOOLS, localCommandTools } from '../tools/descriptors.js';

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
}: {
  auth: Extract<AuthState, { status: 'signed_in' }>;
  connection: DesktopConnectionConfig | null;
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
    () => [...DEFAULT_DESKTOP_TOOLS, ...localCommandTools(tools?.localCommands ?? [])],
    [tools],
  );

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
      {activeVoice?.contactId ? (
        <div
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            zIndex: 5,
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            padding: '6px 10px',
            borderRadius: 10,
            background: 'rgba(15,20,25,0.9)',
            border: '1px solid #2a333d',
          }}
        >
          <span style={{ fontSize: 12, color: '#9aa7b5' }}>{activeVoice.title}</span>
          <button
            type="button"
            style={{
              padding: '4px 10px',
              borderRadius: 8,
              border: '1px solid #3f6cb0',
              background: '#2f5c9e',
              color: '#fff',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600,
            }}
            onClick={() =>
              void bridge.companionOpen({
                contactId: activeVoice.contactId!,
                conversationId: chat?.getState().conversationId ?? null,
                agentId: activeVoice.agentId,
                title: activeVoice.title,
                avatarUrl: activeVoice.avatarUrl,
              })
            }
          >
            Immersive view
          </button>
        </div>
      ) : null}
      <NexusChatApp
        chat={chat}
        client={client ?? undefined}
        features={{ adminPanels: false }}
        tools={registeredTools}
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
    </div>
  );
}
