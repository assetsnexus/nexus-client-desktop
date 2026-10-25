/**
 * Standalone companion tool window (Deliverable 3).
 *
 * A companion's right-click menu tools ("Motion feed" / "Gesture tester" /
 * "Status motions") open as their own `BrowserWindow` instead of docking inside
 * the companion. Each window is scoped to **one** agent/contact: the hash
 * (`#companion-tool?tool=…&contactId=…`) names both, and main tags the tool-scope
 * relay with the contact so this window never renders another agent's config.
 *
 * The window holds **no** session of its own — it cannot open a 3D host, so the
 * panels are fed:
 *  - the status-motions map from the owning companion (`onCompanionToolSnapshot`);
 *  - the gesture catalogue / action feed stay empty (there is no live stage in a
 *    config window), so the gesture tester explains what it needs instead of
 *    silently doing nothing.
 *
 * TRUST: read-only debug/config surface. It never captures audio and never
 * submits a turn.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  GestureTestPanel,
  MotionFeedPanel,
  StatusMotionsConfig,
  parseStatusMotions,
  serializeStatusMotions,
  type StatusMotionMap,
} from '@nexus/character-react';
import '@nexus/character-ui-kit/style.css';
import {
  bridge,
  callBridge,
  onBridge,
  type CompanionToolRoute,
  type CompanionToolSnapshot,
  type CompanionToolSync,
} from '../bridge.js';

const shell: CSSProperties = {
  height: '100vh',
  display: 'flex',
  flexDirection: 'column',
  background: '#0b0f14',
  color: '#e8eef4',
  fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
};

const header: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 12px',
  borderBottom: '1px solid #1e2731',
  background: '#0f141a',
  flexShrink: 0,
};

const body: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: 12,
};

const muted: CSSProperties = { color: '#9aa7b5', fontSize: 12 };

const TOOL_TITLES: Record<string, string> = {
  'motion-feed': 'Motion feed',
  gestures: 'Gesture tester',
  'status-motions': 'Status motions',
};

function toolTitle(tool: string): string {
  return TOOL_TITLES[tool] ?? tool;
}

/**
 * Body of a detached tool window. `route` is the parsed `#companion-tool?…`
 * hash; the component reads/writes the owning agent's status motions through the
 * companion-tool relay rather than a local session.
 */
export function CompanionToolView({ route }: { route: CompanionToolRoute }) {
  const { tool, contactId } = route;
  const agentName = route.agentName ?? contactId;

  // Status motions start from the shared defaults and are replaced by the owning
  // companion's snapshot; an edit is relayed straight back so the companion (and
  // the agent's live loops) pick it up without a reload.
  const [statusMotions, setStatusMotions] = useState<StatusMotionMap>(() => parseStatusMotions(null));
  const [snapshotSeen, setSnapshotSeen] = useState(false);
  // Live stage mirrors pushed by the owning companion: loaded gesture ids and the
  // recent action-feed rows. Both stay empty until that companion publishes.
  const [gestures, setGestures] = useState<string[]>([]);
  const [feed, setFeed] = useState<unknown[]>([]);

  useEffect(() => {
    const off = onBridge<CompanionToolSnapshot>(bridge, 'onCompanionToolSnapshot', (snapshot) => {
      if (!snapshot || snapshot.contactId !== contactId) return;
      setSnapshotSeen(true);
      if (snapshot.statusMotions) setStatusMotions(parseStatusMotions(snapshot.statusMotions));
      setGestures(Array.isArray(snapshot.gestures) ? snapshot.gestures : []);
      setFeed(Array.isArray(snapshot.actionFeed) ? snapshot.actionFeed : []);
    });
    return () => off();
  }, [contactId]);

  const publishStatusMotions = useCallback(
    (next: StatusMotionMap) => {
      setStatusMotions(next);
      void callBridge<boolean>(bridge, 'companionToolSync', false, {
        contactId,
        statusMotions: serializeStatusMotions(next),
      } satisfies CompanionToolSync);
    },
    [contactId],
  );

  // Gesture-tester rows from the live catalogue ids. There is no 3D stage in a
  // config window, so durations are unknown and every clip shows as a one-shot.
  const catalog = useMemo(
    () =>
      gestures.map((id) => ({
        id,
        durationMs: null,
        loop: false,
        overlay: false,
      })),
    [gestures],
  );

  return (
    <div style={shell}>
      <div style={header}>
        <strong style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {toolTitle(tool)}
        </strong>
        <span style={{ ...muted, fontSize: 11 }}>· {agentName}</span>
        <span style={{ flex: 1 }} />
      </div>
      <div style={body}>
        {!snapshotSeen && tool !== 'gestures' ? (
          <p style={muted}>Waiting for {agentName}&rsquo;s companion to share its state…</p>
        ) : null}
        {tool === 'status-motions' ? (
          <StatusMotionsConfig motions={statusMotions} onChange={publishStatusMotions} />
        ) : null}
        {tool === 'motion-feed' ? (
          <MotionFeedPanel open events={feed as never} onClear={() => setFeed([])} onClose={() => undefined} />
        ) : null}
        {tool === 'gestures' ? (
          <GestureTestPanel
            open
            getCatalog={() => catalog}
            onPlay={() => undefined}
            onClose={() => undefined}
          />
        ) : null}
      </div>
    </div>
  );
}

/** Tool window title, e.g. `Motion feed · Ada` (also used by main for the OS title). */
export { toolTitle };
