import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  AUDIT_RETENTION_CHOICES,
  BYTES_PER_MIB,
  bridge,
  type AuditFilter,
  type AuditRetention,
  type AuditSnapshot,
  type ClientToolAuditEntry,
} from '../bridge.js';
import { useI18n } from '../i18n/index.js';
import { formatAuditTime, formatAuditValue, formatBytes } from './audit-format.js';

/**
 * Client-tool audit trail browser + retention settings.
 *
 * Lists every client tool an agent called on this machine, with the agent, the
 * conversation it came from, the (redacted) payload and the result, so a user can
 * trace a call back to its conversation. The store is read-only from here: this
 * panel can filter and adjust retention, but never delete entries. The retention
 * update is applied by the main process.
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

const row: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 0',
  borderTop: '1px solid #222b34',
};

const mono: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
  color: '#9aa7b5',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  margin: 0,
};

function RetentionSelect({
  label,
  value,
  choices,
  format,
  onChange,
}: {
  label: string;
  value: number;
  choices: readonly number[];
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <label style={field}>
      <span>{label}</span>
      <select style={input} value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {choices.map((choice) => (
          <option key={choice} value={choice}>
            {format(choice)}
          </option>
        ))}
      </select>
    </label>
  );
}

export function AuditPanel() {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<AuditSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<AuditFilter>({});
  const [expanded, setExpanded] = useState<string | null>(null);

  const refresh = useCallback(async (next: AuditFilter) => {
    setBusy(true);
    try {
      setSnapshot(await bridge.auditSnapshot(next));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh({});
  }, [refresh]);

  const applyFilter = useCallback(
    (patch: Partial<AuditFilter>) => {
      setFilter((prev) => {
        const next: AuditFilter = { ...prev, ...patch };
        void refresh(next);
        return next;
      });
    },
    [refresh],
  );

  const patchRetention = useCallback(
    async (patch: Partial<AuditRetention>) => {
      setBusy(true);
      try {
        // Main re-trims on the change; the returned snapshot reflects it.
        setSnapshot(await bridge.auditSetRetention(patch));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const retention = snapshot?.retention ?? null;
  const entries = snapshot?.entries ?? [];
  const facets = snapshot?.facets ?? { agents: [], conversations: [], tools: [] };

  const onOpenConversation = useCallback(async (entry: ClientToolAuditEntry) => {
    if (!entry.conversationId) return;
    applyFilter({ conversationId: entry.conversationId });
  }, [applyFilter]);

  const showing = useMemo(
    () => t('settings.audit.showing', { count: entries.length, total: snapshot?.total ?? 0 }),
    [entries.length, snapshot?.total, t],
  );

  return (
    <section style={section}>
      <h2 style={{ margin: 0, fontSize: 16 }}>{t('settings.audit')}</h2>
      <p style={{ margin: 0, color: '#6b7784', fontSize: 12 }}>{t('settings.audit.help')}</p>

      {retention ? (
        <>
          <h3 style={{ margin: 0, fontSize: 13, color: '#e8eef4' }}>{t('settings.audit.retention')}</h3>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <RetentionSelect
              label={t('settings.audit.maxEntries')}
              value={retention.maxEntries}
              choices={AUDIT_RETENTION_CHOICES.maxEntries}
              format={(v) => (v === 0 ? t('settings.audit.unlimited') : String(v))}
              onChange={(v) => void patchRetention({ maxEntries: v })}
            />
            <RetentionSelect
              label={t('settings.audit.maxAgeDays')}
              value={retention.maxAgeDays}
              choices={AUDIT_RETENTION_CHOICES.maxAgeDays}
              format={(v) => (v === 0 ? t('settings.audit.unlimited') : String(v))}
              onChange={(v) => void patchRetention({ maxAgeDays: v })}
            />
            <RetentionSelect
              label={t('settings.audit.maxBytes')}
              value={retention.maxBytes / BYTES_PER_MIB}
              choices={AUDIT_RETENTION_CHOICES.maxBytes}
              format={(v) => (v === 0 ? t('settings.audit.unlimited') : `${v} MiB`)}
              onChange={(v) => void patchRetention({ maxBytes: v * BYTES_PER_MIB })}
            />
          </div>
          {snapshot?.path ? (
            <p style={mono}>
              {t('settings.audit.storedAt')} {snapshot.path} · {formatBytes(snapshot.sizeBytes)}
            </p>
          ) : null}
        </>
      ) : (
        <p style={{ color: '#6b7784', fontSize: 12 }}>Loading…</p>
      )}

      <h3 style={{ margin: 0, fontSize: 13, color: '#e8eef4' }}>{t('settings.audit.title')}</h3>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <label style={{ ...field, flex: 1, minWidth: 140 }}>
          <span>{t('settings.audit.agent')}</span>
          <select
            style={input}
            value={filter.agentId ?? ''}
            onChange={(e) => applyFilter({ agentId: e.target.value || null })}
          >
            <option value="">{t('settings.audit.all')}</option>
            {facets.agents.map((f) => (
              <option key={f.id} value={f.id}>
                {f.id} ({f.count})
              </option>
            ))}
          </select>
        </label>
        <label style={{ ...field, flex: 1, minWidth: 140 }}>
          <span>{t('settings.audit.conversation')}</span>
          <select
            style={input}
            value={filter.conversationId ?? ''}
            onChange={(e) => applyFilter({ conversationId: e.target.value || null })}
          >
            <option value="">{t('settings.audit.all')}</option>
            {facets.conversations.map((f) => (
              <option key={f.id} value={f.id}>
                {f.id} ({f.count})
              </option>
            ))}
          </select>
        </label>
        <label style={{ ...field, flex: 1, minWidth: 140 }}>
          <span>{t('settings.audit.tool')}</span>
          <select
            style={input}
            value={filter.tool ?? ''}
            onChange={(e) => applyFilter({ tool: e.target.value || null })}
          >
            <option value="">{t('settings.audit.all')}</option>
            {facets.tools.map((f) => (
              <option key={f.id} value={f.id}>
                {f.id} ({f.count})
              </option>
            ))}
          </select>
        </label>
      </div>
      <input
        style={input}
        value={filter.query ?? ''}
        placeholder={t('settings.audit.search')}
        onChange={(e) => applyFilter({ query: e.target.value || null })}
      />

      <span style={{ color: '#6b7784', fontSize: 12 }}>
        {busy ? '…' : showing}
      </span>

      {entries.length === 0 ? (
        <p style={{ color: '#6b7784', fontSize: 12 }}>{t('settings.audit.empty')}</p>
      ) : (
        entries.map((entry) => (
          <div key={entry.id} style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={row}>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: entry.outcome === 'ok' ? '#4ade80' : '#f2a1a1',
                  border: `1px solid ${entry.outcome === 'ok' ? '#4ade80' : '#f2a1a1'}`,
                  borderRadius: 999,
                  padding: '2px 8px',
                  textTransform: 'uppercase',
                  letterSpacing: 0.4,
                }}
              >
                {entry.outcome === 'ok' ? t('settings.audit.outcomeOk') : t('settings.audit.outcomeError')}
              </span>
              <strong style={{ fontSize: 13 }}>{entry.tool}</strong>
              <span style={{ color: '#6b7784', fontSize: 12 }}>
                {entry.agentId ?? '—'}
              </span>
              <span style={{ color: '#6b7784', fontSize: 12 }}>{formatAuditTime(entry.at)}</span>
              <span style={{ flex: 1 }} />
              {entry.conversationId ? (
                <button
                  type="button"
                  style={{
                    padding: '4px 10px',
                    borderRadius: 8,
                    border: '1px solid #3a4654',
                    background: '#1c2430',
                    color: '#e8eef4',
                    cursor: 'pointer',
                    fontSize: 12,
                  }}
                  title={entry.conversationId}
                  onClick={() => void onOpenConversation(entry)}
                >
                  {t('settings.audit.openConversation')}
                </button>
              ) : null}
              <button
                type="button"
                style={{
                  padding: '4px 10px',
                  borderRadius: 8,
                  border: '1px solid #3a4654',
                  background: '#1c2430',
                  color: '#e8eef4',
                  cursor: 'pointer',
                  fontSize: 12,
                }}
                onClick={() => setExpanded((cur) => (cur === entry.id ? null : entry.id))}
              >
                {expanded === entry.id ? '−' : '+'}
              </button>
            </div>
            {expanded === entry.id ? (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  padding: '8px 0 12px',
                  borderTop: '1px solid #222b34',
                }}
              >
                {entry.conversationId ? (
                  <div>
                    <span style={{ ...field, fontSize: 11 }}>{t('settings.audit.conversation')}</span>
                    <p style={mono}>{entry.conversationId}</p>
                  </div>
                ) : null}
                <div>
                  <span style={{ ...field, fontSize: 11 }}>{t('settings.audit.args')}</span>
                  <p style={mono}>{formatAuditValue(entry.args)}</p>
                </div>
                {entry.outcome === 'ok' ? (
                  <div>
                    <span style={{ ...field, fontSize: 11 }}>{t('settings.audit.result')}</span>
                    <p style={mono}>{formatAuditValue(entry.result)}</p>
                  </div>
                ) : (
                  <div>
                    <span style={{ ...field, fontSize: 11 }}>{t('settings.audit.error')}</span>
                    <p style={{ ...mono, color: '#f2a1a1' }}>{entry.error ?? ''}</p>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        ))
      )}
    </section>
  );
}
