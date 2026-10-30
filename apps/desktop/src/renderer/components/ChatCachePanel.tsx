import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import {
  CHAT_CACHE_MAX_MIB_CHOICES,
  CHAT_CACHE_BYTES_PER_MIB,
  type ChatCacheStats,
} from '../bridge.js';
import {
  clearDesktopChatCache,
  readDesktopChatCacheStats,
  setDesktopChatCacheMaxBytes,
} from '../chat-cache-adapter.js';
import { useI18n } from '../i18n/index.js';
import { formatBytes } from './audit-format.js';

/**
 * Durable chat cache settings.
 *
 * The cache holds conversation-list metadata + short turn previews (never
 * message bodies), so a reload renders the list and thread tail instantly and
 * only the delta is refetched. Here the user sets the byte cap and can wipe the
 * cache; the store itself lives in the main process (LRU eviction by last use).
 */

const section: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: 18,
  borderRadius: 12,
  background: '#151b22',
  border: '1px solid #2a333d',
};

const field: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  fontSize: 12,
  color: '#9aa7b5',
};

const input: CSSProperties = {
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid #3a4654',
  background: '#0f1419',
  color: '#e8eef4',
  fontSize: 13,
};

const button: CSSProperties = {
  padding: '8px 14px',
  borderRadius: 8,
  border: '1px solid #3a4654',
  background: '#1c2430',
  color: '#e8eef4',
  cursor: 'pointer',
  fontSize: 13,
  alignSelf: 'flex-start',
};

export function ChatCachePanel() {
  const { t } = useI18n();
  const [stats, setStats] = useState<ChatCacheStats | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setStats(await readDesktopChatCacheStats());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const capMb = stats ? Math.round(stats.maxBytes / CHAT_CACHE_BYTES_PER_MIB) : 0;

  const patchCap = useCallback(async (megabytes: number) => {
    setBusy(true);
    try {
      // 0 = unbounded (no byte budget).
      const next = await setDesktopChatCacheMaxBytes(megabytes * CHAT_CACHE_BYTES_PER_MIB);
      if (next) setStats(next);
    } finally {
      setBusy(false);
    }
  }, []);

  const clearNow = useCallback(async () => {
    setBusy(true);
    try {
      await clearDesktopChatCache();
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  return (
    <section style={section}>
      <h2 style={{ margin: 0, fontSize: 16 }}>{t('settings.chatCache')}</h2>
      <p style={{ margin: 0, color: '#6b7784', fontSize: 12 }}>
        {t('settings.chatCache.help')}
      </p>

      {stats ? (
        <>
          <label style={field}>
            <span>{t('settings.chatCache.maxBytes')}</span>
            <select
              style={input}
              value={capMb}
              disabled={busy}
              onChange={(e) => void patchCap(Number(e.target.value))}
            >
              {CHAT_CACHE_MAX_MIB_CHOICES.map((choice) => (
                <option key={choice} value={choice}>
                  {choice === 0 ? t('settings.audit.unlimited') : `${choice} MiB`}
                </option>
              ))}
            </select>
          </label>

          <span style={{ color: '#6b7784', fontSize: 12 }}>
            {t('settings.chatCache.usage', {
              used: formatBytes(stats.bytes),
              entries: stats.entries,
            })}
            {stats.evictions > 0 ? ` · ${t('settings.chatCache.evicted', { count: stats.evictions })}` : ''}
          </span>

          <button type="button" style={button} disabled={busy} onClick={() => void clearNow()}>
            {t('settings.chatCache.clear')}
          </button>
        </>
      ) : (
        <p style={{ color: '#6b7784', fontSize: 12 }}>Loading…</p>
      )}
    </section>
  );
}
