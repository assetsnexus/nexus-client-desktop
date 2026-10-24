/**
 * Immersive companion window contract (Phase 7a).
 *
 * The "companion" is a second `BrowserWindow` that shows a single agent at full
 * bleed: 3D/VRM avatar + live voice, like a video call. The main window pops it
 * out; the companion window carries only the *address* of the conversation
 * (contact + optional conversation + agent identity), never a token — the
 * renderer resolves the live session through the same preload bridge.
 *
 * Everything here is pure (hash build/parse) so the launch contract is unit
 * tested without Electron.
 */

/**
 * Default size of the popped-out companion window.
 *
 * Deliberately *small* and album-like (a phone-shaped side companion), not a
 * full app instance — the main window still owns the full chat chrome. Users can
 * resize down to {@link COMPANION_MIN_SIZE}.
 */
export const COMPANION_DEFAULT_SIZE = { width: 560, height: 740 } as const;

/** Smallest sensible companion (keeps the avatar + expandable chat usable). */
export const COMPANION_MIN_SIZE = { width: 380, height: 480 } as const;

/** `#companion?...` hash segment identifying the companion route. */
export const COMPANION_HASH_PREFIX = 'companion';

/**
 * Companion presentation mode (Phase 11e):
 * - `fullscreen` — full-window 3D/VRM stage with the realtime voice session;
 * - `split` — the same session, chat beside the 3D stage.
 * Both share one realtime voice mode; only the layout differs.
 */
export type CompanionMode = 'fullscreen' | 'split';

export type CompanionLaunch = {
  contactId: string;
  conversationId?: string | null;
  /** Agent address, when known, so the companion can start a call without a lookup. */
  agentId?: string | null;
  virtualEmployeeId?: string | null;
  title?: string | null;
  avatarUrl?: string | null;
  /**
   * Room context, when the companion was popped out of a group/meeting room.
   *
   * A room holds several agents; passing the room id makes the companion render
   * the **shared** scene (`ClusterRoomViewer` with every agent occupant) instead
   * of a single flattened avatar stage, so all agents of the room appear in one
   * scene exactly as the main window's Scene tab shows them. Omitted for a 1:1
   * agent companion (the default single-avatar stage).
   */
  roomId?: string | null;
  /** Auto-start the live voice session on open (default true). */
  autoStart?: boolean;
  /** Stage layout; defaults to `fullscreen`. */
  mode?: CompanionMode;
  /**
   * Draw above other windows (an "always-on-top style" side companion). Default
   * `false` so the app never surprises the user; the companion header exposes a
   * pin toggle that flips this live.
   */
  alwaysOnTop?: boolean;
};

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * Serialize a launch into a `#companion?...` hash. Only present, non-empty
 * fields are written so the hash stays small and readable.
 */
export function buildCompanionHash(launch: CompanionLaunch): string {
  const params = new URLSearchParams();
  params.set('contactId', launch.contactId);
  const conversationId = clean(launch.conversationId);
  if (conversationId) params.set('conversationId', conversationId);
  const agentId = clean(launch.agentId);
  if (agentId) params.set('agentId', agentId);
  const virtualEmployeeId = clean(launch.virtualEmployeeId);
  if (virtualEmployeeId) params.set('virtualEmployeeId', virtualEmployeeId);
  const title = clean(launch.title);
  if (title) params.set('title', title);
  const avatarUrl = clean(launch.avatarUrl);
  if (avatarUrl) params.set('avatarUrl', avatarUrl);
  const roomId = clean(launch.roomId);
  if (roomId) params.set('roomId', roomId);
  if (launch.autoStart === false) params.set('autoStart', '0');
  if (launch.mode === 'split') params.set('mode', 'split');
  if (launch.alwaysOnTop === true) params.set('onTop', '1');
  return `#${COMPANION_HASH_PREFIX}?${params.toString()}`;
}

/**
 * Parse a `#companion?...` hash back into a launch. Returns `null` for any other
 * route (including the normal `#` app route) or a hash missing `contactId`.
 */
export function parseCompanionHash(hash: string): CompanionLaunch | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  const [route, query = ''] = raw.split('?');
  if (route !== COMPANION_HASH_PREFIX) return null;
  const params = new URLSearchParams(query);
  const contactId = clean(params.get('contactId'));
  if (!contactId) return null;
  return {
    contactId,
    conversationId: clean(params.get('conversationId')),
    agentId: clean(params.get('agentId')),
    virtualEmployeeId: clean(params.get('virtualEmployeeId')),
    title: clean(params.get('title')),
    avatarUrl: clean(params.get('avatarUrl')),
    roomId: clean(params.get('roomId')),
    autoStart: params.get('autoStart') !== '0',
    mode: params.get('mode') === 'split' ? 'split' : 'fullscreen',
    alwaysOnTop: params.get('onTop') === '1',
  };
}

/** Is this renderer URL/hash the companion route? */
export function isCompanionHash(hash: string): boolean {
  return parseCompanionHash(hash) != null;
}

/**
 * Live activation pushed into an *already open* companion window (main →
 * companion renderer). Sent over a channel rather than a reload, so a wake that
 * addresses an agent whose companion is already up does not tear down its live
 * voice session.
 *
 * Carries only routing addresses + a capture hint — never a token.
 */
export type CompanionPresent = {
  contactId: string;
  /** The conversation the wake resolved to, so the composer targets it. */
  conversationId: string | null;
  agentId: string | null;
  /** The wake phrase that addressed this agent, for a "heard 'X'" caption. */
  phrase: string | null;
  /**
   * True when this wake wants the companion to own dictation (the wake target
   * surface): it shows the live STT preview + composer and keeps voice mode as a
   * toggle. False leaves the companion's realtime call untouched.
   */
  dictate: boolean;
  /** Bumped once per wake, so the companion can reset per-activation state. */
  token: number;
};

/**
 * Single-owner STT primacy.
 *
 * Several companion windows can be open at once, but exactly **one** surface may
 * own speech-to-text at any moment: the microphone is a single shared resource,
 * and two windows capturing at the same time produce doubled/competing audio
 * rather than two working assistants. Main elects one *primary* surface and
 * pushes this contract to every companion whenever the election changes, so a
 * demoted window can relinquish the mic (end its realtime call, hide its live
 * dictation strip) instead of silently competing.
 *
 * The wake word is the main switcher: a wake addressed to agent B makes B's
 * companion primary and demotes whichever window held it before.
 */
export type CompanionSttOwner = {
  /** The companion this message is for (windows ignore someone else's). */
  contactId: string;
  /** True when THIS companion currently owns speech-to-text. */
  primary: boolean;
  /** Why the election changed, for the (brief) UI explanation. */
  reason: 'opened' | 'wake' | 'focus' | 'released' | 'closed';
  /** Bumped on every election change so a repeat wake still re-applies. */
  token: number;
};

/**
 * One election change to broadcast: the newly primary companion (if any) and
 * the window (if any) being demoted. Kept pure so the switching policy is
 * unit-testable without Electron.
 */
export type SttOwnerElection = {
  /** The companion that now owns STT, or `null` when nobody does. */
  primaryContactId: string | null;
  /** The window that lost STT, or `null` when none was primary. */
  previousContactId: string | null;
  /** Why the election changed. */
  reason: CompanionSttOwner['reason'];
};

/**
 * Decide the next STT owner. The microphone is a single shared resource, so at
 * most one companion may capture at a time; a new primary always displaces the
 * previous one. Passing `next: null` releases the mic entirely (last companion
 * closed / the user hung up).
 *
 * Returns `null` when nothing changed, so a redundant wake (same window already
 * primary) pushes no IPC and does not restart a live call.
 */
export function electSttOwner(input: {
  current: string | null;
  next: string | null;
  reason: CompanionSttOwner['reason'];
}): SttOwnerElection | null {
  const current = clean(input.current);
  const next = clean(input.next);
  if (current === next) return null;
  return {
    primaryContactId: next,
    previousContactId: current,
    reason: input.reason,
  };
}

/** Build the per-window ownership message from an election. */
export function sttOwnerMessage(
  contactId: string,
  election: SttOwnerElection,
  token: number,
): CompanionSttOwner {
  return {
    contactId,
    primary: election.primaryContactId === contactId,
    reason: election.reason,
    token,
  };
}

/** Wake dictation lifecycle, mirrored into the companion strip. */
export type CompanionSessionStatus =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'review'
  | 'submitted'
  | 'discarded'
  | 'queued'
  | 'error';

/**
 * Renderer-safe projection of the main renderer's wake dictation session, pushed
 * to the companion window so it can render the live STT preview + composer. The
 * session itself keeps running in the main renderer (which owns the shared mic
 * graph and the pre-roll), so both surfaces observe one capture, not two.
 */
export type CompanionSessionView = {
  contactId: string;
  status: CompanionSessionStatus;
  /** `buffer` + live `partial`, ready to display. */
  preview: string;
  /** Committed text only (what a manual edit replaces). */
  buffer: string;
  /** True when this turn's dictation streams audio to the cloud. */
  cloudTranscription: boolean;
  /** Accumulated audio-batch length, ms (for the "send as voice" action). */
  batchDurationMs: number;
  batchAvailable: boolean;
  sendingAudio: boolean;
  /** Non-fatal reason copy (mic unavailable, send failed, …). */
  message: string | null;
  /** Which engine feeds the preview ("On-device" / "Region inference"). */
  engineLabel: string | null;
  /** The agent name, for the strip's caption. */
  agentName: string | null;
};

/** A control the companion strip sends back to the main renderer's session. */
export type CompanionAction = {
  contactId: string;
  /** `edit` replaces the buffer; `submit`/`cancel`/`sendAudio` drive the session. */
  action: 'submit' | 'cancel' | 'sendAudio' | 'edit';
  /** New text, for `edit` only. */
  text?: string;
};
