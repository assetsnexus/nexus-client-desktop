import { useEffect, useMemo, useState } from 'react';
import {
  NexusChatApp,
  createNexusChat,
  createRegionCommandClient,
  type NexusChat,
  type SdkToHostMessage,
} from '@nexus/chat-react';
import '@nexus/chat-react/style.css';
import { bridge, type AuthState, type DesktopConnectionConfig } from '../bridge.js';

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
      <NexusChatApp
        chat={chat}
        client={client ?? undefined}
        features={{ adminPanels: false }}
        onPostToHost={(msg: SdkToHostMessage) => {
          // Renderer-side host messages (open external links, device register).
          const m = msg as unknown as { type?: string; url?: string };
          if (m.type === 'openExternal' && typeof m.url === 'string') {
            void bridge.openExternal(m.url);
          }
        }}
      />
    </div>
  );
}
