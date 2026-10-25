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
  type CompanionTitleReport,
  type CompanionToolRoute,
  type CompanionToolSnapshot,
  type CompanionToolSync,
} from '../bridge.js';
import { companionToolLabel, isReportableCompanionLabel } from '../../shared/companion.js';

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

/**
 * The tool's display label (`Motion feed`, …).
 *
 * Delegates to the shared {@link companionToolLabel} table so this header and
 * main's OS window caption cannot drift; the local export stays for callers that
 * already import it.
 */
function toolTitle(tool: string): string {
  return companionToolLabel(tool);
}

/**
 * Body of a detached tool window. `route` is the parsed `#companion-tool?…`
 * hash; the component reads/writes the owning agent's status motions through the
 * companion-tool relay rather than a local session.
 */
export function CompanionToolView({ route }: { route: CompanionToolRoute }) {
  const { tool, contactId } = route;
  /**
   * The agent's human name for the header — never the raw `contactId` (that was
   * the bug: an id where a name belongs).
   *
   * The hash only carries what was known when this window opened, so the name is
   * kept in state: the owning companion pushes the label it resolved *after*
   * mount through the tool snapshot, and the header follows it. The neutral
   * literal is only the floor when nothing human-readable ever arrives.
   */
  const [liveAgentName, setLiveAgentName] = useState<string | null>(
    isReportableCompanionLabel(route.agentName) ? (route.agentName as string).trim() : null,
  );

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
      // A snapshot carries the owning companion's resolved agent name; adopt it so
      // a tool window opened before the name was known loses its bare label. The
      // floor literal (`Companion`) is not a name, so it is ignored here rather
      // than becoming `<Tool> · Companion`.
      const pushedName = isReportableCompanionLabel(snapshot.agentName)
        ? (snapshot.agentName as string).trim()
        : null;
      if (pushedName) setLiveAgentName((current) => current ?? pushedName);
    });
    return () => off();
  }, [contactId]);

  /**
   * Report this window's own caption to main so its OS title follows the resolved
   * agent (the create-time title is only a hint, frozen before the name arrived).
   * Addressed to *this* tool window by contact + tool, so main re-titles exactly
   * this caption and nothing else. A report with no usable name is dropped in main.
   */
  useEffect(() => {
    if (!liveAgentName) return;
    void callBridge<boolean>(bridge, 'companionSetTitle', false, {
      contactId,
      titles: [liveAgentName],
      tool,
    } satisfies CompanionTitleReport);
  }, [contactId, tool, liveAgentName]);

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
        {/* The agent suffix only appears once a real name is known: rendering the
            floor literal here (`· Companion`) was exactly the bug, so the header
            stays the bare tool label until the owning companion reports a name. */}
        {liveAgentName ? <span style={{ ...muted, fontSize: 11 }}>· {liveAgentName}</span> : null}
        <span style={{ flex: 1 }} />
      </div>
      <div style={body}>
        {!snapshotSeen && tool !== 'gestures' ? (
          <p style={muted}>
            {liveAgentName
              ? `Waiting for ${liveAgentName}’s companion to share its state…`
              : 'Waiting for the companion to share its state…'}
          </p>
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
